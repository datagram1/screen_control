/**
 * Command Dispatcher Implementation
 *
 * Routes commands to appropriate tool handlers.
 * GUI operations are proxied to the tray app, while
 * system operations are handled directly by the service.
 */

#include "command_dispatcher.h"
#include "platform.h"
#include "../core/logger.h"
#include "../tools/filesystem_tools.h"
#include "../tools/shell_tools.h"
#include "../tools/system_tools.h"
#include "../libs/httplib.h"
#include <thread>
#include <chrono>

#if PLATFORM_MACOS || PLATFORM_LINUX
#include <unistd.h>
#endif

using json = nlohmann::json;

namespace ScreenControl
{

// Methods that require GUI proxy (must be forwarded to tray app)
const std::vector<std::string> CommandDispatcher::GUI_METHODS = {
    "screenshot",
    "screenshot_app",
    "screenshot_grid",
    "desktop_screenshot",
    "click",
    "click_absolute",
    "click_relative",
    "click_grid",
    "mouse_click",
    "doubleClick",
    "clickElement",
    "moveMouse",
    "mouse_move",
    "scroll",
    "scrollMouse",
    "mouse_scroll",
    "drag",
    "mouse_drag",
    "typeText",
    "keyboard_type",
    "pressKey",
    "keyboard_press",
    "keyboard_shortcut",
    "getClickableElements",
    "getUIElements",
    "getMousePosition",
    "analyzeWithOCR",
    "listApplications",
    "focusApplication",
    "launchApplication",
    "app_launch",
    "closeApp",
    "app_quit",
    "window_list",
    "window_focus",
    "window_move",
    "window_resize",
    "checkPermissions",
    "wait",
    // Browser methods (proxied to GUI app which handles browser bridge)
    "browser_listConnected",
    "browser_setDefaultBrowser",
    "browser_getTabs",
    "browser_getActiveTab",
    "browser_focusTab",
    "browser_createTab",
    "browser_closeTab",
    "browser_getPageInfo",
    "browser_inspectCurrentPage",
    "browser_getInteractiveElements",
    "browser_getPageContext",
    "browser_clickElement",
    "browser_fillElement",
    "browser_fillFormField",
    "browser_fillWithFallback",
    "browser_fillFormNative",
    "browser_scrollTo",
    "browser_executeScript",
    "browser_getFormData",
    "browser_setWatchMode",
    "browser_getVisibleText",
    "browser_searchVisibleText",
    "browser_getUIElements",
    "browser_waitForSelector",
    "browser_waitForPageLoad",
    "browser_selectOption",
    "browser_isElementVisible",
    "browser_getConsoleLogs",
    "browser_getNetworkRequests",
    "browser_getLocalStorage",
    "browser_getCookies",
    "browser_clickByText",
    "browser_clickMultiple",
    "browser_getFormStructure",
    "browser_answerQuestions",
    "browser_getDropdownOptions",
    "browser_openDropdownNative",
    "browser_listInteractiveElements",
    "browser_clickElementWithDebug",
    "browser_findElementWithDebug",
    "browser_findTabByUrl",
    "browser_navigate",
    "browser_screenshot",
    "browser_go_back",
    "browser_go_forward",
    "browser_get_visible_html",
    "browser_hover",
    "browser_drag",
    "browser_press_key",
    "browser_upload_file",
    "browser_save_as_pdf"
};

CommandDispatcher::CommandDispatcher()
{
}

CommandDispatcher& CommandDispatcher::getInstance()
{
    static CommandDispatcher instance;
    return instance;
}

json CommandDispatcher::dispatch(const std::string& method, const json& params)
{
    Logger::info("Dispatching command: " + method);

    try
    {
        // Check if this is a GUI method that needs proxy
        for (const auto& guiMethod : GUI_METHODS)
        {
            if (method == guiMethod)
            {
                if (m_guiProxy)
                {
                    return m_guiProxy(method, params);
                }
                else
                {
                    Logger::warn("GUI proxy not available for: " + method);
                    return errorResponse("GUI operations unavailable - tray app not connected");
                }
            }
        }

        // Filesystem operations
        if (method == "fs_list" || method == "listDirectory")
        {
            return handleFilesystemTool("list", params);
        }
        else if (method == "fs_read" || method == "readFile")
        {
            return handleFilesystemTool("read", params);
        }
        else if (method == "fs_read_range")
        {
            return handleFilesystemTool("read_range", params);
        }
        else if (method == "fs_write" || method == "writeFile")
        {
            return handleFilesystemTool("write", params);
        }
        else if (method == "fs_delete" || method == "deleteFile")
        {
            return handleFilesystemTool("delete", params);
        }
        else if (method == "fs_move" || method == "moveFile")
        {
            return handleFilesystemTool("move", params);
        }
        else if (method == "fs_search")
        {
            return handleFilesystemTool("search", params);
        }
        else if (method == "fs_grep")
        {
            return handleFilesystemTool("grep", params);
        }
        else if (method == "fs_patch")
        {
            return handleFilesystemTool("patch", params);
        }

        // Shell operations
        else if (method == "shell_exec" || method == "executeCommand")
        {
            return handleShellTool("exec", params);
        }
        else if (method == "shell_start_session")
        {
            return handleShellTool("start_session", params);
        }
        else if (method == "shell_send_input")
        {
            return handleShellTool("send_input", params);
        }
        else if (method == "shell_stop_session")
        {
            return handleShellTool("stop_session", params);
        }
        else if (method == "shell_read_output")
        {
            return handleShellTool("read_output", params);
        }

        // Terminal operations (aliases for shell tools, used by web terminal)
        else if (method == "terminal_start")
        {
            // Start a shell session for terminal use
            json shellParams = {
                {"command", params.value("shell", "/bin/bash")},
                {"cwd", params.value("cwd", "")}
            };
            json result = handleShellTool("start_session", shellParams);
            // Map shell response to terminal response
            if (result.value("success", false)) {
                return {
                    {"success", true},
                    {"sessionId", result.value("session_id", "")},
                    {"pid", result.value("pid", 0)}
                };
            }
            return result;
        }
        else if (method == "terminal_input")
        {
            // Send input to terminal session
            std::string sessionId = params.value("sessionId", "");
            std::string data = params.value("data", "");
            json shellParams = {
                {"session_id", sessionId},
                {"input", data}
            };
            return handleShellTool("send_input", shellParams);
        }
        else if (method == "terminal_output")
        {
            // Read output from terminal session
            std::string sessionId = params.value("sessionId", "");
            json shellParams = {{"session_id", sessionId}};
            json result = handleShellTool("read_output", shellParams);
            // Map shell response to terminal response
            if (result.value("success", false)) {
                std::string output = result.value("stdout", "");
                std::string error = result.value("stderr", "");
                return {
                    {"success", true},
                    {"sessionId", sessionId},
                    {"data", output + error}
                };
            }
            return result;
        }
        else if (method == "terminal_stop")
        {
            // Stop terminal session
            std::string sessionId = params.value("sessionId", "");
            json shellParams = {{"session_id", sessionId}};
            return handleShellTool("stop_session", shellParams);
        }
        else if (method == "terminal_resize")
        {
            // Resize terminal (not fully implemented in shell tools, return success)
            return {{"success", true}};
        }

        // System operations
        else if (method == "system_info")
        {
            return handleSystemTool("info", params);
        }
        else if (method == "clipboard_read")
        {
            return handleSystemTool("clipboard_read", params);
        }
        else if (method == "clipboard_write")
        {
            return handleSystemTool("clipboard_write", params);
        }

        // Machine control (service handles directly - critical for locked state)
        else if (method == "machine_unlock" || method == "unlockMachine")
        {
            return handleMachineUnlock(params);
        }
        else if (method == "machine_lock" || method == "lockMachine")
        {
            return handleMachineLock();
        }
        else if (method == "machine_info" || method == "getMachineInfo")
        {
            return handleMachineInfo();
        }

        // Wait/delay
        else if (method == "wait")
        {
            int ms = params.value("milliseconds", 0);
            if (ms > 0)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(ms));
            }
            return {{"success", true}, {"waited_ms", ms}};
        }

