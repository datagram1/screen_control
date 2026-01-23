/**
 * HTTP Server Implementation
 *
 * Cross-platform REST API with all MCP tool endpoints.
 */

#include "http_server.h"
#include "../libs/httplib.h"
#include "../libs/json.hpp"
#include "../core/config.h"
#include "../core/logger.h"
#include "../tools/filesystem_tools.h"
#include "../tools/shell_tools.h"
#include "../tools/system_tools.h"
#include "../control_server/websocket_client.h"
#include "../control_server/command_dispatcher.h"
#include "../screen/screen_stream.h"
#include "platform.h"
#include <fstream>

using json = nlohmann::json;

namespace ScreenControl
{

HttpServer::HttpServer(int port) : m_port(port)
{
    m_server = std::make_unique<httplib::Server>();
    setupRoutes();
}

HttpServer::~HttpServer()
{
    stop();
}

void HttpServer::start()
{
    m_running = true;
    std::string host = Config::getInstance().getHttpHost();
    Logger::info("HTTP server starting on " + host + ":" + std::to_string(m_port));
    m_server->listen(host, m_port);
}

void HttpServer::stop()
{
    if (m_running)
    {
        m_running = false;
        m_server->stop();
        Logger::info("HTTP server stopped");
    }
}

void HttpServer::setGuiProxyCallback(GuiProxyCallback callback)
{
    m_guiProxyCallback = callback;
}

std::string HttpServer::proxyGuiRequest(const std::string& endpoint, const std::string& body)
{
    if (m_guiProxyCallback)
    {
        return m_guiProxyCallback(endpoint, body);
    }
    return json{{"success", false}, {"error", "GUI proxy not available - tray app not connected"}}.dump();
}

void HttpServer::setupRoutes()
{
    setupHealthRoutes();
    setupSettingsRoutes();
    setupGuiRoutes();
    setupFilesystemRoutes();
    setupShellRoutes();
    setupSystemRoutes();
    setupUnlockRoutes();
    setupCredentialProviderRoutes();
    setupControlServerRoutes();
    setupToolRoute();
    setupScreenStreamingRoutes();

    Logger::info("HTTP routes configured");
}

void HttpServer::setupHealthRoutes()
{
    // Health check
    m_server->Get("/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(R"({"status":"ok","service":"screencontrol"})", "application/json");
    });

