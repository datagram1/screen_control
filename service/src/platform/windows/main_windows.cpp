/**
 * Windows Service Entry Point
 *
 * Windows Service entry point for ScreenControl Service.
 * Runs as SYSTEM to survive machine lock and handle unlock operations.
 */

#include "platform.h"
#include "../../core/config.h"
#include "../../core/logger.h"
#include "../../server/http_server.h"
#include "../../control_server/websocket_client.h"
#include "../../control_server/command_dispatcher.h"
#include "../../update/update_manager.h"
#include "../../libs/httplib.h"
#include <atomic>
#include <thread>
#include <chrono>
#include <iostream>

#if !PLATFORM_WINDOWS
#error "This file should only be compiled for Windows"
#endif

#include <windows.h>

using namespace ScreenControl;

// Global state
static std::atomic<bool> g_running{true};
static std::unique_ptr<HttpServer> g_httpServer;
static ConnectionConfig g_wsConfig;
static SERVICE_STATUS g_serviceStatus;
static SERVICE_STATUS_HANDLE g_statusHandle = nullptr;

// Forward declarations
void WINAPI ServiceMain(DWORD argc, LPSTR* argv);
void WINAPI ServiceCtrlHandler(DWORD ctrlCode);
void RunService();
void RunConsole(int argc, char* argv[]);

// Service control handler
void WINAPI ServiceCtrlHandler(DWORD ctrlCode)
{
    switch (ctrlCode)
    {
        case SERVICE_CONTROL_STOP:
        case SERVICE_CONTROL_SHUTDOWN:
            Logger::info("Service stop requested");
            g_running = false;

            // Update service status
            g_serviceStatus.dwCurrentState = SERVICE_STOP_PENDING;
            g_serviceStatus.dwWaitHint = 30000;
            SetServiceStatus(g_statusHandle, &g_serviceStatus);

            // Disconnect WebSocket
            WebSocketClient::getInstance().disconnect();

            if (g_httpServer)
            {
                g_httpServer->stop();
            }
            break;

        case SERVICE_CONTROL_INTERROGATE:
            SetServiceStatus(g_statusHandle, &g_serviceStatus);
            break;

        default:
            break;
    }
}

// Service main function
void WINAPI ServiceMain(DWORD argc, LPSTR* argv)
{
    // Register service control handler
    g_statusHandle = RegisterServiceCtrlHandlerA("ScreenControlService", ServiceCtrlHandler);
    if (!g_statusHandle)
    {
        return;
    }

    // Initialize service status
    g_serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_serviceStatus.dwCurrentState = SERVICE_START_PENDING;
    g_serviceStatus.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
    g_serviceStatus.dwWin32ExitCode = 0;
    g_serviceStatus.dwServiceSpecificExitCode = 0;
    g_serviceStatus.dwCheckPoint = 0;
    g_serviceStatus.dwWaitHint = 30000;
    SetServiceStatus(g_statusHandle, &g_serviceStatus);

    // Run the service
    RunService();

    // Service is stopping
    g_serviceStatus.dwCurrentState = SERVICE_STOPPED;
    SetServiceStatus(g_statusHandle, &g_serviceStatus);
}

// Create required directories
static void createDirectories()
{
    CreateDirectoryA(SERVICE_CONFIG_DIR, nullptr);
    CreateDirectoryA(SERVICE_LOG_DIR, nullptr);
}