        // Tools discovery (MCP protocol)
        else if (method == "tools/list")
        {
            return handleToolsList();
        }

        // MCP tools/call - extract tool name and dispatch
        else if (method == "tools/call")
        {
            std::string toolName = params.value("name", "");
            json arguments = params.value("arguments", json::object());
            if (toolName.empty())
            {
                return errorResponse("Missing 'name' in tools/call params");
            }
            Logger::info("tools/call dispatching to: " + toolName);
            // Recursively dispatch to the actual tool handler
            return dispatch(toolName, arguments);
        }

        // Health check
        else if (method == "health" || method == "ping")
        {
            return {{"status", "ok"}, {"service", true}};
        }

        // Unknown method
        else
        {
            Logger::warn("Unknown method: " + method);
            return errorResponse("Unknown method: " + method);
        }
    }
    catch (const std::exception& e)
    {
        Logger::error("Command dispatch error: " + std::string(e.what()));
        return errorResponse(e.what());
    }
}

json CommandDispatcher::handleFilesystemTool(const std::string& method, const json& params)
{
    std::string path = params.value("path", "");

    if (method == "list")
    {
        bool recursive = params.value("recursive", false);
        int maxDepth = params.value("max_depth", 1);
        return FilesystemTools::list(path, recursive, maxDepth);
    }
    else if (method == "read")
    {
        size_t maxBytes = params.value("max_bytes", 1048576);
        return FilesystemTools::read(path, maxBytes);
    }
    else if (method == "read_range")
    {
        int startLine = params.value("start_line", 1);
        int endLine = params.value("end_line", -1);
        return FilesystemTools::readRange(path, startLine, endLine);
    }
    else if (method == "write")
    {
        std::string content = params.value("content", "");
        std::string mode = params.value("mode", "overwrite");
        bool createDirs = params.value("create_directories", false);
        return FilesystemTools::write(path, content, mode, createDirs);
    }
    else if (method == "delete")
    {
        bool recursive = params.value("recursive", false);
        return FilesystemTools::remove(path, recursive);
    }
    else if (method == "move")
    {
        std::string source = params.value("source", "");
        std::string destination = params.value("destination", "");
        return FilesystemTools::move(source, destination);
    }
    else if (method == "search")
    {
        std::string pattern = params.value("pattern", "*");
        int maxResults = params.value("max_results", 100);
        return FilesystemTools::search(path, pattern, maxResults);
    }
    else if (method == "grep")
    {
        std::string pattern = params.value("pattern", "");
        std::string glob = params.value("glob", "*");
        int maxMatches = params.value("max_matches", 100);
        return FilesystemTools::grep(path, pattern, glob, maxMatches);
    }
    else if (method == "patch")
    {
        json operations = params.value("operations", json::array());
        bool dryRun = params.value("dry_run", false);
        return FilesystemTools::patch(path, operations, dryRun);
    }

    return errorResponse("Unknown filesystem method");
}

