/**
 * WebSocket Client Implementation
 *
 * Cross-platform WebSocket client using POSIX sockets (macOS/Linux)
 * or Winsock (Windows) with OpenSSL for TLS.
 */

#include "websocket_client.h"
#include "platform.h"
#include "../core/config.h"
#include "../core/logger.h"
#include "../update/update_manager.h"
#include "../screen/screen_stream.h"
#include <fstream>
#include <sstream>
#include <cstring>
#include <ctime>
#include <random>
#include <chrono>

#if PLATFORM_WINDOWS
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
    #define SOCKET_INVALID INVALID_SOCKET
    #define SOCKET_ERROR_CODE WSAGetLastError()
    #define CLOSE_SOCKET(s) closesocket(s)
#else
    #include <sys/socket.h>
    #include <sys/types.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <netdb.h>
    #include <unistd.h>
    #include <fcntl.h>
    #if PLATFORM_MACOS
        #include <sys/sysctl.h>
    #endif
    #define SOCKET_INVALID -1
    #define SOCKET_ERROR_CODE errno
    #define CLOSE_SOCKET(s) close(s)
#endif

// OpenSSL (macOS/Linux only - Windows uses stub implementation for now)
#if !PLATFORM_WINDOWS
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/buffer.h>
#endif

using json = nlohmann::json;

namespace ScreenControl
{

// ConnectionConfig implementation
bool ConnectionConfig::load(const std::string& path)
{
    try
    {
        std::ifstream file(path);
        if (!file.is_open()) return false;

        json j;
        file >> j;

        if (j.contains("serverUrl")) serverUrl = j["serverUrl"];
        if (j.contains("endpointUuid")) endpointUuid = j["endpointUuid"];
        if (j.contains("customerId")) customerId = j["customerId"];
        if (j.contains("agentName")) agentName = j["agentName"];
        if (j.contains("connectOnStartup")) connectOnStartup = j["connectOnStartup"];

        return true;
    }
    catch (...)
    {
        return false;
    }
}

bool ConnectionConfig::save(const std::string& path) const
{
    try
    {
        json j;
        j["serverUrl"] = serverUrl;
        j["endpointUuid"] = endpointUuid;
        j["customerId"] = customerId;
        j["agentName"] = agentName;
        j["connectOnStartup"] = connectOnStartup;

        std::ofstream file(path);
        if (!file.is_open()) return false;

        file << j.dump(2);
        return true;
    }
    catch (...)
    {
        return false;
    }
}

// Helper functions
static std::string base64Encode(const unsigned char* data, size_t len)
{
    BIO* bio = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new(BIO_s_mem());
    bio = BIO_push(bio, bmem);
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(bio, data, static_cast<int>(len));
    BIO_flush(bio);

    BUF_MEM* bptr;
    BIO_get_mem_ptr(bio, &bptr);

    std::string result(bptr->data, bptr->length);
    BIO_free_all(bio);
    return result;
}

static std::string generateWebSocketKey()
{
    unsigned char key[16];
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(0, 255);

    for (int i = 0; i < 16; i++)
    {
        key[i] = static_cast<unsigned char>(dist(gen));
    }

    return base64Encode(key, 16);
}

// WebSocketClient implementation
WebSocketClient::WebSocketClient()
{
#if PLATFORM_WINDOWS
    // Initialize Winsock
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

    // Initialize OpenSSL
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();
}

WebSocketClient::~WebSocketClient()
{
    disconnect();

#if PLATFORM_WINDOWS
    WSACleanup();
#endif
}

WebSocketClient& WebSocketClient::getInstance()
{
    static WebSocketClient instance;
    return instance;
}

void WebSocketClient::log(const std::string& message)
{
    auto now = std::time(nullptr);
    char timeBuf[32];
    std::strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", std::localtime(&now));

    std::string fullMsg = "[" + std::string(timeBuf) + "] " + message;

    if (m_logCallback)
    {
        m_logCallback(fullMsg);
    }

    Logger::info("[WS] " + message);
}

bool WebSocketClient::parseUrl(const std::string& url, std::string& host, std::string& path,
                               int& port, bool& useSSL)
{
    std::string remaining = url;

    if (remaining.find("wss://") == 0)
    {
        remaining = remaining.substr(6);
        useSSL = true;
        port = 443;
    }
    else if (remaining.find("ws://") == 0)
    {
        remaining = remaining.substr(5);
        useSSL = false;
        port = 80;
    }
    else
    {
        return false;
    }

    size_t pathPos = remaining.find('/');
    if (pathPos != std::string::npos)
    {
        host = remaining.substr(0, pathPos);
        path = remaining.substr(pathPos);
    }
    else
    {
        host = remaining;
        path = "/";
    }

    size_t portPos = host.find(':');
    if (portPos != std::string::npos)
    {
        port = std::stoi(host.substr(portPos + 1));
        host = host.substr(0, portPos);
    }

    return true;
}

bool WebSocketClient::tcpConnect(const std::string& host, int port)
{
    struct addrinfo hints = {}, *addrs;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    int err = getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &addrs);
    if (err != 0)
    {
        log("ERROR: Failed to resolve hostname: " + host);
        return false;
    }

#if PLATFORM_WINDOWS
    SOCKET sock = socket(addrs->ai_family, addrs->ai_socktype, addrs->ai_protocol);
    if (sock == INVALID_SOCKET)
    {
        log("ERROR: Failed to create socket");
        freeaddrinfo(addrs);
        return false;
    }