// Main service logic
void RunService()
{
    // Create directories first
    createDirectories();

    // Initialize logger
    std::string logFile = std::string(SERVICE_LOG_DIR) + "\\service.log";
    Logger::init(logFile, false);
    Logger::info("ScreenControl Service starting [Windows]");

    // Update status to running
    if (g_statusHandle)
    {
        g_serviceStatus.dwCurrentState = SERVICE_RUNNING;
        g_serviceStatus.dwCheckPoint = 0;
        g_serviceStatus.dwWaitHint = 0;
        SetServiceStatus(g_statusHandle, &g_serviceStatus);
    }

    // Load configuration
    auto& config = Config::getInstance();
    std::string configPath = std::string(SERVICE_CONFIG_DIR) + "\\config.json";
    config.load(configPath);
    Logger::info("Configuration loaded");

    // Start HTTP server
    int httpPort = config.getHttpPort();
    g_httpServer = std::make_unique<HttpServer>(httpPort);

    // Setup GUI proxy callback
    int guiBridgePort = config.getGuiBridgePort();
    g_httpServer->setGuiProxyCallback([guiBridgePort](const std::string& endpoint, const std::string& body) {
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

    wsClient.setLogCallback([](const std::string& message) {
        Logger::info(message);
    });

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

    wsClient.setStatusCallback([](const std::string& agentId, const std::string& licenseStatus) {
        Logger::info("Agent ID: " + agentId + ", License: " + licenseStatus);
    });

    wsClient.setCommandCallback([&dispatcher](const std::string& method, const nlohmann::json& params) {
        return dispatcher.dispatch(method, params);
    });

    // Load WebSocket config
    std::string wsConfigPath = std::string(SERVICE_CONFIG_DIR) + "\\connection.json";
    if (g_wsConfig.load(wsConfigPath))
    {
        Logger::info("WebSocket config loaded from " + wsConfigPath);
    }
    else
    {
        g_wsConfig.serverUrl = config.getControlServerUrl();
        Logger::info("Using control server URL from main config: " + g_wsConfig.serverUrl);
    }

    // Connect to control server if configured
    if (!g_wsConfig.serverUrl.empty() && g_wsConfig.connectOnStartup)
    {
        Logger::info("Connecting to control server: " + g_wsConfig.serverUrl);
        wsClient.connect(g_wsConfig);
    }

    // Configure auto-update system
    auto& updateManager = UpdateManager::getInstance();
    UpdateConfig updateConfig;
    updateConfig.serverUrl = "https://screencontrol.knws.co.uk";
    updateConfig.currentVersion = SERVICE_VERSION;  // Defined in platform.h or config
    updateConfig.platform = "windows";
    updateConfig.arch = sizeof(void*) == 8 ? "x64" : "x86";
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

    // Main loop
    Logger::info("Service is ready");
    int reconnectAttempts = 0;
    const int maxReconnectDelay = 60;

    while (g_running)
    {
        std::this_thread::sleep_for(std::chrono::seconds(1));

        // Reconnection logic
        if (!g_wsConfig.serverUrl.empty() && g_wsConfig.connectOnStartup)
        {
            if (!wsClient.isConnected())
            {
                int delay = std::min(5 * (1 << reconnectAttempts), maxReconnectDelay);
                reconnectAttempts++;

                Logger::info("Reconnecting to control server in " + std::to_string(delay) + " seconds...");
                std::this_thread::sleep_for(std::chrono::seconds(delay));

                if (g_running && wsClient.reconnect())
                {
                    reconnectAttempts = 0;
                }
            }
            else
            {
                reconnectAttempts = 0;
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
}

// Console mode for testing
void RunConsole(int argc, char* argv[])
{
    bool verbose = false;
    std::string configPath;

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
    }

    createDirectories();

    std::string logFile = std::string(SERVICE_LOG_DIR) + "\\service.log";
    Logger::init(logFile, verbose);

    // Set console control handler
    SetConsoleCtrlHandler([](DWORD ctrlType) -> BOOL {
        if (ctrlType == CTRL_C_EVENT || ctrlType == CTRL_BREAK_EVENT)
        {
            Logger::info("Console interrupt received");
            g_running = false;

            WebSocketClient::getInstance().disconnect();

            if (g_httpServer)
            {
                g_httpServer->stop();
            }
            return TRUE;
        }
        return FALSE;
    }, TRUE);

    RunService();
}

int main(int argc, char* argv[])
{
    // Check for console mode
    bool consoleMode = false;
    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];
        if (arg == "--console" || arg == "-d")
        {
            consoleMode = true;
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "ScreenControl Service for Windows\n"
                      << "Usage: " << argv[0] << " [options]\n"
                      << "Options:\n"
                      << "  -d, --console       Run in console mode (for testing)\n"
                      << "  -c, --config PATH   Config file path\n"
                      << "  -v, --verbose       Verbose logging\n"
                      << "  -h, --help          Show this help\n\n"
                      << "Service commands:\n"
                      << "  sc create ScreenControlService binPath= \"<path>\\ScreenControlService.exe\"\n"
                      << "  sc start ScreenControlService\n"
                      << "  sc stop ScreenControlService\n"
                      << "  sc delete ScreenControlService\n";
            return 0;
        }
    }

    if (consoleMode)
    {
        RunConsole(argc, argv);
        return 0;
    }

    // Start as Windows Service
    SERVICE_TABLE_ENTRYA serviceTable[] = {
        {"ScreenControlService", ServiceMain},
        {nullptr, nullptr}
    };

    if (!StartServiceCtrlDispatcherA(serviceTable))
    {
        DWORD error = GetLastError();
        if (error == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT)
        {
            // Not running as a service, run in console mode
            std::cout << "Not running as a service. Use --console for console mode.\n";
            std::cout << "Use --help for more options.\n";
            return 1;
        }
    }

    return 0;
}
