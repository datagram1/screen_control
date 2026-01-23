/**
 * WebSocket Client for ScreenControl
 *
 * Connects to the control server via WebSocket for agent registration,
 * heartbeat, and command handling. Matches the macOS implementation.
 */

using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Management;
using System.Net.NetworkInformation;

namespace ScreenControlTray
{
    public class DebugConfig
    {
        public string ServerUrl { get; set; } = "wss://screencontrol.knws.co.uk/ws";
        public string EndpointUuid { get; set; } = "";
        public string CustomerId { get; set; } = "";
        public bool ConnectOnStartup { get; set; } = false;
    }

    public class LockScreenCredentials
    {
        public string Username { get; set; } = "";
        public string EncryptedPassword { get; set; } = "";
    }

    public class WebSocketClient : IDisposable
    {
        private ClientWebSocket? _webSocket;
        private CancellationTokenSource? _cts;
        private System.Threading.Timer? _heartbeatTimer;
        private bool _isConnected;
        private bool _isDisposed;

        public bool IsConnected => _isConnected;
        public string? AgentId { get; private set; }
        public string? LicenseStatus { get; private set; }

        // Events
        public event Action<string>? OnLog;
        public event Action<bool>? OnConnectionChanged;
        public event Action<string, string>? OnStatusChanged; // (agentId, licenseStatus)
        public event Action<string, string, string>? OnCommand; // (requestId, method, params)

        public async Task ConnectAsync(DebugConfig config)
        {
            if (_isConnected || _isDisposed) return;

            try
            {
                Log($"Connecting to {config.ServerUrl}...");

                _cts = new CancellationTokenSource();
                _webSocket = new ClientWebSocket();

                var uri = new Uri(config.ServerUrl);
                await _webSocket.ConnectAsync(uri, _cts.Token);

                _isConnected = true;
                OnConnectionChanged?.Invoke(true);
                Log("WebSocket connected");

                // Send registration
                await SendRegistrationAsync(config);

                // Start receiving messages
                _ = ReceiveLoopAsync();
            }
            catch (Exception ex)
            {
                Log($"Connection failed: {ex.Message}");
                _isConnected = false;
                OnConnectionChanged?.Invoke(false);
            }
        }

        public async Task DisconnectAsync()
        {
            if (!_isConnected) return;

            try
            {
                Log("Disconnecting...");

                StopHeartbeat();
                _cts?.Cancel();

                if (_webSocket?.State == WebSocketState.Open)
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Disconnect", CancellationToken.None);
                }

                _isConnected = false;
                OnConnectionChanged?.Invoke(false);
                Log("Disconnected");
            }
            catch (Exception ex)
            {
                Log($"Disconnect error: {ex.Message}");
            }
            finally
            {
                _webSocket?.Dispose();
                _webSocket = null;
            }
        }

        private async Task SendRegistrationAsync(DebugConfig config)
        {
            var machineId = GetMachineId();
            var hostname = Environment.MachineName;
            var osVersion = Environment.OSVersion.VersionString;

            var message = new
            {
                type = "register",
                machineId = machineId,
                machineName = hostname,
                osType = "windows",
                osVersion = osVersion,
                arch = Environment.Is64BitOperatingSystem ? "x64" : "x86",
                agentVersion = "1.0.0-debug",
                licenseUuid = string.IsNullOrEmpty(config.EndpointUuid) ? null : config.EndpointUuid,
                customerId = string.IsNullOrEmpty(config.CustomerId) ? null : config.CustomerId,
                fingerprint = new
                {
                    hostname = hostname,
                    cpuModel = GetCpuModel(),
                    macAddresses = GetMacAddresses()
                }
            };

            var json = JsonSerializer.Serialize(message);
            Log($"→ REGISTER: {hostname}");
            await SendMessageAsync(json);
        }

        private async Task SendHeartbeatAsync()
        {
            if (!_isConnected || _webSocket?.State != WebSocketState.Open) return;

            try
            {
                var message = new
                {
                    type = "heartbeat",
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    powerState = "ACTIVE",
                    isScreenLocked = IsScreenLocked()
                };

                var json = JsonSerializer.Serialize(message);
                await SendMessageAsync(json);
                Log("→ HEARTBEAT");
            }
            catch (Exception ex)
            {
                Log($"Heartbeat error: {ex.Message}");
            }
        }

