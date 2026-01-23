/**
 * Linux Service Entry Point
 *
 * systemd service entry point for ScreenControl Service.
 * Runs as root to survive machine lock and handle unlock operations.
 */

#include "platform.h"
#include "../../core/config.h"
#include "../../core/logger.h"
#include "../../server/http_server.h"
#include "../../control_server/websocket_client.h"
#include "../../control_server/command_dispatcher.h"
#include "../../update/update_manager.h"
#include "../../libs/httplib.h"
#include <csignal>
#include <atomic>
#include <thread>
#include <chrono>
#include <sys/stat.h>

#if !PLATFORM_LINUX
#error "This file should only be compiled for Linux"
#endif

using namespace ScreenControl;

// Global state
static std::atomic<bool> g_running{true};
static std::unique_ptr<HttpServer> g_httpServer;
static ConnectionConfig g_wsConfig;

// Signal handler for graceful shutdown
static void signalHandler(int signal)
{
    Logger::info("Received signal " + std::to_string(signal) + ", shutting down...");
    g_running = false;

    // Disconnect WebSocket
    WebSocketClient::getInstance().disconnect();

    if (g_httpServer)
    {
        g_httpServer->stop();
    }
}

// Setup signal handlers
static void setupSignalHandlers()
{
    struct sigaction sa;
    sa.sa_handler = signalHandler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;

    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGHUP, &sa, nullptr);
}

// Check if running as root (required for systemd service)
static bool checkPrivileges()
{
    if (geteuid() != 0)
    {
        Logger::warn("Service is not running as root - some features will be limited");
        return false;
    }
    return true;
}

// Create required directories
static void createDirectories()
{
    // Create config directory
    std::string configDir = SERVICE_CONFIG_DIR;
    mkdir(configDir.c_str(), 0755);

    // Create log directory
    std::string logDir = SERVICE_LOG_DIR;
    mkdir(logDir.c_str(), 0755);
}

int main(int argc, char* argv[])
{
    // Parse command line arguments
    std::string configPath;
    bool verbose = false;

    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "-v" || arg == "--verbose")
        {
            verbose = true;
        }
        else if (arg == "-c" || arg == "--config")
        {
            if (i + 1 < argc)
            {
                configPath = argv[++i];
            }
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "ScreenControl Service for Linux\n"
                      << "Usage: " << argv[0] << " [options]\n"
                      << "Options:\n"
                      << "  -c, --config PATH   Config file path\n"
                      << "  -v, --verbose       Verbose logging\n"
                      << "  -h, --help          Show this help\n";
            return 0;
        }
    }

    // Create directories first
    createDirectories();

    // Initialize logger
    std::string logFile = std::string(SERVICE_LOG_DIR) + "/service.log";
    Logger::init(logFile, verbose);
    Logger::info("ScreenControl Service starting [Linux]");

    // Check privileges
    bool isRoot = checkPrivileges();
    Logger::info("Running as " + std::string(isRoot ? "root" : "user"));

    // Setup signal handlers
    setupSignalHandlers();

    // Load configuration
    auto& config = Config::getInstance();
    config.load(configPath);
    Logger::info("Configuration loaded");

    // Start HTTP server
    int httpPort = config.getHttpPort();
    g_httpServer = std::make_unique<HttpServer>(httpPort);

    // Setup GUI proxy callback - routes GUI operations through HTTP to tray app
    int guiBridgePort = config.getGuiBridgePort();
    g_httpServer->setGuiProxyCallback([guiBridgePort](const std::string& endpoint, const std::string& body) {
        // Forward to tray app's HTTP server
        httplib::Client cli("127.0.0.1", guiBridgePort);
        cli.set_connection_timeout(5);
        cli.set_read_timeout(30);

        auto res = cli.Post(endpoint.c_str(), body, "application/json");
        if (res && res->status == 200)
        {
            return res->body;
        }
        return std::string("{\"error\": \"Tray app unavailable\"}");
    });

    // Start server in background thread
    std::thread serverThread([&]() {
        try
        {
            g_httpServer->start();
        }
        catch (const std::exception& e)
        {
            Logger::error("HTTP server error: " + std::string(e.what()));
            g_running = false;
        }
    });

    Logger::info("HTTP server started on port " + std::to_string(httpPort));

    // Setup command dispatcher
    auto& dispatcher = CommandDispatcher::getInstance();

    // GUI proxy for dispatcher - forwards to tray app
    dispatcher.setGuiProxy([guiBridgePort](const std::string& method, const nlohmann::json& params) -> nlohmann::json {
        httplib::Client cli("127.0.0.1", guiBridgePort);
        cli.set_connection_timeout(5);
        cli.set_read_timeout(30);

        nlohmann::json request;
        request["method"] = method;
        request["params"] = params;

        auto res = cli.Post("/tool", request.dump(), "application/json");
        if (res && res->status == 200)
        {
            try
            {
                return nlohmann::json::parse(res->body);
            }
            catch (...)
            {
                return {{"error", "Invalid response from tray app"}};
            }
        }
        return {{"error", "Tray app unavailable"}};
    });

    // Setup WebSocket client
    auto& wsClient = WebSocketClient::getInstance();

    // Log callback
    wsClient.setLogCallback([](const std::string& message) {
        Logger::info(message);
    });

    // Connection callback
    wsClient.setConnectionCallback([](bool connected) {
        if (connected)
        {
            Logger::info("Connected to control server");
        }
        else
        {
            Logger::warn("Disconnected from control server");
        }
    });

    // Status callback
    wsClient.setStatusCallback([](const std::string& agentId, const std::string& licenseStatus) {
        Logger::info("Agent ID: " + agentId + ", License: " + licenseStatus);
    });

    // Command callback - routes to dispatcher
    wsClient.setCommandCallback([&dispatcher](const std::string& method, const nlohmann::json& params) {
        return dispatcher.dispatch(method, params);
    });

    // Configure auto-update system
    auto& updateManager = UpdateManager::getInstance();
    UpdateConfig updateConfig;
    updateConfig.serverUrl = "https://screencontrol.knws.co.uk";
    updateConfig.currentVersion = SERVICE_VERSION;  // Defined in CMakeLists.txt
    updateConfig.platform = "linux";