    if (::connect(sock, addrs->ai_addr, static_cast<int>(addrs->ai_addrlen)) == SOCKET_ERROR)
    {
        log("ERROR: Failed to connect");
        closesocket(sock);
        freeaddrinfo(addrs);
        return false;
    }

    m_socket = reinterpret_cast<void*>(sock);
#else
    int sock = socket(addrs->ai_family, addrs->ai_socktype, addrs->ai_protocol);
    if (sock < 0)
    {
        log("ERROR: Failed to create socket");
        freeaddrinfo(addrs);
        return false;
    }

    if (::connect(sock, addrs->ai_addr, addrs->ai_addrlen) < 0)
    {
        log("ERROR: Failed to connect");
        close(sock);
        freeaddrinfo(addrs);
        return false;
    }

    m_socket = sock;
#endif

    freeaddrinfo(addrs);
    return true;
}

bool WebSocketClient::sslConnect(const std::string& host)
{
    m_sslCtx = SSL_CTX_new(TLS_client_method());
    if (!m_sslCtx)
    {
        log("ERROR: Failed to create SSL context");
        return false;
    }

    m_ssl = SSL_new(static_cast<SSL_CTX*>(m_sslCtx));

#if PLATFORM_WINDOWS
    SSL_set_fd(static_cast<SSL*>(m_ssl), static_cast<int>(reinterpret_cast<intptr_t>(m_socket)));
#else
    SSL_set_fd(static_cast<SSL*>(m_ssl), m_socket);
#endif

    SSL_set_tlsext_host_name(static_cast<SSL*>(m_ssl), host.c_str());

    if (SSL_connect(static_cast<SSL*>(m_ssl)) <= 0)
    {
        log("ERROR: SSL handshake failed");
        SSL_free(static_cast<SSL*>(m_ssl));
        SSL_CTX_free(static_cast<SSL_CTX*>(m_sslCtx));
        m_ssl = nullptr;
        m_sslCtx = nullptr;
        return false;
    }

    m_useSSL = true;
    return true;
}

int WebSocketClient::sslRead(char* buffer, int length)
{
    if (m_ssl)
    {
        return SSL_read(static_cast<SSL*>(m_ssl), buffer, length);
    }
#if PLATFORM_WINDOWS
    return recv(reinterpret_cast<SOCKET>(m_socket), buffer, length, 0);
#else
    return read(m_socket, buffer, length);
#endif
}

int WebSocketClient::sslWrite(const char* data, int length)
{
    if (m_ssl)
    {
        return SSL_write(static_cast<SSL*>(m_ssl), data, length);
    }
#if PLATFORM_WINDOWS
    return send(reinterpret_cast<SOCKET>(m_socket), data, length, 0);
#else
    return write(m_socket, data, length);
#endif
}

