/**
 * WebSocket Client Implementation for Windows
 *
 * Uses WinSock2 for socket communication.
 * For SSL/TLS, uses Windows Schannel.
 */

#include "websocket_client.h"
#include "../core/logger.h"

#if PLATFORM_WINDOWS

#include <winsock2.h>
#include <ws2tcpip.h>
#include <fstream>
#include <sstream>
#include <random>
#include <chrono>
#include <iomanip>

// Windows headers for system info
#include <windows.h>
#include <lmcons.h>

// __cpuid is x86-only, not available on ARM64
#if defined(_M_IX86) || defined(_M_X64)
#include <intrin.h>
#define HAS_CPUID 1
#else
#define HAS_CPUID 0
#endif

// Schannel for SSL
#define SECURITY_WIN32
#include <security.h>
#include <sspi.h>
#include <schannel.h>
#include <wincrypt.h>

// MSVC-specific pragma (ignored by MinGW which uses CMake link flags)
#ifdef _MSC_VER
#pragma comment(lib, "secur32.lib")
#pragma comment(lib, "crypt32.lib")
#endif

// MinGW compatibility
#ifndef min
#define min(a,b) ((a) < (b) ? (a) : (b))
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

// Base64 encode helper
static std::string base64Encode(const unsigned char* data, size_t len)
{
    static const char base64_chars[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string result;
    result.reserve(((len + 2) / 3) * 4);

    for (size_t i = 0; i < len; i += 3)
    {
        unsigned char b1 = data[i];
        unsigned char b2 = (i + 1 < len) ? data[i + 1] : 0;
        unsigned char b3 = (i + 2 < len) ? data[i + 2] : 0;

        result.push_back(base64_chars[b1 >> 2]);
        result.push_back(base64_chars[((b1 & 0x03) << 4) | (b2 >> 4)]);
        result.push_back((i + 1 < len) ? base64_chars[((b2 & 0x0F) << 2) | (b3 >> 6)] : '=');
        result.push_back((i + 2 < len) ? base64_chars[b3 & 0x3F] : '=');
    }

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
    // Initialize WinSock
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
    m_socket = reinterpret_cast<void*>(INVALID_SOCKET);
}

WebSocketClient::~WebSocketClient()
{
    disconnect();
    WSACleanup();
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
    struct tm timeinfo;
#ifdef _MSC_VER
    localtime_s(&timeinfo, &now);
#else
    // MinGW uses localtime
    struct tm* tmp = localtime(&now);
    if (tmp) timeinfo = *tmp;
#endif
    std::strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", &timeinfo);

    std::string fullMsg = "[" + std::string(timeBuf) + "] " + message;

    if (m_logCallback)
    {
        m_logCallback(fullMsg);
    }

    Logger::info("[WS] " + fullMsg);
}

bool WebSocketClient::connect(const ConnectionConfig& config)
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    if (m_connected) return true;

    m_config = config;
    m_serverUrl = config.serverUrl;
    log("Connecting to " + config.serverUrl + "...");

    // Parse URL
    std::string host, path;
    int port = 443;
    m_useSSL = true;

    std::string url = config.serverUrl;
    if (url.find("wss://") == 0)
    {
        url = url.substr(6);
        m_useSSL = true;
        port = 443;
    }
    else if (url.find("ws://") == 0)
    {
        url = url.substr(5);
        m_useSSL = false;
        port = 80;
    }

    size_t pathPos = url.find('/');
    if (pathPos != std::string::npos)
    {
        host = url.substr(0, pathPos);
        path = url.substr(pathPos);
    }
    else
    {
        host = url;
        path = "/";
    }

    size_t portPos = host.find(':');
    if (portPos != std::string::npos)
    {
        port = std::stoi(host.substr(portPos + 1));
        host = host.substr(0, portPos);
    }

    // Resolve hostname
    struct addrinfo hints = {}, *addrs;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    int err = getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &addrs);
    if (err != 0)
    {
        log("ERROR: Failed to resolve hostname");
        return false;
    }

    // Create socket
    sock = socket(addrs->ai_family, addrs->ai_socktype, addrs->ai_protocol);
    m_socket = reinterpret_cast<void*>(sock);
    if (sock == INVALID_SOCKET)
    {
        log("ERROR: Failed to create socket");
        freeaddrinfo(addrs);
        return false;
    }

    // Connect
    if (::connect(sock, addrs->ai_addr, static_cast<int>(addrs->ai_addrlen)) == SOCKET_ERROR)
    {
        log("ERROR: Failed to connect");
        closesocket(sock);
        m_socket = reinterpret_cast<void*>(INVALID_SOCKET);
        freeaddrinfo(addrs);
        return false;
    }

    freeaddrinfo(addrs);

    // Setup SSL if needed
    if (m_useSSL)
    {
        if (!sslConnect(host))
        {
            log("ERROR: SSL handshake failed");
            closesocket(sock);
            m_socket = reinterpret_cast<void*>(INVALID_SOCKET);
            return false;
        }
    }

    // WebSocket handshake
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
    int written = m_useSSL ? sslWrite(reqStr.c_str(), static_cast<int>(reqStr.size()))
                           : send(sock, reqStr.c_str(), static_cast<int>(reqStr.size()), 0);

    if (written <= 0)
    {
        log("ERROR: Failed to send WebSocket handshake");
        disconnect();
        return false;
    }

    // Read response
    char buffer[4096];
    int bytesRead = m_useSSL ? sslRead(buffer, sizeof(buffer) - 1)
                             : recv(sock, buffer, sizeof(buffer) - 1, 0);

    if (bytesRead <= 0)
    {
        log("ERROR: No response to WebSocket handshake");
        disconnect();
        return false;
    }

    buffer[bytesRead] = '\0';
    std::string response(buffer);

    if (response.find("101") == std::string::npos)
    {
        log("ERROR: WebSocket handshake rejected: " + response.substr(0, 100));
        disconnect();
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

bool WebSocketClient::reconnect()
{
    disconnect();
    std::this_thread::sleep_for(std::chrono::seconds(1));
    return connect(m_config);
}

void WebSocketClient::disconnect()
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    if (!m_connected && sock == INVALID_SOCKET) return;

    log("Disconnecting...");

    m_running = false;
    m_connected = false;
    stopHeartbeat();

    // Close socket to unblock recv
    if (sock != INVALID_SOCKET)
    {
        shutdown(sock, SD_BOTH);
    }

    if (m_receiveThread.joinable())
    {
        m_receiveThread.join();
    }

    if (m_useSSL)
    {
        sslDisconnect();
    }

    if (sock != INVALID_SOCKET)
    {
        closesocket(sock);
        m_socket = reinterpret_cast<void*>(INVALID_SOCKET);
    }

    if (m_connectionCallback)
    {
        m_connectionCallback(false);
    }

    log("Disconnected");
}