    // Status endpoint
    m_server->Get("/status", [](const httplib::Request&, httplib::Response& res) {
        json response = {
            {"success", true},
            {"version", SERVICE_VERSION},
            {"platform", PLATFORM_ID},
            {"platformName", PLATFORM_NAME},
            {"licensed", Config::getInstance().isLicensed()},
            {"licenseStatus", Config::getInstance().getLicenseStatus()},
            {"machineId", Config::getInstance().getMachineId()},
            {"agentName", Config::getInstance().getAgentName()}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Fingerprint / Machine ID
    m_server->Get("/fingerprint", [](const httplib::Request&, httplib::Response& res) {
        json response = {
            {"success", true},
            {"machineId", Config::getInstance().getMachineId()}
        };
        res.set_content(response.dump(), "application/json");
    });
}

void HttpServer::setupSettingsRoutes()
{
    // Get settings
    m_server->Get("/settings", [](const httplib::Request&, httplib::Response& res) {
        auto& config = Config::getInstance();
        json response = {
            {"httpPort", config.getHttpPort()},
            {"guiBridgePort", config.getGuiBridgePort()},
            {"controlServerUrl", config.getControlServerUrl()},
            {"agentName", config.getAgentName()},
            {"autoStart", config.isAutoStartEnabled()},
            {"enableLogging", config.isLoggingEnabled()}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Update settings
    m_server->Post("/settings", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            auto& config = Config::getInstance();

            if (body.contains("controlServerUrl"))
                config.setControlServerUrl(body["controlServerUrl"]);
            if (body.contains("agentName"))
                config.setAgentName(body["agentName"]);
            if (body.contains("autoStart"))
                config.setAutoStart(body["autoStart"]);
            if (body.contains("enableLogging"))
                config.setLoggingEnabled(body["enableLogging"]);

            config.save();
            res.set_content(R"({"success":true})", "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });
}

void HttpServer::setupGuiRoutes()
{
    // GUI routes are proxied to the tray app (which has GUI access)
    // The service itself doesn't have GUI access when machine is locked

    // Screenshot
    m_server->Get("/screenshot", [this](const httplib::Request& req, httplib::Response& res) {
        json params;
        if (req.has_param("quality"))
            params["quality"] = std::stoi(req.get_param_value("quality"));
        if (req.has_param("format"))
            params["format"] = req.get_param_value("format");

        auto result = proxyGuiRequest("/screenshot", params.dump());
        res.set_content(result, "application/json");
    });

    // Screenshot with grid overlay (for visual coordinate-based clicking)
    m_server->Post("/screenshot_grid", [this](const httplib::Request& req, httplib::Response& res) {
#if PLATFORM_LINUX
        // Linux: Handle directly using shell commands
        try {
            json params = req.body.empty() ? json::object() : json::parse(req.body);
            int cols = params.value("columns", 20);
            int rows = params.value("rows", 15);

            std::string errorMsg;
            std::string imagePath = platform::gui::screenshotWithGrid(cols, rows, errorMsg);

            if (imagePath.empty()) {
                json response = {{"success", false}, {"error", errorMsg}};
                res.set_content(response.dump(), "application/json");
            } else {
                // Read image and return as base64
                std::ifstream file(imagePath, std::ios::binary);
                std::vector<char> buffer((std::istreambuf_iterator<char>(file)),
                                          std::istreambuf_iterator<char>());

                // Base64 encode
                static const char* b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                std::string encoded;
                int val = 0, valb = -6;
                for (unsigned char c : buffer) {
                    val = (val << 8) + c;
                    valb += 8;
                    while (valb >= 0) {
                        encoded.push_back(b64[(val >> valb) & 0x3F]);
                        valb -= 6;
                    }
                }
                if (valb > -6) encoded.push_back(b64[((val << 8) >> (valb + 8)) & 0x3F]);
                while (encoded.size() % 4) encoded.push_back('=');

                json response = {
                    {"success", true},
                    {"columns", cols},
                    {"rows", rows},
                    {"file_path", imagePath},
                    {"image", encoded},
                    {"format", "png"},
                    {"displayServer", platform::gui::getDisplayServer()},
                    {"usage", "Use click_grid with cell='E7' or column/row numbers to click"}
                };
                res.set_content(response.dump(), "application/json");
            }
        } catch (const std::exception& e) {
            json response = {{"success", false}, {"error", e.what()}};
            res.set_content(response.dump(), "application/json");
        }
#else
        // Windows/macOS: Proxy to GUI app
        auto result = proxyGuiRequest("/screenshot_grid", req.body);
        res.set_content(result, "application/json");
#endif
    });

    // Click using grid coordinates
    m_server->Post("/click_grid", [this](const httplib::Request& req, httplib::Response& res) {
#if PLATFORM_LINUX
        // Linux: Handle directly using shell commands
        try {
            json params = req.body.empty() ? json::object() : json::parse(req.body);
            std::string cell = params.value("cell", "");
            int col = params.value("column", 0);
            int row = params.value("row", 0);
            int cols = params.value("columns", 20);
            int rows = params.value("rows", 15);
            std::string button = params.value("button", "left");
            int offsetX = params.value("offset_x", 0);
            int offsetY = params.value("offset_y", 0);

            bool success = platform::gui::clickGrid(cell, col, row, cols, rows, button == "right", offsetX, offsetY);

            json response = {
                {"success", success},
                {"cell", cell.empty() ? std::string(1, 'A' + (col > 0 ? col-1 : 0)) + std::to_string(row > 0 ? row : 1) : cell},
                {"displayServer", platform::gui::getDisplayServer()}
            };
            res.set_content(response.dump(), "application/json");
        } catch (const std::exception& e) {
            json response = {{"success", false}, {"error", e.what()}};
            res.set_content(response.dump(), "application/json");
        }
#else
        // Windows/macOS: Proxy to GUI app
        auto result = proxyGuiRequest("/click_grid", req.body);
        res.set_content(result, "application/json");
#endif
    });

    // Click at coordinates relative to a window
    m_server->Post("/click_relative", [this](const httplib::Request& req, httplib::Response& res) {
#if PLATFORM_LINUX
        try {
            json params = req.body.empty() ? json::object() : json::parse(req.body);
            std::string identifier = params.value("identifier", "");
            int x = params.value("x", 0);
            int y = params.value("y", 0);
            std::string button = params.value("button", "left");
            bool focus = params.value("focus", true);

            bool success = platform::gui::clickRelative(identifier, x, y, button == "right", focus);

            json response = {
                {"success", success},
                {"identifier", identifier},
                {"x", x},
                {"y", y}
            };
            res.set_content(response.dump(), "application/json");
        } catch (const std::exception& e) {
            json response = {{"success", false}, {"error", e.what()}};
            res.set_content(response.dump(), "application/json");
        }
#else
        // Windows/macOS: Proxy to GUI app
        auto result = proxyGuiRequest("/click_relative", req.body);
        res.set_content(result, "application/json");
#endif
    });

    // Click
    m_server->Post("/click", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/click", req.body);
        res.set_content(result, "application/json");
    });

    // Double click
    m_server->Post("/double_click", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/double_click", req.body);
        res.set_content(result, "application/json");
    });

    // Mouse move
    m_server->Post("/mouse/move", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/mouse/move", req.body);
        res.set_content(result, "application/json");
    });

    // Mouse scroll
    m_server->Post("/mouse/scroll", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/mouse/scroll", req.body);
        res.set_content(result, "application/json");
    });

    // Mouse drag
    m_server->Post("/mouse/drag", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/mouse/drag", req.body);
        res.set_content(result, "application/json");
    });

    // Get mouse position
    m_server->Get("/mouse/position", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/mouse/position", "{}");
        res.set_content(result, "application/json");
    });

    // Keyboard type
    m_server->Post("/keyboard/type", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/keyboard/type", req.body);
        res.set_content(result, "application/json");
    });

    // Keyboard key press
    m_server->Post("/keyboard/key", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/keyboard/key", req.body);
        res.set_content(result, "application/json");
    });