void WebSocketClient::sslDisconnect()
{
    if (m_ssl)
    {
        SSL_shutdown(static_cast<SSL*>(m_ssl));
        SSL_free(static_cast<SSL*>(m_ssl));
        m_ssl = nullptr;
    }

    if (m_sslCtx)
    {
        SSL_CTX_free(static_cast<SSL_CTX*>(m_sslCtx));
        m_sslCtx = nullptr;
    }

#if PLATFORM_WINDOWS
    if (m_socket)
    {
        closesocket(reinterpret_cast<SOCKET>(m_socket));
        m_socket = nullptr;
    }
#else
    if (m_socket >= 0)
    {
        close(m_socket);
        m_socket = -1;
    }
#endif
}

bool WebSocketClient::websocketHandshake(const std::string& host, const std::string& path)
{
    std::string wsKey = generateWebSocketKey();
    std::ostringstream request;
    request << "GET " << path << " HTTP/1.1\r\n"
            << "Host: " << host << "\r\n"
            << "Upgrade: websocket\r\n"
            << "Connection: Upgrade\r\n"
            << "Sec-WebSocket-Key: " << wsKey << "\r\n"
            << "Sec-WebSocket-Version: 13\r\n"
            << "\r\n";

    std::string reqStr = request.str();
    int written = sslWrite(reqStr.c_str(), static_cast<int>(reqStr.size()));

    if (written <= 0)
    {
        log("ERROR: Failed to send WebSocket handshake");
        return false;
    }

    // Read response
    char buffer[4096];
    int bytesRead = sslRead(buffer, sizeof(buffer) - 1);

    if (bytesRead <= 0)
    {
        log("ERROR: No response to WebSocket handshake");
        return false;
    }

    buffer[bytesRead] = '\0';
    std::string response(buffer);

    if (response.find("101") == std::string::npos)
    {
        log("ERROR: WebSocket handshake rejected: " + response.substr(0, 100));
        return false;
    }

    return true;
}

bool WebSocketClient::connect(const ConnectionConfig& config)
{
    if (m_connected) return true;

    m_config = config;
    m_serverUrl = config.serverUrl;

    log("Connecting to " + config.serverUrl + "...");

    std::string host, path;
    int port;
    bool useSSL;

    if (!parseUrl(config.serverUrl, host, path, port, useSSL))
    {
        log("ERROR: Invalid WebSocket URL");
        return false;
    }

    if (!tcpConnect(host, port))
    {
        return false;
    }

    if (useSSL && !sslConnect(host))
    {
        sslDisconnect();
        return false;
    }

    if (!websocketHandshake(host, path))
    {
        sslDisconnect();
        return false;
    }

    log("WebSocket connected");
    m_connected = true;
    m_running = true;

    if (m_connectionCallback)
    {
        m_connectionCallback(true);
    }

    // Send registration
    sendRegistration();

    // Start receive loop
    m_receiveThread = std::thread(&WebSocketClient::receiveLoop, this);

    return true;
}

void WebSocketClient::disconnect()
{
#if PLATFORM_WINDOWS
    if (!m_connected && m_socket == nullptr) return;
#else
    if (!m_connected && m_socket < 0) return;
#endif

    log("Disconnecting...");

    m_running = false;
    m_connected = false;
    stopHeartbeat();

    if (m_receiveThread.joinable())
    {
        m_receiveThread.join();
    }

    sslDisconnect();

    if (m_connectionCallback)
    {
        m_connectionCallback(false);
    }

    log("Disconnected");
}

bool WebSocketClient::reconnect()
{
    disconnect();
    std::this_thread::sleep_for(std::chrono::seconds(1));
    return connect(m_config);
}

bool WebSocketClient::sendWebSocketFrame(const std::string& payload)
{
    std::vector<uint8_t> frame;
    frame.push_back(0x81); // FIN + text opcode

    size_t len = payload.size();
    if (len <= 125)
    {
        frame.push_back(0x80 | static_cast<uint8_t>(len)); // Mask bit + length
    }
    else if (len <= 65535)
    {
        frame.push_back(0x80 | 126);
        frame.push_back((len >> 8) & 0xFF);
        frame.push_back(len & 0xFF);
    }
    else
    {
        frame.push_back(0x80 | 127);
        for (int i = 7; i >= 0; i--)
        {
            frame.push_back((len >> (i * 8)) & 0xFF);
        }
    }

    // Masking key
    uint8_t mask[4];
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(0, 255);
    for (int i = 0; i < 4; i++)
    {
        mask[i] = static_cast<uint8_t>(dist(gen));
        frame.push_back(mask[i]);
    }

    // Masked payload
    for (size_t i = 0; i < payload.size(); i++)
    {
        frame.push_back(static_cast<uint8_t>(payload[i]) ^ mask[i % 4]);
    }

    std::lock_guard<std::mutex> lock(m_sendMutex);
    int written = sslWrite(reinterpret_cast<const char*>(frame.data()), static_cast<int>(frame.size()));
    return written > 0;
}