        private async Task SendMessageAsync(string message)
        {
            if (_webSocket?.State != WebSocketState.Open) return;

            var bytes = Encoding.UTF8.GetBytes(message);
            var segment = new ArraySegment<byte>(bytes);
            await _webSocket.SendAsync(segment, WebSocketMessageType.Text, true, _cts?.Token ?? CancellationToken.None);
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[8192];

            try
            {
                while (_isConnected && _webSocket?.State == WebSocketState.Open)
                {
                    var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), _cts?.Token ?? CancellationToken.None);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Log("Server closed connection");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        HandleMessage(message);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Expected when disconnecting
            }
            catch (Exception ex)
            {
                Log($"Receive error: {ex.Message}");
            }
            finally
            {
                _isConnected = false;
                OnConnectionChanged?.Invoke(false);
                StopHeartbeat();
            }
        }

        private void HandleMessage(string message)
        {
            try
            {
                using var doc = JsonDocument.Parse(message);
                var root = doc.RootElement;

                if (!root.TryGetProperty("type", out var typeProp))
                    return;

                var type = typeProp.GetString();

                switch (type)
                {
                    case "registered":
                        HandleRegistered(root);
                        break;
                    case "heartbeat_ack":
                        HandleHeartbeatAck(root);
                        break;
                    case "request":
                        HandleRequest(root);
                        break;
                    default:
                        Log($"← Unknown message type: {type}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Log($"Message parse error: {ex.Message}");
            }
        }

        private void HandleRegistered(JsonElement root)
        {
            var licenseStatus = root.TryGetProperty("licenseStatus", out var ls) ? ls.GetString() ?? "unknown" : "unknown";
            var agentId = root.TryGetProperty("agentId", out var ai) ? ai.GetString() ?? "" : "";

            AgentId = agentId;
            LicenseStatus = licenseStatus;

            Log($"← REGISTERED: license={licenseStatus}, agentId={agentId}");
            OnStatusChanged?.Invoke(agentId, licenseStatus);

            // Start heartbeat timer
            var heartbeatInterval = 5000;
            if (root.TryGetProperty("config", out var config) &&
                config.TryGetProperty("heartbeatInterval", out var hb))
            {
                heartbeatInterval = hb.GetInt32();
            }

            StartHeartbeat(heartbeatInterval);
        }

        private void HandleHeartbeatAck(JsonElement root)
        {
            var licenseStatus = root.TryGetProperty("licenseStatus", out var ls) ? ls.GetString() ?? "unknown" : "unknown";
            LicenseStatus = licenseStatus;
            OnStatusChanged?.Invoke(AgentId ?? "", licenseStatus);
        }

        private async void HandleRequest(JsonElement root)
        {
            if (!root.TryGetProperty("id", out var idProp) ||
                !root.TryGetProperty("method", out var methodProp))
                return;

            var requestId = idProp.GetString() ?? "";
            var method = methodProp.GetString() ?? "";
            var paramsJson = root.TryGetProperty("params", out var p) ? p.GetRawText() : "{}";

            Log($"← REQUEST: {method}");

            // Notify listeners (they can handle the command)
            OnCommand?.Invoke(requestId, method, paramsJson);

            // Send a basic response
            var response = new
            {
                type = "response",
                id = requestId,
                result = new { success = true, message = "Command received" }
            };

            var json = JsonSerializer.Serialize(response);
            await SendMessageAsync(json);
            Log($"→ RESPONSE: {requestId}");
        }

        private void StartHeartbeat(int intervalMs)
        {
            StopHeartbeat();
            _heartbeatTimer = new System.Threading.Timer(
                async _ => await SendHeartbeatAsync(),
                null,
                intervalMs,
                intervalMs
            );
        }

        private void StopHeartbeat()
        {
            _heartbeatTimer?.Dispose();
            _heartbeatTimer = null;
        }

        private void Log(string message)
        {
            var timestamp = DateTime.Now.ToString("HH:mm:ss");
            OnLog?.Invoke($"[{timestamp}] {message}");
        }

        // System information helpers

        private static string GetMachineId()
        {
            try
            {
                // Use BIOS serial number as machine ID
                using var searcher = new ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BIOS");
                foreach (ManagementObject mo in searcher.Get())
                {
                    var serial = mo["SerialNumber"]?.ToString();
                    if (!string.IsNullOrEmpty(serial))
                        return serial;
                }
            }
            catch { }

            // Fallback to machine name + domain
            return $"{Environment.MachineName}-{Environment.UserDomainName}";
        }

        private static string GetCpuModel()
        {
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT Name FROM Win32_Processor");
                foreach (ManagementObject mo in searcher.Get())
                {
                    return mo["Name"]?.ToString() ?? "Unknown CPU";
                }
            }
            catch { }

            return "Unknown CPU";
        }

        private static string[] GetMacAddresses()
        {
            try
            {
                return NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.OperationalStatus == OperationalStatus.Up &&
                               n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                    .Take(3)
                    .Select(n => n.GetPhysicalAddress().ToString())
                    .Where(m => !string.IsNullOrEmpty(m))
                    .ToArray();
            }
            catch
            {
                return new[] { "debug-mode" };
            }
        }

        private static bool IsScreenLocked()
        {
            // Check if workstation is locked (simplified)
            try
            {
                var process = System.Diagnostics.Process.GetProcessesByName("LogonUI");
                return process.Length > 0;
            }
            catch
            {
                return false;
            }
        }

        public void Dispose()
        {
            if (_isDisposed) return;
            _isDisposed = true;

            StopHeartbeat();
            _cts?.Cancel();
            _cts?.Dispose();
            _webSocket?.Dispose();
        }
    }
}
