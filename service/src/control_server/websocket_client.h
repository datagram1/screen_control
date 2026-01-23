/**
 * WebSocket Client for ScreenControl Service
 *
 * Cross-platform WebSocket client for connecting to the control server.
 * Handles agent registration, heartbeat, and command dispatch.
 */

#pragma once

#include "platform.h"
#include "../libs/json.hpp"
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <mutex>
#include <memory>
#include <vector>

namespace ScreenControl
{

// Connection configuration
struct ConnectionConfig
{
    std::string serverUrl = "wss://screencontrol.knws.co.uk/ws";
    std::string endpointUuid;
    std::string customerId;
    std::string agentName;
    bool connectOnStartup = false;

    bool load(const std::string& path);
    bool save(const std::string& path) const;
};

class WebSocketClient
{
public:
    // Callback types
    using LogCallback = std::function<void(const std::string&)>;
    using ConnectionCallback = std::function<void(bool connected)>;
    using StatusCallback = std::function<void(const std::string& agentId, const std::string& licenseStatus)>;
    using CommandCallback = std::function<nlohmann::json(const std::string& method, const nlohmann::json& params)>;
    using HeartbeatCallback = std::function<void(int updateFlag)>;
    using PermissionsCallback = std::function<void(bool masterMode, bool fileTransfer, bool localSettingsLocked)>;

    WebSocketClient();
    ~WebSocketClient();

    // Singleton access
    static WebSocketClient& getInstance();

    // Connection management
    bool connect(const ConnectionConfig& config);
    void disconnect();
    bool reconnect();
    bool isConnected() const { return m_connected; }

    // Getters
    std::string getAgentId() const { return m_agentId; }
    std::string getLicenseStatus() const { return m_licenseStatus; }
    std::string getServerUrl() const { return m_serverUrl; }

    // Server-controlled permissions
    bool getMasterModeEnabled() const { return m_masterModeEnabled; }
    bool getFileTransferEnabled() const { return m_fileTransferEnabled; }
    bool getLocalSettingsLocked() const { return m_localSettingsLocked; }

    // Event callbacks
    void setLogCallback(LogCallback cb) { m_logCallback = cb; }
    void setConnectionCallback(ConnectionCallback cb) { m_connectionCallback = cb; }
    void setStatusCallback(StatusCallback cb) { m_statusCallback = cb; }
    void setCommandCallback(CommandCallback cb) { m_commandCallback = cb; }
    void setHeartbeatCallback(HeartbeatCallback cb) { m_heartbeatCallback = cb; }
    void setPermissionsCallback(PermissionsCallback cb) { m_permissionsCallback = cb; }

    // Send response to a command request
    void sendResponse(const std::string& requestId, const nlohmann::json& result);

    // Send error response
    void sendError(const std::string& requestId, const std::string& error);

    // Relay a command to another agent (for master mode)
    void relayCommand(const std::string& targetAgentId, const std::string& method,
                      const nlohmann::json& params,
                      std::function<void(const nlohmann::json&)> callback);

private:
    void log(const std::string& message);

    // Connection internals
    bool parseUrl(const std::string& url, std::string& host, std::string& path, int& port, bool& useSSL);
    bool tcpConnect(const std::string& host, int port);
    bool sslConnect(const std::string& host);
    bool websocketHandshake(const std::string& host, const std::string& path);

    // SSL operations
    int sslRead(char* buffer, int length);
    int sslWrite(const char* data, int length);
    void sslDisconnect();

    // WebSocket frame handling
    bool sendWebSocketFrame(const std::string& payload);
    void receiveLoop();
    void handleMessage(const std::string& message);

    // Protocol handlers
    void sendRegistration();
    void sendHeartbeat();
    void startHeartbeat(int intervalMs);
    void stopHeartbeat();

    void handleRegistered(const nlohmann::json& j);
    void handleHeartbeatAck(const nlohmann::json& j);
    void handleRequest(const nlohmann::json& j);
    void handleRelayResponse(const nlohmann::json& j);

    // System info helpers
    std::string getMachineId();
    std::string getCpuModel();
    std::string getHostname();
    std::string getOsVersion();
    bool isScreenLocked();

    // Socket/SSL state
#if PLATFORM_WINDOWS
    void* m_socket = nullptr;  // SOCKET
#else
    int m_socket = -1;
#endif
    void* m_ssl = nullptr;
    void* m_sslCtx = nullptr;
    bool m_useSSL = false;

    // Connection state
    std::atomic<bool> m_connected{false};
    std::atomic<bool> m_running{false};
    std::thread m_receiveThread;
    std::thread m_heartbeatThread;
    std::mutex m_sendMutex;
    std::atomic<bool> m_stopHeartbeat{false};

    // Agent state
    std::string m_serverUrl;
    std::string m_agentId;
    std::string m_licenseStatus;
    int m_heartbeatInterval = 5000;
    ConnectionConfig m_config;

    // Server-controlled permissions
    std::atomic<bool> m_masterModeEnabled{false};
    std::atomic<bool> m_fileTransferEnabled{false};
    std::atomic<bool> m_localSettingsLocked{false};

    // Relay callbacks (for master mode)
    std::mutex m_relayMutex;
    std::map<std::string, std::function<void(const nlohmann::json&)>> m_relayCallbacks;

    // Callbacks
    LogCallback m_logCallback;
    ConnectionCallback m_connectionCallback;
    StatusCallback m_statusCallback;
    CommandCallback m_commandCallback;
    HeartbeatCallback m_heartbeatCallback;
    PermissionsCallback m_permissionsCallback;
};

} // namespace ScreenControl