json CommandDispatcher::handleShellTool(const std::string& method, const json& params)
{
    if (method == "exec")
    {
        std::string command = params.value("command", "");
        std::string cwd = params.value("cwd", "");
        int timeout = params.value("timeout_seconds", 30);
        return ShellTools::exec(command, cwd, timeout);
    }
    else if (method == "start_session")
    {
        std::string command = params.value("command", "");
        std::string cwd = params.value("cwd", "");
        return ShellTools::startSession(command, cwd);
    }
    else if (method == "send_input")
    {
        std::string sessionId = params.value("session_id", "");
        std::string input = params.value("input", "");
        return ShellTools::sendInput(sessionId, input);
    }
    else if (method == "stop_session")
    {
        std::string sessionId = params.value("session_id", "");
        std::string signal = params.value("signal", "TERM");
        return ShellTools::stopSession(sessionId, signal);
    }
    else if (method == "read_output")
    {
        std::string sessionId = params.value("session_id", "");
        return ShellTools::readOutput(sessionId);
    }

    return errorResponse("Unknown shell method");
}

json CommandDispatcher::handleSystemTool(const std::string& method, const json& params)
{
    if (method == "info")
    {
        return SystemTools::getSystemInfo();
    }
    else if (method == "clipboard_read")
    {
        return SystemTools::clipboardRead();
    }
    else if (method == "clipboard_write")
    {
        std::string text = params.value("text", "");
        return SystemTools::clipboardWrite(text);
    }

    return errorResponse("Unknown system method");
}