void WebSocketClient::sendRegistration()
{
    json message;
    message["type"] = "register";
    message["machineId"] = getMachineId();
    message["machineName"] = getHostname();
    message["osType"] = PLATFORM_ID;
    message["osVersion"] = getOsVersion();

    std::string arch;
#if defined(__x86_64__) || defined(_M_X64)
    arch = "x64";
#elif defined(__aarch64__) || defined(_M_ARM64)
    arch = "arm64";
#elif defined(__i386__) || defined(_M_IX86)
    arch = "x86";
#else
    arch = "unknown";
#endif
    message["arch"] = arch;

    // Use SERVICE_VERSION from CMakeLists.txt (set via compile definition)
    message["agentVersion"] = SERVICE_VERSION;

    if (!m_config.agentName.empty())
    {
        message["agentName"] = m_config.agentName;
    }

    if (!m_config.endpointUuid.empty())
    {
        message["licenseUuid"] = m_config.endpointUuid;
    }
    if (!m_config.customerId.empty())
    {
        message["customerId"] = m_config.customerId;
    }

    message["fingerprint"] = {
        {"hostname", getHostname()},
        {"cpuModel", getCpuModel()},
        {"macAddresses", json::array({"service-mode"})}
    };

    // Detect if display is available (for headless server detection)
    bool hasDisplay = false;
    try {
        auto displays = ScreenStream::getInstance().getDisplays();
        hasDisplay = !displays.empty();
    } catch (...) {
        // If we can't check displays, assume no display
        hasDisplay = false;
    }
    message["hasDisplay"] = hasDisplay;

    log("→ REGISTER: " + getHostname() + " (hasDisplay=" + (hasDisplay ? "true" : "false") + ")");
    sendWebSocketFrame(message.dump());
}

void WebSocketClient::sendHeartbeat()
{
    if (!m_connected) return;

    // Detect if display is available (for headless server detection)
    bool hasDisplay = false;
    try {
        auto displays = ScreenStream::getInstance().getDisplays();
        hasDisplay = !displays.empty();
    } catch (...) {
        hasDisplay = false;
    }

    json message;
    message["type"] = "heartbeat";
    message["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    message["powerState"] = "ACTIVE";
    message["isScreenLocked"] = isScreenLocked();
    message["hasDisplay"] = hasDisplay;

    sendWebSocketFrame(message.dump());
}

void WebSocketClient::startHeartbeat(int intervalMs)
{
    stopHeartbeat();
    m_heartbeatInterval = intervalMs;
    m_stopHeartbeat = false;

    m_heartbeatThread = std::thread([this]() {
        while (m_running && m_connected && !m_stopHeartbeat)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(m_heartbeatInterval));
            if (m_running && m_connected && !m_stopHeartbeat)
            {
                sendHeartbeat();
            }
        }
    });
}

void WebSocketClient::stopHeartbeat()
{
    m_stopHeartbeat = true;
    if (m_heartbeatThread.joinable())
    {
        m_heartbeatThread.join();
    }
}