bool WebSocketClient::sendWebSocketFrame(const std::string& payload)
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    std::vector<uint8_t> frame;
    frame.push_back(0x81); // FIN + text opcode

    size_t len = payload.size();
    if (len <= 125)
    {
        frame.push_back(static_cast<uint8_t>(0x80 | len)); // Mask bit + length
    }
    else if (len <= 65535)
    {
        frame.push_back(0x80 | 126);
        frame.push_back(static_cast<uint8_t>((len >> 8) & 0xFF));
        frame.push_back(static_cast<uint8_t>(len & 0xFF));
    }
    else
    {
        frame.push_back(0x80 | 127);
        for (int i = 7; i >= 0; i--)
        {
            frame.push_back(static_cast<uint8_t>((len >> (i * 8)) & 0xFF));
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
    int sent = m_useSSL ? sslWrite(reinterpret_cast<const char*>(frame.data()), static_cast<int>(frame.size()))
                        : send(sock, reinterpret_cast<const char*>(frame.data()), static_cast<int>(frame.size()), 0);

    return sent > 0;
}

void WebSocketClient::sendRegistration()
{
    json message;
    message["type"] = "register";
    message["machineId"] = getMachineId();
    message["machineName"] = getHostname();
    message["osType"] = "windows";
    message["osVersion"] = getOsVersion();

#if defined(_M_X64) || defined(__x86_64__)
    message["arch"] = "x64";
#elif defined(_M_ARM64)
    message["arch"] = "arm64";
#else
    message["arch"] = "x86";
#endif

    message["agentVersion"] = "2.0.2";

    if (!m_config.endpointUuid.empty())
    {
        message["licenseUuid"] = m_config.endpointUuid;
    }
    if (!m_config.customerId.empty())
    {
        message["customerId"] = m_config.customerId;
    }
    if (!m_config.agentName.empty())
    {
        message["agentName"] = m_config.agentName;
    }

    message["fingerprint"] = {
        {"hostname", getHostname()},
        {"cpuModel", getCpuModel()},
        {"macAddresses", json::array({"windows-agent"})}
    };

    log("-> REGISTER: " + getHostname());

    sendWebSocketFrame(message.dump());
}

void WebSocketClient::sendHeartbeat()
{
    if (!m_connected) return;

    json message;
    message["type"] = "heartbeat";
    message["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    message["powerState"] = "ACTIVE";
    message["isScreenLocked"] = isScreenLocked();

    sendWebSocketFrame(message.dump());
    log("-> HEARTBEAT");
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
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    std::vector<uint8_t> buffer(8192);

    while (m_running && m_connected)
    {
        int bytesRead = m_useSSL ? sslRead(reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()))
                                  : recv(sock, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);

        if (bytesRead <= 0)
        {
            if (m_running)
            {
                log("Connection closed by server");
            }
            break;
        }

        // Parse WebSocket frame
        if (bytesRead < 2) continue;

        uint8_t opcode = buffer[0] & 0x0F;
        bool masked = (buffer[1] & 0x80) != 0;
        uint64_t payloadLen = buffer[1] & 0x7F;

        size_t headerLen = 2;
        if (payloadLen == 126)
        {
            if (bytesRead < 4) continue;
            payloadLen = (buffer[2] << 8) | buffer[3];
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
            log("<- PING (responding with pong)");
            // Send pong with same payload
            std::vector<uint8_t> pongFrame;
            pongFrame.push_back(0x8A); // FIN + pong opcode
            pongFrame.push_back(0x80); // Mask bit + 0 length

            // Masking key
            uint8_t mask[4] = {0, 0, 0, 0};
            for (int i = 0; i < 4; i++)
            {
                pongFrame.push_back(mask[i]);
            }

            std::lock_guard<std::mutex> lock(m_sendMutex);
            if (m_useSSL)
            {
                sslWrite(reinterpret_cast<const char*>(pongFrame.data()), static_cast<int>(pongFrame.size()));
            }
            else
            {
                send(sock, reinterpret_cast<const char*>(pongFrame.data()), static_cast<int>(pongFrame.size()), 0);
            }
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
        log("<- RAW MSG: " + message.substr(0, 200));

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
            log("<- ERROR: code=" + errorCode + ", message=" + errorMsg);
        }
        else if (type == "ping")
        {
            // Server ping - respond with pong
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
        }
        else
        {
            log("<- Unknown message type: " + type);
        }
    }
    catch (const std::exception& e)
    {
        log("ERROR: Failed to parse message: " + std::string(e.what()));
    }
}

void WebSocketClient::handleRegistered(const nlohmann::json& j)
{
    m_licenseStatus = j.value("licenseStatus", "unknown");
    m_agentId = j.value("agentId", "");

    log("<- REGISTERED: license=" + m_licenseStatus + ", agentId=" + m_agentId);

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

void WebSocketClient::handleHeartbeatAck(const nlohmann::json& j)
{
    m_licenseStatus = j.value("licenseStatus", "unknown");

    if (m_statusCallback)
    {
        m_statusCallback(m_agentId, m_licenseStatus);
    }
}

void WebSocketClient::handleRequest(const nlohmann::json& j)
{
    std::string requestId = j.value("id", "");
    std::string method = j.value("method", "");
    nlohmann::json params = j.contains("params") ? j["params"] : nlohmann::json::object();

    log("<- REQUEST: " + method + " (id=" + requestId + ")");

    if (m_commandCallback)
    {
        try
        {
            nlohmann::json result = m_commandCallback(method, params);
            sendResponse(requestId, result);
        }
        catch (const std::exception& e)
        {
            sendError(requestId, e.what());
        }
    }
}

void WebSocketClient::handleRelayResponse(const nlohmann::json& j)
{
    std::string requestId = j.value("id", "");

    std::lock_guard<std::mutex> lock(m_relayMutex);
    auto it = m_relayCallbacks.find(requestId);
    if (it != m_relayCallbacks.end())
    {
        it->second(j.contains("result") ? j["result"] : j);
        m_relayCallbacks.erase(it);
    }
}

void WebSocketClient::sendResponse(const std::string& requestId, const nlohmann::json& result)
{
    json message;
    message["type"] = "response";
    message["id"] = requestId;
    message["result"] = result;

    sendWebSocketFrame(message.dump());
    log("-> RESPONSE: " + requestId);
}

void WebSocketClient::sendError(const std::string& requestId, const std::string& error)
{
    json message;
    message["type"] = "response";
    message["id"] = requestId;
    message["error"] = error;

    sendWebSocketFrame(message.dump());
    log("-> ERROR RESPONSE: " + requestId + " - " + error);
}

void WebSocketClient::relayCommand(const std::string& targetAgentId, const std::string& method,
                                   const nlohmann::json& params,
                                   std::function<void(const nlohmann::json&)> callback)
{
    // Generate request ID
    std::string requestId = "relay_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    if (callback)
    {
        std::lock_guard<std::mutex> lock(m_relayMutex);
        m_relayCallbacks[requestId] = callback;
    }

    json message;
    message["type"] = "relay";
    message["id"] = requestId;
    message["targetAgentId"] = targetAgentId;
    message["method"] = method;
    message["params"] = params;

    sendWebSocketFrame(message.dump());
    log("-> RELAY to " + targetAgentId + ": " + method);
}

// Windows-specific system info
std::string WebSocketClient::getMachineId()
{
    // Use Windows machine GUID
    HKEY hKey;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", 0, KEY_READ | KEY_WOW64_64KEY, &hKey) == ERROR_SUCCESS)
    {
        char guid[256] = { 0 };
        DWORD size = sizeof(guid);
        if (RegQueryValueExA(hKey, "MachineGuid", nullptr, nullptr, reinterpret_cast<LPBYTE>(guid), &size) == ERROR_SUCCESS)
        {
            RegCloseKey(hKey);
            return std::string(guid);
        }
        RegCloseKey(hKey);
    }

    // Fallback to hostname
    return getHostname();
}

std::string WebSocketClient::getCpuModel()
{
#if HAS_CPUID
    int cpuInfo[4] = { 0 };
    char brand[49] = { 0 };

    __cpuid(cpuInfo, 0x80000000);
    unsigned int nExIds = cpuInfo[0];

    if (nExIds >= 0x80000004)
    {
        __cpuid(cpuInfo, 0x80000002);
        memcpy(brand, cpuInfo, sizeof(cpuInfo));
        __cpuid(cpuInfo, 0x80000003);
        memcpy(brand + 16, cpuInfo, sizeof(cpuInfo));
        __cpuid(cpuInfo, 0x80000004);
        memcpy(brand + 32, cpuInfo, sizeof(cpuInfo));
    }

    std::string result(brand);
    size_t start = result.find_first_not_of(" ");
    size_t end = result.find_last_not_of(" ");
    if (start != std::string::npos && end != std::string::npos)
    {
        return result.substr(start, end - start + 1);
    }

    return result.empty() ? "Unknown CPU" : result;
#else
    // ARM64: Use registry to get processor name
    HKEY hKey;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
        L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
        0, KEY_READ, &hKey) == ERROR_SUCCESS)
    {
        wchar_t procName[256] = { 0 };
        DWORD size = sizeof(procName);
        if (RegQueryValueExW(hKey, L"ProcessorNameString", nullptr, nullptr,
            reinterpret_cast<LPBYTE>(procName), &size) == ERROR_SUCCESS)
        {
            RegCloseKey(hKey);
            int utf8Size = WideCharToMultiByte(CP_UTF8, 0, procName, -1, nullptr, 0, nullptr, nullptr);
            std::string result(utf8Size - 1, '\0');
            WideCharToMultiByte(CP_UTF8, 0, procName, -1, &result[0], utf8Size, nullptr, nullptr);
            return result;
        }
        RegCloseKey(hKey);
    }
    return "ARM64 Processor";
#endif
}