json CommandDispatcher::handleMachineUnlock(const json& params)
{
    // Machine unlock is handled directly by the service (runs as root)
    // This is critical functionality that works even when machine is locked

    std::string password = params.value("password", "");
    std::string username = params.value("username", "");

    if (password.empty())
    {
        return errorResponse("Password is required for unlock");
    }

    Logger::info("Attempting machine unlock...");

#if PLATFORM_MACOS
    // macOS: Use System Events to unlock
    // This requires running as root (LaunchDaemon)

    if (username.empty())
    {
        // Get current console user
        FILE* fp = popen("stat -f '%Su' /dev/console", "r");
        if (fp)
        {
            char buf[128];
            if (fgets(buf, sizeof(buf), fp))
            {
                username = buf;
                while (!username.empty() && (username.back() == '\n' || username.back() == '\r'))
                {
                    username.pop_back();
                }
            }
            pclose(fp);
        }
    }

    if (username.empty())
    {
        return errorResponse("Could not determine username");
    }

    // First, wake the display
    system("caffeinate -u -t 1");

    // Small delay for display to wake
    usleep(500000);

    // Use osascript with System Events to unlock
    // This requires accessibility permissions
    std::string unlockCmd = "osascript -e 'tell application \"System Events\" to keystroke \"" +
                            password + "\"' -e 'tell application \"System Events\" to keystroke return'";

    int result = system(unlockCmd.c_str());

    if (result == 0)
    {
        Logger::info("Machine unlock command sent");
        return {{"success", true}, {"message", "Unlock command sent"}};
    }
    else
    {
        Logger::error("Machine unlock failed with code: " + std::to_string(result));
        return errorResponse("Unlock command failed");
    }

#elif PLATFORM_WINDOWS
    // Windows: Use Credential Provider for unlock
    // Check if we have stored credentials
    if (!platform::unlock::hasStoredCredentials())
    {
        Logger::warn("No stored credentials for Windows unlock");
        return errorResponse("No stored credentials - please store credentials first");
    }

    // Check if machine is actually locked
    if (!platform::unlock::isLocked())
    {
        Logger::info("Machine is already unlocked");
        return {{"success", true}, {"message", "Machine is already unlocked"}};
    }

    // Set unlock pending flag - the Credential Provider will pick this up
    platform::unlock::setUnlockPending(true);
    Logger::info("Unlock pending flag set - waiting for Credential Provider");

    // The Credential Provider polls for the unlock pending flag and will
    // automatically submit credentials to Windows when it sees the flag.
    // We return immediately - the actual unlock happens asynchronously.
    return {{"success", true}, {"message", "Unlock initiated via Credential Provider"}};

#elif PLATFORM_LINUX
    // Linux: Various methods depending on display manager
    return errorResponse("Linux unlock not yet implemented");

#else
    return errorResponse("Unlock not supported on this platform");
#endif
}

json CommandDispatcher::handleMachineLock()
{
    Logger::info("Locking machine...");

#if PLATFORM_MACOS
    // macOS: Use CGSession to lock
    int result = system("/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend");
    if (result == 0)
    {
        return {{"success", true}, {"message", "Machine locked"}};
    }
    return errorResponse("Failed to lock machine");

#elif PLATFORM_WINDOWS
    // Windows: Use LockWorkStation
    int result = system("rundll32.exe user32.dll,LockWorkStation");
    if (result == 0)
    {
        return {{"success", true}, {"message", "Machine locked"}};
    }
    return errorResponse("Failed to lock machine");

#elif PLATFORM_LINUX
    // Linux: Try common methods
    int result = system("loginctl lock-session 2>/dev/null || xdg-screensaver lock 2>/dev/null || gnome-screensaver-command -l 2>/dev/null");
    if (result == 0)
    {
        return {{"success", true}, {"message", "Machine locked"}};
    }
    return errorResponse("Failed to lock machine");

#else
    return errorResponse("Lock not supported on this platform");
#endif
}

json CommandDispatcher::handleMachineInfo()
{
    // Get base system info
    json info = SystemTools::getSystemInfo();

    // Add screen lock status
#if PLATFORM_MACOS
    // Check if screen is locked using CGSession
    FILE* fp = popen("python3 -c \"import Quartz; print(Quartz.CGSessionCopyCurrentDictionary().get('CGSSessionScreenIsLocked', False))\" 2>/dev/null", "r");
    bool isLocked = false;
    if (fp)
    {
        char buf[32];
        if (fgets(buf, sizeof(buf), fp))
        {
            isLocked = (strncmp(buf, "True", 4) == 0);
        }
        pclose(fp);
    }
    info["isScreenLocked"] = isLocked;
#else
    info["isScreenLocked"] = false;  // TODO: Implement for other platforms
#endif

    // Add service info
    info["serviceVersion"] = SERVICE_VERSION;
#if PLATFORM_MACOS || PLATFORM_LINUX
    info["serviceRunningAsRoot"] = (geteuid() == 0);
#else
    info["serviceRunningAsRoot"] = false;  // Windows: check differently
#endif

    return info;
}

// Helper function to check if browser bridge is available
// Checks port 3457 (GUI app) which handles browser extension connections
static bool checkBrowserBridgeAvailable()
{
    try {
        httplib::Client cli("127.0.0.1", 3457);
        cli.set_connection_timeout(1);  // 1 second timeout
        cli.set_read_timeout(1);

        // Send a getTabs command to check if browser bridge is responsive
        json body = {{"action", "getTabs"}, {"payload", json::object()}};
        auto res = cli.Post("/command", body.dump(), "application/json");

        if (res && res->status == 200) {
            // GUI app browser bridge is running
            Logger::info("Browser bridge available on port 3457");
            return true;
        }
    } catch (const std::exception& e) {
        Logger::debug("Browser bridge check failed: " + std::string(e.what()));
    }

    Logger::info("Browser bridge not available");
    return false;
}