void WebSocketClient::receiveLoop()
{
    std::vector<uint8_t> buffer(16384);
    int consecutiveErrors = 0;
    const int maxConsecutiveErrors = 3;

    while (m_running && m_connected)
    {
        int bytesRead = sslRead(reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()));

        if (bytesRead <= 0)
        {
            if (!m_running)
            {
                break;
            }

            // Get SSL error details
            int sslError = 0;
            if (m_ssl)
            {
                sslError = SSL_get_error(static_cast<SSL*>(m_ssl), bytesRead);
            }

            // Handle retryable errors
            if (sslError == SSL_ERROR_WANT_READ || sslError == SSL_ERROR_WANT_WRITE)
            {
                // These are not errors - just need to retry
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                consecutiveErrors = 0;
                continue;
            }

            // Log detailed error information
            std::string errorDetail;
            switch (sslError)
            {
                case SSL_ERROR_NONE:
                    errorDetail = "SSL_ERROR_NONE (clean close, bytes=" + std::to_string(bytesRead) + ")";
                    break;
                case SSL_ERROR_ZERO_RETURN:
                    errorDetail = "SSL_ERROR_ZERO_RETURN (peer closed connection)";
                    break;
                case SSL_ERROR_SYSCALL:
                    {
                        int sysErr = errno;
                        errorDetail = "SSL_ERROR_SYSCALL (errno=" + std::to_string(sysErr) + ": " + strerror(sysErr) + ")";
                    }
                    break;
                case SSL_ERROR_SSL:
                    {
                        unsigned long errCode = ERR_get_error();
                        char errBuf[256];
                        ERR_error_string_n(errCode, errBuf, sizeof(errBuf));
                        errorDetail = "SSL_ERROR_SSL (" + std::string(errBuf) + ")";
                    }
                    break;
                default:
                    errorDetail = "Unknown SSL error " + std::to_string(sslError);
            }

            log("Connection closed: " + errorDetail);

            // For syscall errors, check if it's a temporary issue
            if (sslError == SSL_ERROR_SYSCALL && errno == EAGAIN)
            {
                consecutiveErrors++;
                if (consecutiveErrors < maxConsecutiveErrors)
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                    continue;
                }
            }

            break;
        }

        // Reset error counter on successful read
        consecutiveErrors = 0;

        // Parse WebSocket frame
        if (bytesRead < 2) continue;

        uint8_t opcode = buffer[0] & 0x0F;
        bool masked = (buffer[1] & 0x80) != 0;
        uint64_t payloadLen = buffer[1] & 0x7F;

        size_t headerLen = 2;
        if (payloadLen == 126)
        {
            if (bytesRead < 4) continue;
            payloadLen = (static_cast<uint64_t>(buffer[2]) << 8) | buffer[3];
            headerLen = 4;
        }
        else if (payloadLen == 127)
        {
            if (bytesRead < 10) continue;
            payloadLen = 0;
            for (int i = 0; i < 8; i++)
            {
                payloadLen = (payloadLen << 8) | buffer[2 + i];
            }
            headerLen = 10;
        }

        size_t maskOffset = headerLen;
        if (masked)
        {
            headerLen += 4;
        }

        if (bytesRead < static_cast<int>(headerLen + payloadLen)) continue;

        std::string payload;
        payload.reserve(static_cast<size_t>(payloadLen));

        for (size_t i = 0; i < payloadLen; i++)
        {
            uint8_t byte = buffer[headerLen + i];
            if (masked)
            {
                byte ^= buffer[maskOffset + (i % 4)];
            }
            payload.push_back(static_cast<char>(byte));
        }

        if (opcode == 0x01) // Text frame
        {
            handleMessage(payload);
        }
        else if (opcode == 0x08) // Close frame
        {
            log("Received close frame");
            break;
        }
        else if (opcode == 0x09) // Ping
        {
            // Send pong (opcode 0x0A) - must be masked per RFC 6455
            std::vector<uint8_t> pongFrame;
            pongFrame.push_back(0x8A); // FIN + pong opcode
            pongFrame.push_back(0x80); // Mask bit + zero length
            // Masking key (required even for empty payload)
            std::random_device rd;
            std::mt19937 gen(rd());
            std::uniform_int_distribution<> dist(0, 255);
            for (int mi = 0; mi < 4; mi++)
            {
                pongFrame.push_back(static_cast<uint8_t>(dist(gen)));
            }
            sslWrite(reinterpret_cast<const char*>(pongFrame.data()), static_cast<int>(pongFrame.size()));
        }
    }

    m_connected = false;
    if (m_connectionCallback)
    {
        m_connectionCallback(false);
    }
}