std::string WebSocketClient::getHostname()
{
    char hostname[256] = { 0 };
    DWORD size = sizeof(hostname);
    GetComputerNameA(hostname, &size);
    return std::string(hostname);
}

std::string WebSocketClient::getOsVersion()
{
    typedef LONG(WINAPI* RtlGetVersionPtr)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll)
    {
        RtlGetVersionPtr rtlGetVersion = reinterpret_cast<RtlGetVersionPtr>(GetProcAddress(ntdll, "RtlGetVersion"));
        if (rtlGetVersion)
        {
            RTL_OSVERSIONINFOW rovi = { sizeof(rovi) };
            if (rtlGetVersion(&rovi) == 0)
            {
                std::ostringstream oss;
                if (rovi.dwMajorVersion == 10 && rovi.dwBuildNumber >= 22000)
                    oss << "Windows 11";
                else if (rovi.dwMajorVersion == 10)
                    oss << "Windows 10";
                else
                    oss << "Windows " << rovi.dwMajorVersion;

                oss << " (" << rovi.dwBuildNumber << ")";
                return oss.str();
            }
        }
    }
    return "Windows";
}

bool WebSocketClient::isScreenLocked()
{
    // Always return false - the service handles all commands regardless of
    // screen lock state. The Credential Provider (ScreenControlCP.dll) handles
    // unlocking the screen when needed via stored credentials.
    //
    // Note: The previous implementation using OpenInputDesktop() was unreliable
    // for services running as LocalSystem (always returned true/locked).
    return false;
}