    // UI elements
    m_server->Get("/ui/elements", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/ui/elements", "{}");
        res.set_content(result, "application/json");
    });

    // Window list
    m_server->Get("/ui/windows", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/ui/windows", "{}");
        res.set_content(result, "application/json");
    });

    // Focus window
    m_server->Post("/ui/focus", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/ui/focus", req.body);
        res.set_content(result, "application/json");
    });

    // Active window
    m_server->Get("/ui/active", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/ui/active", "{}");
        res.set_content(result, "application/json");
    });

    // OCR analysis
    m_server->Get("/ocr", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/ocr", "{}");
        res.set_content(result, "application/json");
    });

    // Application list
    m_server->Get("/applications", [this](const httplib::Request&, httplib::Response& res) {
        auto result = proxyGuiRequest("/applications", "{}");
        res.set_content(result, "application/json");
    });

    // Focus application
    m_server->Post("/application/focus", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/application/focus", req.body);
        res.set_content(result, "application/json");
    });

    // Launch application
    m_server->Post("/application/launch", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/application/launch", req.body);
        res.set_content(result, "application/json");
    });

    // Close application
    m_server->Post("/application/close", [this](const httplib::Request& req, httplib::Response& res) {
        auto result = proxyGuiRequest("/application/close", req.body);
        res.set_content(result, "application/json");
    });
}