void WebSocketClient::handleMessage(const std::string& message)
{
    try
    {
        json j = json::parse(message);
        std::string type = j.value("type", "");

        if (type == "registered")
        {
            handleRegistered(j);
        }
        else if (type == "heartbeat_ack")
        {
            handleHeartbeatAck(j);
        }
        else if (type == "request")
        {
            handleRequest(j);
        }
        else if (type == "relay_response")
        {
            handleRelayResponse(j);
        }
        else if (type == "error")
        {
            std::string errorCode = j.value("code", "unknown");
            std::string errorMsg = j.value("message", j.value("error", "Unknown error"));
            log("← ERROR: code=" + errorCode + ", message=" + errorMsg);
        }
        else if (type == "ping")
        {
            // Respond to application-level ping with pong
            json pong;
            pong["type"] = "pong";
            if (j.contains("timestamp"))
            {
                pong["timestamp"] = j["timestamp"];
            }
            sendWebSocketFrame(pong.dump());
        }
        else if (type == "config")
        {
            // Server config message - acknowledged silently
            // Could store config values if needed in the future
        }
        else
        {
            log("← Unknown message type: " + type);
        }
    }
    catch (const std::exception& e)
    {
        log("ERROR: Failed to parse message: " + std::string(e.what()));
    }
}

void WebSocketClient::handleRegistered(const json& j)
{
    m_licenseStatus = j.value("licenseStatus", "unknown");
    m_agentId = j.value("agentId", "");

    log("← REGISTERED: license=" + m_licenseStatus + ", agentId=" + m_agentId);

    if (m_statusCallback)
    {
        m_statusCallback(m_agentId, m_licenseStatus);
    }

    // Start heartbeat
    int interval = 5000;
    if (j.contains("config") && j["config"].contains("heartbeatInterval"))
    {
        interval = j["config"]["heartbeatInterval"];
    }
    startHeartbeat(interval);
}

void WebSocketClient::handleHeartbeatAck(const json& j)
{
    m_licenseStatus = j.value("licenseStatus", "unknown");

    if (m_statusCallback)
    {
        m_statusCallback(m_agentId, m_licenseStatus);
    }

    // Check for update flag (supports both "u" and "updateFlag" field names)
    // 0 = no update, 1 = update available, 2 = forced update
    int updateFlag = j.value("u", j.value("updateFlag", 0));
    if (m_heartbeatCallback)
    {
        m_heartbeatCallback(updateFlag);
    }

    // Check for browser preference (1.3.1)
    if (j.contains("defaultBrowser"))
    {
        std::string browser = j["defaultBrowser"];
        auto& config = Config::getInstance();
        if (!browser.empty() && config.getDefaultBrowser() != browser)
        {
            log("Updating default browser preference: " + browser);
            config.setDefaultBrowser(browser);
            config.save();
        }
    }

    // Handle server-controlled permissions
    if (j.contains("permissions"))
    {
        const auto& perms = j["permissions"];
        bool masterMode = perms.value("masterMode", false);
        bool fileTransfer = perms.value("fileTransfer", false);
        bool localSettingsLocked = perms.value("localSettingsLocked", false);

        // Check if any permission changed
        if (masterMode != m_masterModeEnabled.load() ||
            fileTransfer != m_fileTransferEnabled.load() ||
            localSettingsLocked != m_localSettingsLocked.load())
        {
            m_masterModeEnabled = masterMode;
            m_fileTransferEnabled = fileTransfer;
            m_localSettingsLocked = localSettingsLocked;

            log("Permissions updated: masterMode=" + std::string(masterMode ? "true" : "false") +
                ", fileTransfer=" + std::string(fileTransfer ? "true" : "false") +
                ", localSettingsLocked=" + std::string(localSettingsLocked ? "true" : "false"));

            if (m_permissionsCallback)
            {
                m_permissionsCallback(masterMode, fileTransfer, localSettingsLocked);
            }
        }
    }
}

void WebSocketClient::handleRequest(const json& j)
{
    std::string requestId = j.value("id", "");
    std::string method = j.value("method", "");
    json params = j.value("params", json::object());

    log("← REQUEST: " + method);

    if (m_commandCallback)
    {
        try
        {
            json result = m_commandCallback(method, params);
            sendResponse(requestId, result);
        }
        catch (const std::exception& e)
        {
            sendError(requestId, e.what());
        }
    }
    else
    {
        sendError(requestId, "No command handler registered");
    }
}

void WebSocketClient::handleRelayResponse(const json& j)
{
    std::string requestId = j.value("id", "");

    std::lock_guard<std::mutex> lock(m_relayMutex);
    auto it = m_relayCallbacks.find(requestId);
    if (it != m_relayCallbacks.end())
    {
        json result = j.value("result", json::object());
        it->second(result);
        m_relayCallbacks.erase(it);
    }
}