// Stub methods not used on Windows
bool WebSocketClient::parseUrl(const std::string& url, std::string& host, std::string& path, int& port, bool& useSSL)
{
    return false; // URL parsing done inline in connect()
}

bool WebSocketClient::tcpConnect(const std::string& host, int port)
{
    return false; // TCP connect done inline in connect()
}

bool WebSocketClient::websocketHandshake(const std::string& host, const std::string& path)
{
    return false; // Handshake done inline in connect()
}

// SSL/TLS implementation using Schannel
bool WebSocketClient::sslConnect(const std::string& host)
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    log("WARNING: SSL support using Schannel - basic implementation");

    SCHANNEL_CRED schannelCred = { 0 };
    schannelCred.dwVersion = SCHANNEL_CRED_VERSION;
    schannelCred.grbitEnabledProtocols = SP_PROT_TLS1_2_CLIENT | SP_PROT_TLS1_3_CLIENT;
    schannelCred.dwFlags = SCH_CRED_AUTO_CRED_VALIDATION | SCH_CRED_NO_DEFAULT_CREDS;

    CredHandle* pCredHandle = new CredHandle();
    m_sslCtx = pCredHandle;

    SECURITY_STATUS status = AcquireCredentialsHandleA(
        nullptr,
        const_cast<SEC_CHAR*>(UNISP_NAME_A),
        SECPKG_CRED_OUTBOUND,
        nullptr,
        &schannelCred,
        nullptr,
        nullptr,
        pCredHandle,
        nullptr
    );

    if (status != SEC_E_OK)
    {
        log("ERROR: AcquireCredentialsHandle failed: " + std::to_string(status));
        delete pCredHandle;
        m_sslCtx = nullptr;
        return false;
    }

    // Initialize security context
    SecBuffer outBuffers[1];
    outBuffers[0].pvBuffer = nullptr;
    outBuffers[0].BufferType = SECBUFFER_TOKEN;
    outBuffers[0].cbBuffer = 0;

    SecBufferDesc outBufferDesc;
    outBufferDesc.cBuffers = 1;
    outBufferDesc.pBuffers = outBuffers;
    outBufferDesc.ulVersion = SECBUFFER_VERSION;

    CtxtHandle* pCtxtHandle = new CtxtHandle();
    m_ssl = pCtxtHandle;

    DWORD contextAttr;
    status = InitializeSecurityContextA(
        pCredHandle,
        nullptr,
        const_cast<SEC_CHAR*>(host.c_str()),
        ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY |
        ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM,
        0,
        SECURITY_NATIVE_DREP,
        nullptr,
        0,
        pCtxtHandle,
        &outBufferDesc,
        &contextAttr,
        nullptr
    );

    if (status != SEC_I_CONTINUE_NEEDED && status != SEC_E_OK)
    {
        log("ERROR: InitializeSecurityContext failed: " + std::to_string(status));
        FreeCredentialsHandle(pCredHandle);
        delete pCredHandle;
        delete pCtxtHandle;
        m_sslCtx = nullptr;
        m_ssl = nullptr;
        return false;
    }

    // Send initial token
    if (outBuffers[0].cbBuffer > 0 && outBuffers[0].pvBuffer != nullptr)
    {
        int sent = send(sock, static_cast<char*>(outBuffers[0].pvBuffer), outBuffers[0].cbBuffer, 0);
        FreeContextBuffer(outBuffers[0].pvBuffer);

        if (sent <= 0)
        {
            log("ERROR: Failed to send SSL handshake");
            return false;
        }
    }

    // Complete handshake loop
    while (status == SEC_I_CONTINUE_NEEDED || status == SEC_E_INCOMPLETE_MESSAGE)
    {
        char recvBuffer[16384];
        int bytesRead = recv(sock, recvBuffer, sizeof(recvBuffer), 0);
        if (bytesRead <= 0)
        {
            log("ERROR: SSL handshake recv failed");
            return false;
        }

        SecBuffer inBuffers[2];
        inBuffers[0].pvBuffer = recvBuffer;
        inBuffers[0].cbBuffer = bytesRead;
        inBuffers[0].BufferType = SECBUFFER_TOKEN;
        inBuffers[1].pvBuffer = nullptr;
        inBuffers[1].cbBuffer = 0;
        inBuffers[1].BufferType = SECBUFFER_EMPTY;

        SecBufferDesc inBufferDesc;
        inBufferDesc.cBuffers = 2;
        inBufferDesc.pBuffers = inBuffers;
        inBufferDesc.ulVersion = SECBUFFER_VERSION;

        outBuffers[0].pvBuffer = nullptr;
        outBuffers[0].BufferType = SECBUFFER_TOKEN;
        outBuffers[0].cbBuffer = 0;

        status = InitializeSecurityContextA(
            pCredHandle,
            pCtxtHandle,
            nullptr,
            ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY |
            ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM,
            0,
            SECURITY_NATIVE_DREP,
            &inBufferDesc,
            0,
            pCtxtHandle,
            &outBufferDesc,
            &contextAttr,
            nullptr
        );

        if (outBuffers[0].cbBuffer > 0 && outBuffers[0].pvBuffer != nullptr)
        {
            send(sock, static_cast<char*>(outBuffers[0].pvBuffer), outBuffers[0].cbBuffer, 0);
            FreeContextBuffer(outBuffers[0].pvBuffer);
        }
    }

    if (status != SEC_E_OK)
    {
        log("ERROR: SSL handshake failed with status: " + std::to_string(status));
        return false;
    }

    log("SSL handshake completed");
    return true;
}