void HttpServer::setupFilesystemRoutes()
{
    // Filesystem: list
    m_server->Post("/fs/list", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", ".");
            bool recursive = body.value("recursive", false);
            int maxDepth = body.value("maxDepth", 1);

            auto result = FilesystemTools::list(path, recursive, maxDepth);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: read
    m_server->Post("/fs/read", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", "");
            size_t maxBytes = body.value("maxBytes", 1048576); // 1MB default

            auto result = FilesystemTools::read(path, maxBytes);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: read range
    m_server->Post("/fs/read_range", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", "");
            // Support both camelCase and snake_case for compatibility
            int startLine = body.count("start_line") ? body["start_line"].get<int>() : body.value("startLine", 1);
            int endLine = body.count("end_line") ? body["end_line"].get<int>() : body.value("endLine", -1);

            auto result = FilesystemTools::readRange(path, startLine, endLine);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: write
    m_server->Post("/fs/write", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", "");
            std::string content = body.value("content", "");
            std::string mode = body.value("mode", "overwrite");
            bool createDirs = body.value("createDirs", false);

            auto result = FilesystemTools::write(path, content, mode, createDirs);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: delete
    m_server->Post("/fs/delete", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", "");
            bool recursive = body.value("recursive", false);

            auto result = FilesystemTools::remove(path, recursive);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: move
    m_server->Post("/fs/move", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string source = body.value("source", "");
            std::string destination = body.value("destination", "");

            auto result = FilesystemTools::move(source, destination);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: search (glob)
    m_server->Post("/fs/search", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string basePath = body.value("path", ".");
            std::string glob = body.value("glob", "*");
            int maxResults = body.value("maxResults", 100);

            auto result = FilesystemTools::search(basePath, glob, maxResults);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: grep
    m_server->Post("/fs/grep", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string basePath = body.value("path", ".");
            std::string pattern = body.value("pattern", "");
            std::string glob = body.value("glob", "*");
            int maxMatches = body.value("maxMatches", 100);

            auto result = FilesystemTools::grep(basePath, pattern, glob, maxMatches);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Filesystem: patch
    m_server->Post("/fs/patch", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string path = body.value("path", "");
            auto operations = body.value("operations", json::array());
            bool dryRun = body.value("dryRun", false);

            auto result = FilesystemTools::patch(path, operations, dryRun);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });
}

void HttpServer::setupShellRoutes()
{
    // Shell: exec
    m_server->Post("/shell/exec", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string command = body.value("command", "");
            std::string cwd = body.value("cwd", "");
            int timeout = body.value("timeout", 30);

            auto result = ShellTools::exec(command, cwd, timeout);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Shell: list sessions
    m_server->Get("/shell/session/list", [](const httplib::Request&, httplib::Response& res) {
        auto result = ShellTools::listSessions();
        res.set_content(result.dump(), "application/json");
    });

    // Shell: start session
    m_server->Post("/shell/session/start", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string command = body.value("command", "");
            std::string cwd = body.value("cwd", "");

            auto result = ShellTools::startSession(command, cwd);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Shell: send input
    m_server->Post("/shell/session/input", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            // Support both camelCase and snake_case for compatibility
            std::string sessionId = body.count("session_id") ? body["session_id"].get<std::string>() : body.value("sessionId", "");
            std::string input = body.value("input", "");

            auto result = ShellTools::sendInput(sessionId, input);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Shell: stop session
    m_server->Post("/shell/session/stop", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            // Support both camelCase and snake_case for compatibility
            std::string sessionId = body.count("session_id") ? body["session_id"].get<std::string>() : body.value("sessionId", "");
            std::string signal = body.value("signal", "TERM");

            auto result = ShellTools::stopSession(sessionId, signal);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Shell: read output
    m_server->Post("/shell/session/read", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            // Support both camelCase and snake_case for compatibility
            std::string sessionId = body.count("session_id") ? body["session_id"].get<std::string>() : body.value("sessionId", "");

            auto result = ShellTools::readOutput(sessionId);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });
}

void HttpServer::setupSystemRoutes()
{
    // System info
    m_server->Get("/system/info", [](const httplib::Request&, httplib::Response& res) {
        auto result = SystemTools::getSystemInfo();
        res.set_content(result.dump(), "application/json");
    });

    // Clipboard read
    m_server->Get("/clipboard/read", [](const httplib::Request&, httplib::Response& res) {
        auto result = SystemTools::clipboardRead();
        res.set_content(result.dump(), "application/json");
    });

    // Clipboard write
    m_server->Post("/clipboard/write", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string text = body.value("text", "");

            auto result = SystemTools::clipboardWrite(text);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Wait
    m_server->Post("/wait", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            int milliseconds = body.value("milliseconds", 0);

            auto result = SystemTools::wait(milliseconds);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

#if PLATFORM_LINUX
    // Get dependency status (Linux only)
    m_server->Get("/system/dependencies", [](const httplib::Request&, httplib::Response& res) {
        auto status = platform::deps::checkDependencies();

        json response = {
            {"success", true},
            {"displayServer", status.displayServer},
            {"packageManager", status.packageManager},
            {"dependencies", {
                {"screenshotTool", {
                    {"available", status.screenshotTool},
                    {"tool", status.screenshotToolName}
                }},
                {"inputTool", {
                    {"available", status.inputTool},
                    {"tool", status.inputToolName}
                }},
                {"imageMagick", {
                    {"available", status.imageMagick},
                    {"tool", "convert"}
                }}
            }},
            {"allAvailable", status.screenshotTool && status.inputTool && status.imageMagick},
            {"missingPackages", status.missingPackages},
            {"installCommand", status.installCommand}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Install missing dependencies (Linux only, requires root)
    m_server->Post("/system/dependencies/install", [](const httplib::Request& req, httplib::Response& res) {
        try {
            // Check if running as root
            if (!platform::isRunningAsRoot()) {
                json response = {
                    {"success", false},
                    {"error", "Root privileges required for dependency installation"},
                    {"hint", "Run the service as root or use: " + platform::deps::checkDependencies().installCommand}
                };
                res.set_content(response.dump(), "application/json");
                return;
            }

            bool success = platform::deps::installDependencies(false);

            if (success) {
                auto status = platform::deps::checkDependencies();
                json response = {
                    {"success", true},
                    {"message", "Dependencies installed successfully"},
                    {"dependencies", {
                        {"screenshotTool", status.screenshotTool},
                        {"inputTool", status.inputTool},
                        {"imageMagick", status.imageMagick}
                    }}
                };
                res.set_content(response.dump(), "application/json");
            } else {
                json response = {
                    {"success", false},
                    {"error", "Failed to install dependencies"},
                    {"hint", "Check logs for details or install manually"}
                };
                res.set_content(response.dump(), "application/json");
            }
        }
        catch (const std::exception& e) {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Get install script (for manual installation)
    m_server->Get("/system/dependencies/script", [](const httplib::Request&, httplib::Response& res) {
        std::string script = platform::deps::getInstallScript();
        res.set_content(script, "text/x-shellscript");
    });
#else
    // Non-Linux platforms - dependencies managed differently
    m_server->Get("/system/dependencies", [](const httplib::Request&, httplib::Response& res) {
        json response = {
            {"success", true},
            {"platform", PLATFORM_ID},
            {"message", "Dependency management not required on " PLATFORM_NAME}
        };
        res.set_content(response.dump(), "application/json");
    });

    m_server->Post("/system/dependencies/install", [](const httplib::Request&, httplib::Response& res) {
        json response = {
            {"success", false},
            {"error", "Dependency installation not available on " PLATFORM_NAME}
        };
        res.set_content(response.dump(), "application/json");
    });

    m_server->Get("/system/dependencies/script", [](const httplib::Request&, httplib::Response& res) {
        res.set_content("# No install script needed for " PLATFORM_NAME "\n", "text/x-shellscript");
    });
#endif
}

void HttpServer::setupUnlockRoutes()
{
    // Machine unlock - uses stored credentials (Fort Knox design)
    // NO credential retrieval endpoint - only unlock action

    // Check if machine is locked
    m_server->Get("/unlock/status", [](const httplib::Request&, httplib::Response& res) {
        bool hasCredentials = platform::unlock::hasStoredCredentials();
        bool isLocked = platform::unlock::isLocked();

        json response = {
            {"success", true},
            {"hasStoredCredentials", hasCredentials},
            {"isLocked", isLocked},
            {"platform", PLATFORM_ID}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Unlock machine using stored credentials
    m_server->Post("/unlock", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            // Check if credentials are stored
            if (!platform::unlock::hasStoredCredentials())
            {
                res.set_content(json{{"success", false}, {"error", "No stored credentials"}}.dump(), "application/json");
                return;
            }

            // Check if already unlocked
            if (!platform::unlock::isLocked())
            {
                res.set_content(json{{"success", true}, {"message", "Machine is already unlocked"}}.dump(), "application/json");
                return;
            }

#ifdef _WIN32
            // On Windows, use Credential Provider for proper lock screen unlock
            // Set the pending flag - the Credential Provider polls for this and auto-unlocks
            platform::unlock::setUnlockPending(true);
            Logger::info("Unlock pending flag set - credential provider will auto-unlock");
            res.set_content(json{{"success", true}, {"message", "Unlock initiated via Credential Provider"}}.dump(), "application/json");
#else
            // On other platforms, attempt direct unlock
            bool unlocked = platform::unlock::unlockWithStoredCredentials();

            if (unlocked)
            {
                Logger::info("Machine unlocked successfully");
                res.set_content(json{{"success", true}, {"message", "Machine unlocked"}}.dump(), "application/json");
            }
            else
            {
                Logger::warn("Failed to unlock machine");
                res.set_content(json{{"success", false}, {"error", "Unlock failed - check credentials"}}.dump(), "application/json");
            }
#endif
        }
        catch (const std::exception& e)
        {
            Logger::error("Unlock error: " + std::string(e.what()));
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Store unlock credentials (write-only - NO retrieval!)
    m_server->Post("/unlock/credentials", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string username = body.value("username", "");
            std::string password = body.value("password", "");

            if (username.empty() || password.empty())
            {
                res.set_content(json{{"success", false}, {"error", "Missing username or password"}}.dump(), "application/json");
                return;
            }

            // Store credentials securely (encrypted with split-key)
            bool stored = platform::unlock::storeUnlockCredentials(username, password);

            // Clear plaintext password from memory
            std::fill(password.begin(), password.end(), 0);

            if (stored)
            {
                Logger::info("Unlock credentials stored for user: " + username);
                res.set_content(json{{"success", true}, {"message", "Credentials stored securely"}}.dump(), "application/json");
            }
            else
            {
                Logger::error("Failed to store unlock credentials");
                res.set_content(json{{"success", false}, {"error", "Failed to store credentials"}}.dump(), "application/json");
            }
        }
        catch (const std::exception& e)
        {
            Logger::error("Credential storage error: " + std::string(e.what()));
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Clear stored credentials
    m_server->Delete("/unlock/credentials", [](const httplib::Request&, httplib::Response& res) {
        bool cleared = platform::unlock::clearStoredCredentials();

        if (cleared)
        {
            Logger::info("Unlock credentials cleared");
            res.set_content(json{{"success", true}, {"message", "Credentials cleared"}}.dump(), "application/json");
        }
        else
        {
            Logger::warn("Failed to clear credentials (may not have been stored)");
            res.set_content(json{{"success", true}, {"message", "Credentials cleared (or were not stored)"}}.dump(), "application/json");
        }
    });
}

void HttpServer::setupCredentialProviderRoutes()
{
    // These endpoints are used by the Windows Credential Provider DLL
    // to communicate with the service for automatic screen unlock.
    // They are localhost-only and should not be exposed externally.

#if PLATFORM_WINDOWS
    // Check if unlock command is pending
    // The credential provider polls this endpoint
    m_server->Get("/credential-provider/unlock", [](const httplib::Request& req, httplib::Response& res) {
        bool pending = platform::unlock::isUnlockPending();

        // Log when unlock is pending (to debug CP polling)
        if (pending) {
            Logger::info("CP polling /credential-provider/unlock - unlock_pending=true");
        }

        json response = {
            {"unlock_pending", pending}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Get credentials for the credential provider
    // SECURITY: This endpoint returns actual credentials - must only be accessible locally
    // The credential provider needs these to build the authentication package
    m_server->Get("/credential-provider/credentials", [](const httplib::Request&, httplib::Response& res) {
        std::string username, password, domain;

        if (platform::unlock::getCredentialsForProvider(username, password, domain))
        {
            json response = {
                {"success", true},
                {"username", username},
                {"password", password},
                {"domain", domain}
            };
            res.set_content(response.dump(), "application/json");

            // Clear sensitive data
            std::fill(password.begin(), password.end(), '\0');
        }
        else
        {
            json response = {
                {"success", false},
                {"error", "Failed to retrieve credentials"}
            };
            res.set_content(response.dump(), "application/json");
        }
    });

    // Report unlock result from credential provider
    m_server->Post("/credential-provider/result", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            bool success = body.value("success", false);
            std::string error = body.value("error", "");

            platform::unlock::reportUnlockResult(success, error);

            // Clear the pending flag
            platform::unlock::setUnlockPending(false);

            if (success)
            {
                Logger::info("Credential provider reported successful unlock");
            }
            else
            {
                Logger::warn("Credential provider reported unlock failure: " + error);
            }

            res.set_content(json{{"success", true}}.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Credential provider status (for diagnostics)
    m_server->Get("/credential-provider/status", [](const httplib::Request&, httplib::Response& res) {
        json response = {
            {"success", true},
            {"hasStoredCredentials", platform::unlock::hasStoredCredentials()},
            {"unlockPending", platform::unlock::isUnlockPending()},
            {"lastError", platform::unlock::getLastUnlockError()},
            {"platform", "windows"},
            {"credentialProviderEnabled", true}
        };
        res.set_content(response.dump(), "application/json");
    });

    Logger::info("Credential provider routes configured (Windows)");
#else
    // On non-Windows platforms, return not implemented
    m_server->Get("/credential-provider/unlock", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"unlock_pending", false}, {"error", "Credential provider not available on this platform"}}.dump(), "application/json");
    });

    m_server->Get("/credential-provider/credentials", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"success", false}, {"error", "Credential provider not available on this platform"}}.dump(), "application/json");
    });

    m_server->Post("/credential-provider/result", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"success", false}, {"error", "Credential provider not available on this platform"}}.dump(), "application/json");
    });

    m_server->Get("/credential-provider/status", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"success", true}, {"credentialProviderEnabled", false}, {"platform", PLATFORM_ID}}.dump(), "application/json");
    });
#endif
}

void HttpServer::setupControlServerRoutes()
{
    // Get control server connection status
    m_server->Get("/control-server/status", [](const httplib::Request&, httplib::Response& res) {
        auto& wsClient = WebSocketClient::getInstance();

        json response = {
            {"connected", wsClient.isConnected()},
            {"serverUrl", wsClient.getServerUrl()},
            {"agentId", wsClient.getAgentId()},
            {"licenseStatus", wsClient.getLicenseStatus()},
            {"permissions", {
                {"masterMode", wsClient.getMasterModeEnabled()},
                {"fileTransfer", wsClient.getFileTransferEnabled()},
                {"localSettingsLocked", wsClient.getLocalSettingsLocked()}
            }}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Connect to control server
    m_server->Post("/control-server/connect", [](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto& wsClient = WebSocketClient::getInstance();

            // If already connected, disconnect first
            if (wsClient.isConnected())
            {
                wsClient.disconnect();
            }

            // Parse config from request body
            ConnectionConfig config;
            if (!req.body.empty())
            {
                auto body = json::parse(req.body);
                if (body.contains("serverUrl"))
                    config.serverUrl = body["serverUrl"];
                if (body.contains("endpointUuid"))
                    config.endpointUuid = body["endpointUuid"];
                if (body.contains("customerId"))
                    config.customerId = body["customerId"];
                if (body.contains("agentName"))
                    config.agentName = body["agentName"];
            }

            // Use defaults from Config if not specified
            if (config.serverUrl.empty())
            {
                config.serverUrl = Config::getInstance().getControlServerUrl();
            }
            if (config.agentName.empty())
            {
                config.agentName = Config::getInstance().getAgentName();
            }

            bool success = wsClient.connect(config);

            json response = {
                {"success", success},
                {"connected", wsClient.isConnected()},
                {"agentId", wsClient.getAgentId()},
                {"licenseStatus", wsClient.getLicenseStatus()}
            };
            res.set_content(response.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Disconnect from control server
    m_server->Post("/control-server/disconnect", [](const httplib::Request&, httplib::Response& res) {
        auto& wsClient = WebSocketClient::getInstance();
        wsClient.disconnect();

        json response = {
            {"success", true},
            {"connected", false}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Reconnect to control server
    m_server->Post("/control-server/reconnect", [](const httplib::Request&, httplib::Response& res) {
        auto& wsClient = WebSocketClient::getInstance();
        bool success = wsClient.reconnect();

        json response = {
            {"success", success},
            {"connected", wsClient.isConnected()}
        };
        res.set_content(response.dump(), "application/json");
    });
}

void HttpServer::setupToolRoute()
{
    // Generic tool endpoint - routes to command dispatcher
    // This is used by the tray app to execute non-GUI tools through the service
    m_server->Post("/tool", [this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            auto body = json::parse(req.body);
            std::string method = body.value("method", "");
            json params = body.value("params", json::object());

            if (method.empty())
            {
                res.set_content(json{{"error", "Missing method"}}.dump(), "application/json");
                return;
            }

            // Use command dispatcher to route the request
            auto& dispatcher = CommandDispatcher::getInstance();
            auto result = dispatcher.dispatch(method, params);

            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& e)
        {
            res.set_content(json{{"error", e.what()}}.dump(), "application/json");
        }
    });
}

void HttpServer::setupScreenStreamingRoutes()
{
    // Check if screen streaming is available
    m_server->Get("/screen/available", [](const httplib::Request&, httplib::Response& res) {
        auto& stream = ScreenStream::getInstance();
        json response = {
            {"available", stream.isAvailable()},
            {"hasPermission", stream.hasPermission()}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Request screen capture permission
    m_server->Post("/screen/permission", [](const httplib::Request&, httplib::Response& res) {
        auto& stream = ScreenStream::getInstance();
        stream.requestPermission();
        json response = {
            {"success", true},
            {"hasPermission", stream.hasPermission()}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Get list of displays
    m_server->Get("/screen/displays", [](const httplib::Request&, httplib::Response& res) {
        auto& stream = ScreenStream::getInstance();
        auto displays = stream.getDisplays();

        json displayList = json::array();
        for (const auto& d : displays) {
            displayList.push_back({
                {"id", d.id},
                {"name", d.name},
                {"width", d.width},
                {"height", d.height},
                {"x", d.x},
                {"y", d.y},
                {"scale", d.scale},
                {"isPrimary", d.isPrimary},
                {"isBuiltin", d.isBuiltin}
            });
        }

        json response = {
            {"success", true},
            {"displays", displayList}
        };
        res.set_content(response.dump(), "application/json");
    });

    // Start screen streaming
    m_server->Post("/screen/stream/start", [](const httplib::Request& req, httplib::Response& res) {
        try {
            auto& stream = ScreenStream::getInstance();

            if (!stream.isAvailable()) {
                res.set_content(json{{"success", false}, {"error", "Screen streaming not available"}}.dump(), "application/json");
                return;
            }

            if (!stream.hasPermission()) {
                res.set_content(json{{"success", false}, {"error", "Screen capture permission not granted"}}.dump(), "application/json");
                return;
            }

            StreamConfig config;
            if (!req.body.empty()) {
                auto body = json::parse(req.body);
                config.maxFps = body.value("fps", 30);
                config.quality = body.value("quality", 80);
                config.useZstd = body.value("useZstd", true);
                config.useJpeg = body.value("useJpeg", true);
                config.captureCursor = body.value("captureCursor", true);
                config.displayId = body.value("displayId", 0);
            }

            // For HTTP polling, we'll store frames in a buffer
            // Real-time streaming would use WebSocket
            std::string streamId = stream.startStream(config, [](const EncodedFrameData& frame) {
                // Frame callback - would send via WebSocket
                // For now, frames are discarded (HTTP polling would use different approach)
                (void)frame;
            });

            if (streamId.empty()) {
                res.set_content(json{{"success", false}, {"error", "Failed to start stream"}}.dump(), "application/json");
                return;
            }

            json response = {
                {"success", true},
                {"streamId", streamId},
                {"config", {
                    {"fps", config.maxFps},
                    {"quality", config.quality},
                    {"useZstd", config.useZstd},
                    {"useJpeg", config.useJpeg}
                }}
            };
            res.set_content(response.dump(), "application/json");
        }
        catch (const std::exception& e) {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Stop screen streaming
    m_server->Post("/screen/stream/stop", [](const httplib::Request& req, httplib::Response& res) {
        try {
            auto& stream = ScreenStream::getInstance();
            std::string streamId;

            if (!req.body.empty()) {
                auto body = json::parse(req.body);
                streamId = body.value("streamId", "");
            }

            if (streamId.empty()) {
                stream.stopAllStreams();
            } else {
                stream.stopStream(streamId);
            }

            json response = {
                {"success", true},
                {"streamId", streamId}
            };
            res.set_content(response.dump(), "application/json");
        }
        catch (const std::exception& e) {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Get stream statistics
    m_server->Get("/screen/stream/stats", [](const httplib::Request& req, httplib::Response& res) {
        auto& stream = ScreenStream::getInstance();
        std::string streamId = req.get_param_value("streamId");

        ScreenStream::StreamStats stats;
        if (stream.getStreamStats(streamId, stats)) {
            json response = {
                {"success", true},
                {"streamId", streamId},
                {"stats", {
                    {"framesEncoded", stats.framesEncoded},
                    {"bytesEncoded", stats.bytesEncoded},
                    {"compressionRatio", stats.compressionRatio},
                    {"avgEncodeTimeUs", stats.avgEncodeTimeUs},
                    {"currentFps", stats.currentFps}
                }}
            };
            res.set_content(response.dump(), "application/json");
        } else {
            res.set_content(json{{"success", false}, {"error", "Stream not found"}}.dump(), "application/json");
        }
    });

    // Request full frame refresh
    m_server->Post("/screen/stream/refresh", [](const httplib::Request& req, httplib::Response& res) {
        try {
            auto& stream = ScreenStream::getInstance();
            auto body = json::parse(req.body);
            std::string streamId = body.value("streamId", "");

            stream.requestRefresh(streamId);

            json response = {{"success", true}};
            res.set_content(response.dump(), "application/json");
        }
        catch (const std::exception& e) {
            res.set_content(json{{"success", false}, {"error", e.what()}}.dump(), "application/json");
        }
    });

    // Take single screenshot using libscreencontrol
    m_server->Get("/screen/capture", [](const httplib::Request& req, httplib::Response& res) {
        auto& stream = ScreenStream::getInstance();

        if (!stream.isAvailable()) {
            res.set_content(json{{"success", false}, {"error", "Screen capture not available"}}.dump(), "application/json");
            return;
        }

        if (!stream.hasPermission()) {
            res.set_content(json{{"success", false}, {"error", "Permission not granted"}}.dump(), "application/json");
            return;
        }

        uint32_t displayId = 0;
        uint8_t quality = 80;
        if (req.has_param("displayId"))
            displayId = std::stoul(req.get_param_value("displayId"));
        if (req.has_param("quality"))
            quality = std::stoi(req.get_param_value("quality"));

        std::vector<uint8_t> imageData;
        if (stream.captureScreenshot(displayId, quality, imageData)) {
            // Return raw image data
            res.set_content(reinterpret_cast<const char*>(imageData.data()),
                           imageData.size(), "image/raw");
        } else {
            res.set_content(json{{"success", false}, {"error", "Capture failed"}}.dump(), "application/json");
        }
    });

    Logger::info("Screen streaming routes configured");
}

} // namespace ScreenControl