void WebSocketClient::sendResponse(const std::string& requestId, const json& result)
{
    json message;
    message["type"] = "response";
    message["id"] = requestId;
    message["result"] = result;

    log("→ RESPONSE: " + requestId);
    sendWebSocketFrame(message.dump());
}

void WebSocketClient::sendError(const std::string& requestId, const std::string& error)
{
    json message;
    message["type"] = "response";
    message["id"] = requestId;
    message["error"] = error;

    log("→ ERROR RESPONSE: " + requestId + " - " + error);
    sendWebSocketFrame(message.dump());
}

void WebSocketClient::relayCommand(const std::string& targetAgentId, const std::string& method,
                                    const json& params,
                                    std::function<void(const json&)> callback)
{
    // Generate request ID
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(0, 15);
    const char* hex = "0123456789abcdef";
    std::string requestId = "relay_";
    for (int i = 0; i < 16; i++)
    {
        requestId += hex[dist(gen)];
    }

    // Store callback
    {
        std::lock_guard<std::mutex> lock(m_relayMutex);
        m_relayCallbacks[requestId] = callback;
    }

    // Send relay request
    json message;
    message["type"] = "relay";
    message["id"] = requestId;
    message["targetAgentId"] = targetAgentId;
    message["method"] = method;
    message["params"] = params;

    log("→ RELAY: " + method + " -> " + targetAgentId);
    sendWebSocketFrame(message.dump());
}

// System info helpers
std::string WebSocketClient::getMachineId()
{
    return Config::getInstance().getMachineId();
}

std::string WebSocketClient::getCpuModel()
{
#if PLATFORM_MACOS
    char buffer[256] = "Unknown CPU";
    size_t size = sizeof(buffer);
    sysctlbyname("machdep.cpu.brand_string", buffer, &size, nullptr, 0);
    return buffer;
#elif PLATFORM_WINDOWS
    return "Unknown CPU";  // TODO: Use WMI
#else
    std::ifstream file("/proc/cpuinfo");
    std::string line;
    while (std::getline(file, line))
    {
        if (line.find("model name") != std::string::npos)
        {
            size_t pos = line.find(':');
            if (pos != std::string::npos)
            {
                return line.substr(pos + 2);
            }
        }
    }
    return "Unknown CPU";
#endif
}

std::string WebSocketClient::getHostname()
{
    char hostname[256];
#if PLATFORM_WINDOWS
    DWORD size = sizeof(hostname);
    if (GetComputerNameA(hostname, &size))
    {
        return hostname;
    }
#else
    if (gethostname(hostname, sizeof(hostname)) == 0)
    {
        return hostname;
    }
#endif
    return "unknown";
}

std::string WebSocketClient::getOsVersion()
{
#if PLATFORM_MACOS
    FILE* fp = popen("sw_vers -productVersion", "r");
    if (fp)
    {
        char buffer[64];
        if (fgets(buffer, sizeof(buffer), fp))
        {
            pclose(fp);
            std::string version(buffer);
            while (!version.empty() && (version.back() == '\n' || version.back() == '\r'))
            {
                version.pop_back();
            }
            return "macOS " + version;
        }
        pclose(fp);
    }
    return "macOS";
#elif PLATFORM_WINDOWS
    return "Windows";  // TODO: Get version
#else
    std::ifstream file("/etc/os-release");
    std::string line;
    while (std::getline(file, line))
    {
        if (line.find("PRETTY_NAME=") == 0)
        {
            std::string name = line.substr(12);
            if (!name.empty() && name[0] == '"')
            {
                name = name.substr(1, name.size() - 2);
            }
            return name;
        }
    }
    return "Linux";
#endif
}

bool WebSocketClient::isScreenLocked()
{
#if PLATFORM_MACOS
    // Check using CGSessionCopyCurrentDictionary
    // For now, return false (full implementation requires CoreGraphics)
    return false;
#elif PLATFORM_WINDOWS
    // TODO: Use OpenInputDesktop
    return false;
#else
    // Check for common screen lock processes
    FILE* fp = popen("pgrep -x 'gnome-screensaver|xscreensaver|i3lock|swaylock' 2>/dev/null", "r");
    if (fp)
    {
        char buf[16];
        bool locked = fgets(buf, sizeof(buf), fp) != nullptr;
        pclose(fp);
        return locked;
    }
    return false;
#endif
}

} // namespace ScreenControl