int WebSocketClient::sslRead(char* buffer, int length)
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    if (!m_ssl) return recv(sock, buffer, length, 0);

    CtxtHandle* pCtxtHandle = static_cast<CtxtHandle*>(m_ssl);

    // Read encrypted data
    char encryptedBuffer[16384];
    int bytesRead = recv(sock, encryptedBuffer, sizeof(encryptedBuffer), 0);
    if (bytesRead <= 0) return bytesRead;

    SecBuffer secBuffers[4];
    secBuffers[0].pvBuffer = encryptedBuffer;
    secBuffers[0].cbBuffer = bytesRead;
    secBuffers[0].BufferType = SECBUFFER_DATA;
    secBuffers[1].BufferType = SECBUFFER_EMPTY;
    secBuffers[2].BufferType = SECBUFFER_EMPTY;
    secBuffers[3].BufferType = SECBUFFER_EMPTY;

    SecBufferDesc secBufferDesc;
    secBufferDesc.cBuffers = 4;
    secBufferDesc.pBuffers = secBuffers;
    secBufferDesc.ulVersion = SECBUFFER_VERSION;

    SECURITY_STATUS status = DecryptMessage(pCtxtHandle, &secBufferDesc, 0, nullptr);

    if (status != SEC_E_OK)
    {
        return -1;
    }

    // Find decrypted data buffer
    for (int i = 0; i < 4; i++)
    {
        if (secBuffers[i].BufferType == SECBUFFER_DATA)
        {
            int copyLen = min(length, static_cast<int>(secBuffers[i].cbBuffer));
            memcpy(buffer, secBuffers[i].pvBuffer, copyLen);
            return copyLen;
        }
    }

    return 0;
}