#if defined(__aarch64__) || defined(__arm64__)
    updateConfig.arch = "arm64";
#else
    updateConfig.arch = "x64";
#endif
    updateConfig.machineId = Config::getInstance().getMachineId();
    updateConfig.autoDownload = true;
    updateConfig.autoInstall = true;  // Auto-install updates
    updateConfig.checkIntervalHeartbeats = 60;  // Check every ~5 minutes (60 * 5s heartbeats)

    updateManager.configure(updateConfig);

    updateManager.setStatusCallback([](UpdateStatus status, const std::string& message) {
        std::string statusStr;
        switch (status) {
            case UpdateStatus::CHECKING: statusStr = "CHECKING"; break;
            case UpdateStatus::AVAILABLE: statusStr = "AVAILABLE"; break;
            case UpdateStatus::DOWNLOADING: statusStr = "DOWNLOADING"; break;
            case UpdateStatus::DOWNLOADED: statusStr = "DOWNLOADED"; break;
            case UpdateStatus::INSTALLING: statusStr = "INSTALLING"; break;
            case UpdateStatus::FAILED: statusStr = "FAILED"; break;
            case UpdateStatus::UP_TO_DATE: statusStr = "UP_TO_DATE"; break;
            default: statusStr = "IDLE"; break;
        }
        Logger::info("[Update] Status: " + statusStr + " - " + message);
    });

    updateManager.setProgressCallback([](uint64_t downloaded, uint64_t total) {
        if (total > 0) {
            int percent = static_cast<int>((downloaded * 100) / total);
            Logger::info("[Update] Download progress: " + std::to_string(percent) + "%");
        }
    });

    // Wire up heartbeat callback to check for updates
    wsClient.setHeartbeatCallback([&updateManager](int updateFlag) {
        updateManager.onHeartbeat(updateFlag);
    });

    Logger::info("Auto-update system configured (version " + std::string(SERVICE_VERSION) + ")");

    // Load WebSocket config
    std::string wsConfigPath = std::string(SERVICE_CONFIG_DIR) + "/connection.json";
    if (g_wsConfig.load(wsConfigPath))
    {
        Logger::info("WebSocket config loaded from " + wsConfigPath);
    }
    else
    {
        // Try main config for URL
        g_wsConfig.serverUrl = config.getControlServerUrl();
        Logger::info("Using control server URL from main config: " + g_wsConfig.serverUrl);
    }

    // Connect to control server if configured
    bool wsConnected = false;
    if (!g_wsConfig.serverUrl.empty() && g_wsConfig.connectOnStartup)
    {
        Logger::info("Connecting to control server: " + g_wsConfig.serverUrl);
        wsConnected = wsClient.connect(g_wsConfig);
    }
    else
    {
        Logger::info("Control server connection disabled or not configured");
    }

    // Main loop - keep service running
    Logger::info("Service is ready");
    int reconnectAttempts = 0;
    const int maxReconnectDelay = 60;  // Max 60 seconds between reconnects

    while (g_running)
    {
        std::this_thread::sleep_for(std::chrono::seconds(1));

        // Reconnection logic for WebSocket
        if (!g_wsConfig.serverUrl.empty() && g_wsConfig.connectOnStartup)
        {
            if (!wsClient.isConnected())
            {
                // Calculate backoff delay
                int delay = std::min(5 * (1 << reconnectAttempts), maxReconnectDelay);
                reconnectAttempts++;

                Logger::info("Reconnecting to control server in " + std::to_string(delay) + " seconds...");
                std::this_thread::sleep_for(std::chrono::seconds(delay));

                if (g_running && wsClient.reconnect())
                {
                    reconnectAttempts = 0;  // Reset on successful connect
                }
            }
            else
            {
                reconnectAttempts = 0;  // Reset when connected
            }
        }
    }

    // Cleanup
    Logger::info("Shutting down service...");

    if (g_httpServer)
    {
        g_httpServer->stop();
    }

    if (serverThread.joinable())
    {
        serverThread.join();
    }

    Logger::info("Service stopped");
    Logger::shutdown();

    return 0;
}