json CommandDispatcher::handleToolsList()
{
    // Return list of available tools in MCP format
    json tools = json::array();

    // Helper to create tool definition
    auto addTool = [&tools](const std::string& name, const std::string& description,
                            const json& properties = json::object(),
                            const json& required = json::array()) {
        json tool = {
            {"name", name},
            {"description", description},
            {"inputSchema", {
                {"type", "object"},
                {"properties", properties},
                {"required", required}
            }}
        };
        tools.push_back(tool);
    };

    // Common property for optional agentId
    json agentIdProp = {{"type", "string"}, {"description", "Target agent ID (optional)"}};

    // ============ GUI TOOLS (matching macOS app names) ============
    // Application management
    addTool("listApplications", "List running applications",
        {{"agentId", agentIdProp}});

    addTool("focusApplication", "Focus an application",
        {{"identifier", {{"type", "string"}, {"description", "App bundle ID or name"}}},
         {"agentId", agentIdProp}},
        {"identifier"});

    addTool("launchApplication", "Launch an application",
        {{"identifier", {{"type", "string"}, {"description", "App bundle ID or name"}}},
         {"agentId", agentIdProp}},
        {"identifier"});

    addTool("closeApp", "Close an application",
        {{"identifier", {{"type", "string"}, {"description", "App bundle ID or name"}}},
         {"force", {{"type", "boolean"}, {"description", "Force quit the app"}}},
         {"agentId", agentIdProp}},
        {"identifier"});

    // Screenshots (temporarily skip for Claude web - can't display images)
    // addTool("screenshot", "Take a screenshot of the entire desktop", ...);
    // addTool("screenshot_app", "Take a screenshot of a specific application window", ...);
    // addTool("screenshot_grid", "Take a screenshot with labeled grid overlay", ...);

    // Mouse/click tools
    addTool("click", "Click at coordinates relative to current app",
        {{"x", {{"type", "number"}, {"description", "X coordinate"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate"}}},
         {"button", {{"type", "string"}, {"enum", {"left", "right"}}, {"description", "Mouse button"}}},
         {"agentId", agentIdProp}},
        {"x", "y"});

    addTool("click_absolute", "Click at absolute screen coordinates",
        {{"x", {{"type", "number"}, {"description", "X coordinate"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate"}}},
         {"button", {{"type", "string"}, {"enum", {"left", "right"}}, {"description", "Mouse button"}}},
         {"agentId", agentIdProp}},
        {"x", "y"});

    addTool("click_relative", "Click at coordinates relative to active window",
        {{"x", {{"type", "number"}, {"description", "X coordinate"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate"}}},
         {"button", {{"type", "string"}, {"enum", {"left", "right"}}, {"description", "Mouse button"}}},
         {"agentId", agentIdProp}},
        {"x", "y"});

    addTool("click_grid", "Click at a grid cell position (e.g., cell='E7')",
        {{"cell", {{"type", "string"}, {"description", "Grid cell reference (e.g., 'E7', 'A1', 'T15')"}}},
         {"column", {{"type", "number"}, {"description", "Column number (1-20), alternative to cell"}}},
         {"row", {{"type", "number"}, {"description", "Row number (1-15), alternative to cell"}}},
         {"button", {{"type", "string"}, {"enum", {"left", "right"}}, {"description", "Mouse button"}}},
         {"identifier", {{"type", "string"}, {"description", "App bundle ID or name"}}},
         {"element", {{"type", "number"}, {"description", "Element index from screenshot_grid"}}},
         {"element_text", {{"type", "string"}, {"description", "Text to search for in detected elements"}}},
         {"offset_x", {{"type", "number"}, {"description", "Horizontal offset in pixels"}}},
         {"offset_y", {{"type", "number"}, {"description", "Vertical offset in pixels"}}},
         {"agentId", agentIdProp}});

    addTool("doubleClick", "Double-click at coordinates",
        {{"x", {{"type", "number"}, {"description", "X coordinate"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate"}}},
         {"agentId", agentIdProp}},
        {"x", "y"});

    addTool("clickElement", "Click a UI element by index",
        {{"elementIndex", {{"type", "number"}, {"description", "Index of element to click"}}},
         {"agentId", agentIdProp}},
        {"elementIndex"});

    addTool("moveMouse", "Move mouse to coordinates",
        {{"x", {{"type", "number"}, {"description", "X coordinate"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate"}}},
         {"agentId", agentIdProp}},
        {"x", "y"});

    addTool("scroll", "Scroll with delta values",
        {{"deltaX", {{"type", "number"}, {"description", "Horizontal scroll amount"}}},
         {"deltaY", {{"type", "number"}, {"description", "Vertical scroll amount"}}},
         {"x", {{"type", "number"}, {"description", "X coordinate (optional)"}}},
         {"y", {{"type", "number"}, {"description", "Y coordinate (optional)"}}},
         {"agentId", agentIdProp}});

    addTool("scrollMouse", "Scroll up or down",
        {{"direction", {{"type", "string"}, {"enum", {"up", "down"}}, {"description", "Scroll direction"}}},
         {"amount", {{"type", "number"}, {"description", "Scroll amount (default: 3)"}}},
         {"agentId", agentIdProp}},
        {"direction"});

    addTool("drag", "Drag from one point to another",
        {{"startX", {{"type", "number"}}},
         {"startY", {{"type", "number"}}},
         {"endX", {{"type", "number"}}},
         {"endY", {{"type", "number"}}},
         {"agentId", agentIdProp}},
        {"startX", "startY", "endX", "endY"});

    // UI element inspection
    addTool("getClickableElements", "Get list of clickable UI elements",
        {{"agentId", agentIdProp}});

    addTool("getUIElements", "Get all UI elements",
        {{"agentId", agentIdProp}});

    addTool("getMousePosition", "Get current mouse position",
        {{"agentId", agentIdProp}});

    // Keyboard tools
    addTool("typeText", "Type text using keyboard",
        {{"text", {{"type", "string"}, {"description", "Text to type"}}},
         {"agentId", agentIdProp}},
        {"text"});

    addTool("pressKey", "Press a specific key",
        {{"key", {{"type", "string"}, {"description", "Key to press (e.g., 'enter', 'tab', 'escape')"}}},
         {"agentId", agentIdProp}},
        {"key"});

    // System tools
    addTool("checkPermissions", "Check accessibility permissions",
        {{"agentId", agentIdProp}});

    addTool("wait", "Wait for specified milliseconds",
        {{"milliseconds", {{"type", "number"}, {"description", "Time to wait in milliseconds"}}},
         {"agentId", agentIdProp}});

    addTool("system_info", "Get system information (OS, CPU, memory, hostname)",
        {{"agentId", agentIdProp}});

    addTool("window_list", "List all open windows on the desktop",
        {{"agentId", agentIdProp}});

    addTool("clipboard_read", "Read content from clipboard",
        {{"agentId", agentIdProp}});

    addTool("clipboard_write", "Write content to clipboard",
        {{"text", {{"type", "string"}, {"description", "Text to copy to clipboard"}}},
         {"agentId", agentIdProp}},
        {"text"});

    // ============ MACHINE CONTROL TOOLS (Windows only) ============
#if PLATFORM_WINDOWS
    addTool("machine_lock", "Lock the workstation screen",
        {{"agentId", agentIdProp}});

    addTool("machine_unlock", "Unlock the workstation using stored credentials. "
        "Requires credentials to be stored first via the credential provider. "
        "Only works on Windows with ScreenControl Credential Provider installed.",
        {{"agentId", agentIdProp}});
#endif

    // ============ FILESYSTEM TOOLS ============
    addTool("fs_list", "List directory contents",
        {{"path", {{"type", "string"}, {"description", "Directory path"}}},
         {"recursive", {{"type", "boolean"}, {"description", "List recursively"}}},
         {"max_depth", {{"type", "number"}, {"description", "Max recursion depth"}}},
         {"agentId", agentIdProp}},
        {"path"});

    addTool("fs_read", "Read file contents",
        {{"path", {{"type", "string"}, {"description", "File path"}}},
         {"max_bytes", {{"type", "number"}, {"description", "Maximum bytes to read"}}},
         {"agentId", agentIdProp}},
        {"path"});

    addTool("fs_read_range", "Read specific line range from file",
        {{"path", {{"type", "string"}, {"description", "File path"}}},
         {"start_line", {{"type", "number"}, {"description", "Start line (1-indexed)"}}},
         {"end_line", {{"type", "number"}, {"description", "End line (-1 for EOF)"}}},
         {"agentId", agentIdProp}},
        {"path"});

    addTool("fs_write", "Write content to file",
        {{"path", {{"type", "string"}, {"description", "File path"}}},
         {"content", {{"type", "string"}, {"description", "Content to write"}}},
         {"mode", {{"type", "string"}, {"enum", {"overwrite", "append"}}}},
         {"create_directories", {{"type", "boolean"}, {"description", "Create parent directories"}}},
         {"agentId", agentIdProp}},
        {"path", "content"});

    addTool("fs_delete", "Delete file or directory",
        {{"path", {{"type", "string"}, {"description", "Path to delete"}}},
         {"recursive", {{"type", "boolean"}, {"description", "Delete recursively"}}},
         {"agentId", agentIdProp}},
        {"path"});

    addTool("fs_move", "Move or rename files",
        {{"source", {{"type", "string"}, {"description", "Source path"}}},
         {"destination", {{"type", "string"}, {"description", "Destination path"}}},
         {"agentId", agentIdProp}},
        {"source", "destination"});

    addTool("fs_search", "Search files by glob pattern",
        {{"path", {{"type", "string"}, {"description", "Base path"}}},
         {"pattern", {{"type", "string"}, {"description", "Glob pattern (e.g., *.txt)"}}},
         {"max_results", {{"type", "number"}, {"description", "Maximum results"}}},
         {"agentId", agentIdProp}},
        {"path", "pattern"});

    addTool("fs_grep", "Search file contents with regex",
        {{"path", {{"type", "string"}, {"description", "Base path"}}},
         {"pattern", {{"type", "string"}, {"description", "Regex pattern"}}},
         {"glob", {{"type", "string"}, {"description", "File glob filter"}}},
         {"max_matches", {{"type", "number"}, {"description", "Maximum matches"}}},
         {"agentId", agentIdProp}},
        {"path", "pattern"});

    addTool("fs_patch", "Apply patches to files",
        {{"path", {{"type", "string"}, {"description", "File path"}}},
         {"operations", {{"type", "array"}, {"description", "Patch operations"}}},
         {"dry_run", {{"type", "boolean"}, {"description", "Preview without applying"}}},
         {"agentId", agentIdProp}},
        {"path", "operations"});

    // ============ SHELL TOOLS ============
    addTool("shell_exec", "Execute a shell command",
        {{"command", {{"type", "string"}, {"description", "Command to execute"}}},
         {"cwd", {{"type", "string"}, {"description", "Working directory"}}},
         {"timeout_seconds", {{"type", "number"}, {"description", "Timeout in seconds"}}},
         {"agentId", agentIdProp}},
        {"command"});

    addTool("shell_start_session", "Start an interactive shell session",
        {{"command", {{"type", "string"}, {"description", "Initial command (optional)"}}},
         {"cwd", {{"type", "string"}, {"description", "Working directory"}}},
         {"agentId", agentIdProp}});

    addTool("shell_send_input", "Send input to a shell session",
        {{"session_id", {{"type", "string"}, {"description", "Session ID"}}},
         {"input", {{"type", "string"}, {"description", "Input to send"}}},
         {"agentId", agentIdProp}},
        {"session_id", "input"});

    addTool("shell_read_output", "Read output from a shell session",
        {{"session_id", {{"type", "string"}, {"description", "Session ID"}}},
         {"agentId", agentIdProp}},
        {"session_id"});

    addTool("shell_stop_session", "Stop a shell session",
        {{"session_id", {{"type", "string"}, {"description", "Session ID"}}},
         {"signal", {{"type", "string"}, {"description", "Signal to send (TERM, KILL)"}}},
         {"agentId", agentIdProp}},
        {"session_id"});

    // ============ BROWSER TOOLS (only when browser extension is connected) ============
    bool browserAvailable = checkBrowserBridgeAvailable();
    if (browserAvailable) {
        Logger::info("Adding browser tools (browser bridge available)");

        // Common browser property
        json browserProp = {{"type", "string"}, {"description", "Target browser (chrome, firefox, safari, edge)"}};
        json tabIdProp = {{"type", "number"}, {"description", "Tab ID"}};
        json urlProp = {{"type", "string"}, {"description", "URL of tab to target"}};
        json selectorProp = {{"type", "string"}, {"description", "CSS selector"}};

        addTool("browser_listConnected", "List connected browsers",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_setDefaultBrowser", "Set the default browser for browser operations",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getTabs", "Get list of open tabs",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getActiveTab", "Get the active tab",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_focusTab", "Focus a specific tab",
            {{"browser", browserProp}, {"tabId", tabIdProp}, {"agentId", agentIdProp}});

        addTool("browser_createTab", "Create a new tab",
            {{"browser", browserProp}, {"url", urlProp}, {"agentId", agentIdProp}});

        addTool("browser_closeTab", "Close a tab",
            {{"browser", browserProp}, {"tabId", tabIdProp}, {"agentId", agentIdProp}});

        addTool("browser_getPageInfo", "Get page information",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_inspectCurrentPage", "Inspect the current page",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getInteractiveElements", "Get interactive elements on the page",
            {{"browser", browserProp}, {"url", urlProp}, {"tabId", tabIdProp},
             {"verbose", {{"type", "boolean"}, {"description", "Return full element details"}}},
             {"agentId", agentIdProp}});

        addTool("browser_getPageContext", "Get page context",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_clickElement", "Click an element in the browser",
            {{"browser", browserProp}, {"selector", selectorProp}, {"url", urlProp},
             {"tabId", tabIdProp}, {"text", {{"type", "string"}, {"description", "Text content to find"}}},
             {"agentId", agentIdProp}});

        addTool("browser_fillElement", "Fill a form field",
            {{"browser", browserProp}, {"selector", selectorProp}, {"url", urlProp},
             {"tabId", tabIdProp}, {"value", {{"type", "string"}, {"description", "Value to fill"}}},
             {"agentId", agentIdProp}},
            {"selector", "value"});

        addTool("browser_fillFormField", "Fill a form field",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_fillWithFallback", "Fill with fallback",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_fillFormNative", "Fill form using native input",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_scrollTo", "Scroll to position",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_executeScript", "Execute JavaScript in the browser",
            {{"browser", browserProp}, {"script", {{"type", "string"}, {"description", "JavaScript to execute"}}},
             {"agentId", agentIdProp}});

        addTool("browser_getFormData", "Get form data",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_setWatchMode", "Set watch mode",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getVisibleText", "Get visible text from a tab",
            {{"browser", browserProp}, {"url", urlProp}, {"tabId", tabIdProp}, {"agentId", agentIdProp}});

        addTool("browser_searchVisibleText", "Search for text in a tab",
            {{"browser", browserProp}, {"query", {{"type", "string"}, {"description", "Text to search for"}}},
             {"url", urlProp}, {"tabId", tabIdProp}, {"agentId", agentIdProp}});

        addTool("browser_getUIElements", "Get UI elements",
            {{"browser", browserProp}, {"url", urlProp}, {"tabId", tabIdProp},
             {"verbose", {{"type", "boolean"}, {"description", "Return full element details"}}},
             {"agentId", agentIdProp}});

        addTool("browser_waitForSelector", "Wait for a selector to appear",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_waitForPageLoad", "Wait for page to load",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_selectOption", "Select an option from dropdown",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_isElementVisible", "Check if element is visible",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getConsoleLogs", "Get console logs",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getNetworkRequests", "Get network requests",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getLocalStorage", "Get local storage",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getCookies", "Get cookies",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_clickByText", "Click element by text",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_clickMultiple", "Click multiple elements",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getFormStructure", "Get form structure",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_answerQuestions", "Answer questions on forms",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_getDropdownOptions", "Get dropdown options",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_openDropdownNative", "Open dropdown using native controls",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_listInteractiveElements", "List interactive elements",
            {{"browser", browserProp}, {"url", urlProp}, {"tabId", tabIdProp},
             {"verbose", {{"type", "boolean"}, {"description", "Return full element details"}}},
             {"agentId", agentIdProp}});

        addTool("browser_clickElementWithDebug", "Click element with debug info",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_findElementWithDebug", "Find element with debug info",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_findTabByUrl", "Find tab by URL",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_navigate", "Navigate browser to a URL",
            {{"browser", browserProp}, {"url", {{"type", "string"}, {"description", "URL to navigate to"}}},
             {"agentId", agentIdProp}},
            {"url"});

        addTool("browser_screenshot", "Take a browser screenshot",
            {{"browser", browserProp},
             {"format", {{"type", "string"}, {"enum", {"png", "jpeg"}}}},
             {"return_base64", {{"type", "boolean"}, {"description", "Return base64 instead of file path"}}},
             {"agentId", agentIdProp}});

        addTool("browser_go_back", "Navigate back",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_go_forward", "Navigate forward",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_get_visible_html", "Get page HTML",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_hover", "Hover over element",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_drag", "Drag element",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_press_key", "Press key in browser",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_upload_file", "Upload file",
            {{"browser", browserProp}, {"agentId", agentIdProp}});

        addTool("browser_save_as_pdf", "Save page as PDF",
            {{"browser", browserProp}, {"agentId", agentIdProp}});
    } else {
        Logger::info("Skipping browser tools (browser bridge not available)");
    }

    Logger::info("Returning " + std::to_string(tools.size()) + " tools");
    return {{"tools", tools}};
}

json CommandDispatcher::errorResponse(const std::string& message)
{
    return {{"error", message}};
}

} // namespace ScreenControl