int WebSocketClient::sslWrite(const char* data, int length)
{
    SOCKET sock = reinterpret_cast<SOCKET>(m_socket);
    if (!m_ssl) return send(sock, data, length, 0);

    CtxtHandle* pCtxtHandle = static_cast<CtxtHandle*>(m_ssl);

    // Get stream sizes
    SecPkgContext_StreamSizes streamSizes;
    SECURITY_STATUS status = QueryContextAttributesA(pCtxtHandle, SECPKG_ATTR_STREAM_SIZES, &streamSizes);
    if (status != SEC_E_OK) return -1;

    // Allocate buffer for encrypted message
    std::vector<char> encryptedBuffer(streamSizes.cbHeader + length + streamSizes.cbTrailer);

    // Setup buffers
    SecBuffer secBuffers[4];
    secBuffers[0].pvBuffer = encryptedBuffer.data();
    secBuffers[0].cbBuffer = streamSizes.cbHeader;
    secBuffers[0].BufferType = SECBUFFER_STREAM_HEADER;

    secBuffers[1].pvBuffer = encryptedBuffer.data() + streamSizes.cbHeader;
    secBuffers[1].cbBuffer = length;
    secBuffers[1].BufferType = SECBUFFER_DATA;
    memcpy(secBuffers[1].pvBuffer, data, length);

    secBuffers[2].pvBuffer = encryptedBuffer.data() + streamSizes.cbHeader + length;
    secBuffers[2].cbBuffer = streamSizes.cbTrailer;
    secBuffers[2].BufferType = SECBUFFER_STREAM_TRAILER;

    secBuffers[3].BufferType = SECBUFFER_EMPTY;

    SecBufferDesc secBufferDesc;
    secBufferDesc.cBuffers = 4;
    secBufferDesc.pBuffers = secBuffers;
    secBufferDesc.ulVersion = SECBUFFER_VERSION;

    status = EncryptMessage(pCtxtHandle, 0, &secBufferDesc, 0);
    if (status != SEC_E_OK) return -1;

    int totalSize = secBuffers[0].cbBuffer + secBuffers[1].cbBuffer + secBuffers[2].cbBuffer;
    return send(sock, encryptedBuffer.data(), totalSize, 0) > 0 ? length : -1;
}

void WebSocketClient::sslDisconnect()
{
    if (m_ssl)
    {
        CtxtHandle* pCtxtHandle = static_cast<CtxtHandle*>(m_ssl);
        DeleteSecurityContext(pCtxtHandle);
        delete pCtxtHandle;
        m_ssl = nullptr;
    }

    if (m_sslCtx)
    {
        CredHandle* pCredHandle = static_cast<CredHandle*>(m_sslCtx);
        FreeCredentialsHandle(pCredHandle);
        delete pCredHandle;
        m_sslCtx = nullptr;
    }
}

} // namespace ScreenControl

#endif // PLATFORM_WINDOWS
