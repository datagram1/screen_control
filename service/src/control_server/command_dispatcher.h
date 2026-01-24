/**
 * Command Dispatcher
 *
 * Routes incoming commands from the control server to the appropriate
 * tool handlers (filesystem, shell, system, GUI proxy).
 */

#pragma once

#include "platform.h"
#include "../libs/json.hpp"
#include <string>
#include <functional>
#include <map>

namespace ScreenControl
{

class CommandDispatcher
{
public:
    // GUI proxy callback - for operations that need the tray app
    using GuiProxyCallback = std::function<nlohmann::json(const std::string& method, const nlohmann::json& params)>;

    CommandDispatcher();
    ~CommandDispatcher() = default;

    // Singleton access
    static CommandDispatcher& getInstance();

    // Set GUI proxy for operations requiring tray app
    void setGuiProxy(GuiProxyCallback callback) { m_guiProxy = callback; }

    // Main dispatch method - called by WebSocket client
    nlohmann::json dispatch(const std::string& method, const nlohmann::json& params);

    // Get lightweight capability list (just tool names, no schemas)
    // Used for registration message instead of full tools/list
    std::vector<std::string> getCapabilitiesList();

private:
    // Tool handlers
    nlohmann::json handleFilesystemTool(const std::string& method, const nlohmann::json& params);
    nlohmann::json handleShellTool(const std::string& method, const nlohmann::json& params);
    nlohmann::json handleSystemTool(const std::string& method, const nlohmann::json& params);
    nlohmann::json handleScreenshotTool(const nlohmann::json& params);
    nlohmann::json handleClickTool(const nlohmann::json& params);
    nlohmann::json handleTypeTool(const nlohmann::json& params);
    nlohmann::json handleScrollTool(const nlohmann::json& params);
    nlohmann::json handleKeyPressTool(const nlohmann::json& params);

    // Machine control (service handles directly)
    nlohmann::json handleMachineUnlock(const nlohmann::json& params);
    nlohmann::json handleMachineLock();
    nlohmann::json handleMachineInfo();

    // Tools discovery (MCP protocol)
    nlohmann::json handleToolsList();

    // Error response helper
    nlohmann::json errorResponse(const std::string& message);

    // Methods that require GUI proxy (tray app)
    static const std::vector<std::string> GUI_METHODS;

    GuiProxyCallback m_guiProxy;
};

} // namespace ScreenControl
