/**
 * WebSocket Client for ScreenControl
 *
 * Connects to the control server via WebSocket for agent registration,
 * heartbeat, and command handling. Matches the macOS implementation.
 */

using System;
using System.Net.WebSockets;
using System.Reflection;
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

        // Server-controlled permissions
        public bool MasterModeEnabled { get; private set; }
        public bool FileTransferEnabled { get; private set; }
        public bool LocalSettingsLocked { get; private set; }

        // Events
        public event Action<string>? OnLog;
        public event Action<bool>? OnConnectionChanged;
        public event Action<string, string>? OnStatusChanged; // (agentId, licenseStatus)
        public event Action<string, string, string>? OnCommand; // (requestId, method, params)
        public event Action<bool, bool, bool>? OnPermissionsChanged; // (masterMode, fileTransfer, localSettingsLocked)

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
                agentVersion = GetAssemblyVersion(),
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

            // Handle permissions from heartbeat_ack
            if (root.TryGetProperty("permissions", out var perms))
            {
                var masterMode = perms.TryGetProperty("masterMode", out var mm) && mm.GetBoolean();
                var fileTransfer = perms.TryGetProperty("fileTransfer", out var ft) && ft.GetBoolean();
                var localSettingsLocked = perms.TryGetProperty("localSettingsLocked", out var lsl) && lsl.GetBoolean();

                // Check if any permission changed
                if (masterMode != MasterModeEnabled ||
                    fileTransfer != FileTransferEnabled ||
                    localSettingsLocked != LocalSettingsLocked)
                {
                    MasterModeEnabled = masterMode;
                    FileTransferEnabled = fileTransfer;
                    LocalSettingsLocked = localSettingsLocked;

                    Log($"Permissions updated: masterMode={masterMode}, fileTransfer={fileTransfer}, localSettingsLocked={localSettingsLocked}");
                    OnPermissionsChanged?.Invoke(masterMode, fileTransfer, localSettingsLocked);
                }
            }
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

            // Notify listeners
            OnCommand?.Invoke(requestId, method, paramsJson);

            // Forward command to local service and get actual result
            object result;
            try
            {
                result = await ForwardToLocalService(method, paramsJson);
                Log($"→ RESPONSE: {requestId} (success)");
            }
            catch (Exception ex)
            {
                result = new { success = false, error = ex.Message };
                Log($"→ RESPONSE: {requestId} (error: {ex.Message})");
            }

            var response = new
            {
                type = "response",
                id = requestId,
                result = result
            };

            var json = JsonSerializer.Serialize(response);
            await SendMessageAsync(json);
        }

        private async Task<object> ForwardToLocalService(string method, string paramsJson)
        {
            using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(30) };

            // Map MCP method to local service endpoint
            var endpoint = method switch
            {
                "shell_exec" => "/shell/exec",
                "shell_start_session" => "/shell/session/start",
                "shell_send_input" => "/shell/session/input",
                "shell_stop_session" => "/shell/session/stop",
                "fs_list" => "/fs/list",
                "fs_read" => "/fs/read",
                "fs_write" => "/fs/write",
                "fs_delete" => "/fs/delete",
                "fs_move" => "/fs/move",
                "fs_search" => "/fs/search",
                "fs_grep" => "/fs/grep",
                "screenshot" => "/screenshot",
                "screenshot_grid" => "/screenshot/grid",
                "click" => "/input/click",
                "click_grid" => "/input/click_grid",
                "typeText" => "/input/type",
                "pressKey" => "/input/key",
                "listApplications" => "/apps/list",
                "launchApplication" => "/apps/launch",
                "focusApplication" => "/apps/focus",
                _ => $"/{method.Replace("_", "/")}"
            };

            var content = new System.Net.Http.StringContent(paramsJson, Encoding.UTF8, "application/json");
            var response = await client.PostAsync($"http://127.0.0.1:3456{endpoint}", content);
            var responseJson = await response.Content.ReadAsStringAsync();

            // Parse and return the result
            return JsonSerializer.Deserialize<object>(responseJson) ?? new { success = false, error = "Empty response" };
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

        private static string GetAssemblyVersion()
        {
            try
            {
                // Use assembly version (same as tray menu)
                var version = Assembly.GetExecutingAssembly().GetName().Version;
                return version != null ? $"{version.Major}.{version.Minor}.{version.Build}" : "unknown";
            }
            catch
            {
                return "unknown";
            }
        }

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
