/**
 * Settings Form
 *
 * WinForms UI for service configuration, license management, and debug mode.
 */

using System;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows.Forms;
using System.Threading.Tasks;

namespace ScreenControlTray
{
    public class SettingsForm : Form
    {
        private readonly ServiceClient _serviceClient;

        // Tabs - initialized in InitializeComponent()
        private TabControl _tabControl = null!;

        // Status tab - initialized in InitializeStatusTab()
        private Label _statusLabel = null!;
        private Label _versionLabel = null!;
        private Label _machineIdLabel = null!;
        private Button _copyMachineIdButton = null!;

        // License tab - initialized in InitializeLicenseTab()
        private Label _licenseStatusLabel = null!;
        private TextBox _licenseKeyTextBox = null!;
        private Button _activateButton = null!;
        private Button _deactivateButton = null!;
        private Label _expiryLabel = null!;

        // Settings tab - initialized in InitializeSettingsTab()
        private TextBox _controlServerUrlTextBox = null!;
        private NumericUpDown _portNumeric = null!;
        private CheckBox _autoStartCheckBox = null!;
        private CheckBox _loggingCheckBox = null!;
        private Button _saveButton = null!;

        // Lock screen credentials - initialized in InitializeSettingsTab()
        private TextBox _lockScreenUsernameTextBox = null!;
        private TextBox _lockScreenPasswordTextBox = null!;
        private Button _saveCredentialsButton = null!;

        // Debug tab - initialized in InitializeDebugTab()
        private TextBox _debugServerUrlTextBox = null!;
        private TextBox _debugEndpointUuidTextBox = null!;
        private TextBox _debugCustomerIdTextBox = null!;
        private CheckBox _debugConnectOnStartupCheckBox = null!;
        private Button _debugConnectButton = null!;
        private Button _debugDisconnectButton = null!;
        private Button _debugSaveSettingsButton = null!;
        private Button _debugCopyMcpUrlButton = null!;
        private Label _debugConnectionStatusLabel = null!;
        private Label _debugLicenseStatusLabel = null!;
        private Label _debugAgentIdLabel = null!;
        private TextBox _debugLogTextBox = null!;
        private WebSocketClient? _webSocketClient;

        // Tools tab - initialized in InitializeToolsTab()
        private Panel _toolsPanel = null!;
        private Dictionary<string, Dictionary<string, bool>> _toolsConfig;
        private Dictionary<string, CheckBox> _categoryCheckboxes = new();
        private Dictionary<string, Dictionary<string, CheckBox>> _toolCheckboxes = new();
        private bool _suppressCheckboxEvents;

        // Local settings locked state (managed by server)
        private bool _localSettingsLocked;
        private Label? _lockedStatusLabel;

        // Tool definitions - matches macOS implementation
        private static readonly Dictionary<string, (string Name, string[] Tools)> ToolCategories = new()
        {
            ["gui"] = ("GUI & Accessibility", new[]
            {
                "listApplications", "focusApplication", "launchApplication", "screenshot",
                "screenshot_app", "click", "click_absolute", "doubleClick", "clickElement",
                "moveMouse", "scroll", "scrollMouse", "drag", "getClickableElements",
                "getUIElements", "getMousePosition", "typeText", "pressKey", "analyzeWithOCR",
                "checkPermissions", "closeApp", "wait", "system_info", "window_list",
                "clipboard_read", "clipboard_write"
            }),
            ["browser"] = ("Browser Automation", new[]
            {
                "browser_listConnected", "browser_setDefaultBrowser", "browser_getTabs",
                "browser_getActiveTab", "browser_focusTab", "browser_createTab", "browser_closeTab",
                "browser_getPageInfo", "browser_inspectCurrentPage", "browser_getInteractiveElements",
                "browser_getPageContext", "browser_clickElement", "browser_fillElement",
                "browser_fillFormField", "browser_fillWithFallback", "browser_fillFormNative",
                "browser_scrollTo", "browser_executeScript", "browser_getFormData",
                "browser_setWatchMode", "browser_getVisibleText", "browser_searchVisibleText",
                "browser_getUIElements", "browser_waitForSelector", "browser_waitForPageLoad",
                "browser_selectOption", "browser_isElementVisible", "browser_getConsoleLogs",
                "browser_getNetworkRequests", "browser_getLocalStorage", "browser_getCookies",
                "browser_clickByText", "browser_clickMultiple", "browser_getFormStructure",
                "browser_answerQuestions", "browser_getDropdownOptions", "browser_openDropdownNative",
                "browser_listInteractiveElements", "browser_clickElementWithDebug",
                "browser_findElementWithDebug", "browser_findTabByUrl", "browser_navigate",
                "browser_screenshot", "browser_go_back", "browser_go_forward",
                "browser_get_visible_html", "browser_hover", "browser_drag", "browser_press_key",
                "browser_upload_file", "browser_save_as_pdf"
            }),
            ["filesystem"] = ("File System", new[]
            {
                "fs_list", "fs_read", "fs_read_range", "fs_write", "fs_delete",
                "fs_move", "fs_search", "fs_grep", "fs_patch"
            }),
            ["shell"] = ("Shell Commands", new[]
            {
                "shell_exec", "shell_start_session", "shell_send_input", "shell_stop_session"
            })
        };

        public SettingsForm(ServiceClient serviceClient)
        {
            _serviceClient = serviceClient;
            _toolsConfig = new Dictionary<string, Dictionary<string, bool>>();
            LoadToolsConfig();  // Load config BEFORE UI so defaults are ready
            InitializeComponent();
            LoadDebugConfig();
            _ = LoadDataAsync();

            // Auto-connect if enabled in settings
            Load += OnFormLoad;
        }

        private async void OnFormLoad(object? sender, EventArgs e)
        {
            // Check if auto-connect is enabled
            if (_debugConnectOnStartupCheckBox.Checked)
            {
                DebugLog("Auto-connect enabled, connecting...");
                // Small delay to ensure form is fully loaded
                await Task.Delay(500);
                OnDebugConnectClick(null, EventArgs.Empty);
            }
        }

        private void InitializeComponent()
        {
            Text = "ScreenControl Settings";
            Size = new Size(500, 550);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            _tabControl = new TabControl
            {
                Dock = DockStyle.Fill,
                Padding = new Point(10, 5)
            };

            // Status Tab
            var statusTab = new TabPage("Status");
            InitializeStatusTab(statusTab);
            _tabControl.TabPages.Add(statusTab);

            // License Tab
            var licenseTab = new TabPage("License");
            InitializeLicenseTab(licenseTab);
            _tabControl.TabPages.Add(licenseTab);

            // Settings Tab
            var settingsTab = new TabPage("Settings");
            InitializeSettingsTab(settingsTab);
            _tabControl.TabPages.Add(settingsTab);

            // Tools Tab
            var toolsTab = new TabPage("Tools");
            InitializeToolsTab(toolsTab);
            _tabControl.TabPages.Add(toolsTab);

            // Debug Tab
            var debugTab = new TabPage("Debug");
            InitializeDebugTab(debugTab);
            _tabControl.TabPages.Add(debugTab);

            Controls.Add(_tabControl);
        }

        private void InitializeStatusTab(TabPage tab)
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 4,
                Padding = new Padding(20)
            };

            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            // Status row
            panel.Controls.Add(new Label { Text = "Service Status:", AutoSize = true }, 0, 0);
            _statusLabel = new Label { Text = "Checking...", AutoSize = true, ForeColor = Color.Gray };
            panel.Controls.Add(_statusLabel, 1, 0);

            // Version row
            panel.Controls.Add(new Label { Text = "Version:", AutoSize = true }, 0, 1);
            _versionLabel = new Label { Text = "-", AutoSize = true };
            panel.Controls.Add(_versionLabel, 1, 1);

            // Machine ID row
            panel.Controls.Add(new Label { Text = "Machine ID:", AutoSize = true }, 0, 2);

            var machineIdPanel = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
            _machineIdLabel = new Label { Text = "-", AutoSize = true };
            _copyMachineIdButton = new Button { Text = "Copy", Size = new Size(50, 23), Margin = new Padding(5, 0, 0, 0) };
            _copyMachineIdButton.Click += OnCopyMachineIdClick;
            machineIdPanel.Controls.Add(_machineIdLabel);
            machineIdPanel.Controls.Add(_copyMachineIdButton);
            panel.Controls.Add(machineIdPanel, 1, 2);

            // Refresh button
            var refreshButton = new Button { Text = "Refresh", Size = new Size(80, 30) };
            refreshButton.Click += async (s, e) => await LoadDataAsync();
            panel.Controls.Add(refreshButton, 1, 3);

            tab.Controls.Add(panel);
        }

        private void InitializeLicenseTab(TabPage tab)
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 5,
                Padding = new Padding(20)
            };

            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            // License status
            panel.Controls.Add(new Label { Text = "License Status:", AutoSize = true }, 0, 0);
            _licenseStatusLabel = new Label { Text = "Checking...", AutoSize = true };
            panel.Controls.Add(_licenseStatusLabel, 1, 0);

            // Expiry
            panel.Controls.Add(new Label { Text = "Expires:", AutoSize = true }, 0, 1);
            _expiryLabel = new Label { Text = "-", AutoSize = true };
            panel.Controls.Add(_expiryLabel, 1, 1);

            // License key input
            panel.Controls.Add(new Label { Text = "License Key:", AutoSize = true }, 0, 2);
            _licenseKeyTextBox = new TextBox { Width = 250 };
            panel.Controls.Add(_licenseKeyTextBox, 1, 2);

            // Buttons
            var buttonPanel = new FlowLayoutPanel { AutoSize = true };
            _activateButton = new Button { Text = "Activate", Size = new Size(80, 30) };
            _activateButton.Click += OnActivateClick;
            _deactivateButton = new Button { Text = "Deactivate", Size = new Size(80, 30), Margin = new Padding(10, 0, 0, 0) };
            _deactivateButton.Click += OnDeactivateClick;
            buttonPanel.Controls.Add(_activateButton);
            buttonPanel.Controls.Add(_deactivateButton);
            panel.Controls.Add(buttonPanel, 1, 3);

            tab.Controls.Add(panel);
        }

        private void InitializeSettingsTab(TabPage tab)
        {
            var mainPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                Padding = new Padding(10)
            };

            mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            // Service Settings Group
            var serviceGroup = new GroupBox
            {
                Text = "Service Settings",
                Dock = DockStyle.Top,
                Height = 180,
                Padding = new Padding(10)
            };

            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 5,
                Padding = new Padding(5)
            };

            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            // Control Server URL
            panel.Controls.Add(new Label { Text = "Control Server:", AutoSize = true }, 0, 0);
            _controlServerUrlTextBox = new TextBox { Width = 250 };
            panel.Controls.Add(_controlServerUrlTextBox, 1, 0);

            // Port
            panel.Controls.Add(new Label { Text = "Local Port:", AutoSize = true }, 0, 1);
            _portNumeric = new NumericUpDown
            {
                Minimum = 1024,
                Maximum = 65535,
                Value = 3456,
                Width = 80
            };
            panel.Controls.Add(_portNumeric, 1, 1);

            // Auto-start
            _autoStartCheckBox = new CheckBox { Text = "Start with Windows", AutoSize = true };
            panel.Controls.Add(_autoStartCheckBox, 1, 2);

            // Logging
            _loggingCheckBox = new CheckBox { Text = "Enable logging", AutoSize = true };
            panel.Controls.Add(_loggingCheckBox, 1, 3);

            // Save button
            _saveButton = new Button { Text = "Save Settings", Size = new Size(100, 30) };
            _saveButton.Click += OnSaveClick;
            panel.Controls.Add(_saveButton, 1, 4);

            serviceGroup.Controls.Add(panel);
            mainPanel.Controls.Add(serviceGroup, 0, 0);

            // Lock Screen Credentials Group
            var credGroup = new GroupBox
            {
                Text = "Lock Screen Credentials",
                Dock = DockStyle.Top,
                Height = 150,
                Padding = new Padding(10)
            };

            var credPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 4,
                Padding = new Padding(5)
            };

            credPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
            credPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            // Description
            var descLabel = new Label
            {
                Text = "Store Windows credentials for remote screen unlock via ScreenControl.",
                AutoSize = false,
                Width = 300,
                Height = 30
            };
            credPanel.SetColumnSpan(descLabel, 2);
            credPanel.Controls.Add(descLabel, 0, 0);

            // Username
            credPanel.Controls.Add(new Label { Text = "Username:", AutoSize = true }, 0, 1);
            _lockScreenUsernameTextBox = new TextBox { Width = 250 };
            credPanel.Controls.Add(_lockScreenUsernameTextBox, 1, 1);

            // Password
            credPanel.Controls.Add(new Label { Text = "Password:", AutoSize = true }, 0, 2);
            _lockScreenPasswordTextBox = new TextBox { Width = 250, UseSystemPasswordChar = true };
            credPanel.Controls.Add(_lockScreenPasswordTextBox, 1, 2);

            // Save credentials button
            _saveCredentialsButton = new Button { Text = "Save Credentials", Size = new Size(120, 30) };
            _saveCredentialsButton.Click += OnSaveCredentialsClick;
            credPanel.Controls.Add(_saveCredentialsButton, 1, 3);

            credGroup.Controls.Add(credPanel);
            mainPanel.Controls.Add(credGroup, 0, 1);

            tab.Controls.Add(mainPanel);

            // Load saved credentials
            LoadLockScreenCredentials();
        }

        private string GetCredentialsConfigPath()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var configDir = Path.Combine(appData, "ScreenControl");
            Directory.CreateDirectory(configDir);
            return Path.Combine(configDir, "credentials.json");
        }

        private void LoadLockScreenCredentials()
        {
            try
            {
                var configPath = GetCredentialsConfigPath();
                if (File.Exists(configPath))
                {
                    var json = File.ReadAllText(configPath);
                    var creds = JsonSerializer.Deserialize<LockScreenCredentials>(json);
                    if (creds != null)
                    {
                        _lockScreenUsernameTextBox.Text = creds.Username ?? "";
                        // Password is stored but not displayed for security
                        if (!string.IsNullOrEmpty(creds.EncryptedPassword))
                        {
                            _lockScreenPasswordTextBox.PlaceholderText = "(saved)";
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to load credentials: {ex.Message}");
            }
        }

        private void OnSaveCredentialsClick(object? sender, EventArgs e)
        {
            try
            {
                var username = _lockScreenUsernameTextBox.Text.Trim();
                var password = _lockScreenPasswordTextBox.Text;

                if (string.IsNullOrEmpty(username))
                {
                    MessageBox.Show("Please enter a username.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                // Encrypt password using DPAPI (Windows Data Protection API)
                var encryptedPassword = "";
                if (!string.IsNullOrEmpty(password))
                {
                    var passwordBytes = System.Text.Encoding.UTF8.GetBytes(password);
                    var encryptedBytes = System.Security.Cryptography.ProtectedData.Protect(
                        passwordBytes,
                        null,
                        System.Security.Cryptography.DataProtectionScope.LocalMachine
                    );
                    encryptedPassword = Convert.ToBase64String(encryptedBytes);
                }

                var creds = new LockScreenCredentials
                {
                    Username = username,
                    EncryptedPassword = encryptedPassword
                };

                var json = JsonSerializer.Serialize(creds, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(GetCredentialsConfigPath(), json);

                _lockScreenPasswordTextBox.Text = "";
                _lockScreenPasswordTextBox.PlaceholderText = "(saved)";

                MessageBox.Show("Credentials saved securely.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Failed to save credentials: {ex.Message}", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void InitializeToolsTab(TabPage tab)
        {
            // Create scrollable panel for tools
            _toolsPanel = new Panel
            {
                Dock = DockStyle.Fill,
                AutoScroll = true,
                Padding = new Padding(10)
            };

            var contentPanel = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Width = 440
            };

            // Create category groups
            foreach (var categoryEntry in ToolCategories)
            {
                var categoryId = categoryEntry.Key;
                var (categoryName, tools) = categoryEntry.Value;

                var categoryGroup = new GroupBox
                {
                    Text = categoryName,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    Width = 430,
                    Margin = new Padding(0, 0, 0, 10),
                    Padding = new Padding(10, 5, 10, 10)
                };

                var categoryContent = new FlowLayoutPanel
                {
                    FlowDirection = FlowDirection.TopDown,
                    WrapContents = false,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    Dock = DockStyle.Fill
                };

                // Category master checkbox
                var categoryCheckbox = new CheckBox
                {
                    Text = "Enable All",
                    AutoSize = true,
                    Font = new Font(Font, FontStyle.Bold),
                    Margin = new Padding(0, 5, 0, 5),
                    Tag = categoryId
                };
                categoryCheckbox.CheckedChanged += OnCategoryCheckboxChanged;
                _categoryCheckboxes[categoryId] = categoryCheckbox;
                categoryContent.Controls.Add(categoryCheckbox);

                // Individual tool checkboxes
                _toolCheckboxes[categoryId] = new Dictionary<string, CheckBox>();
                foreach (var tool in tools)
                {
                    var toolCheckbox = new CheckBox
                    {
                        Text = tool,
                        AutoSize = true,
                        Margin = new Padding(20, 2, 0, 2),
                        Tag = (categoryId, tool)
                    };
                    toolCheckbox.CheckedChanged += OnToolCheckboxChanged;
                    _toolCheckboxes[categoryId][tool] = toolCheckbox;
                    categoryContent.Controls.Add(toolCheckbox);
                }

                categoryGroup.Controls.Add(categoryContent);
                contentPanel.Controls.Add(categoryGroup);
            }

            _toolsPanel.Controls.Add(contentPanel);
            tab.Controls.Add(_toolsPanel);

            // Apply loaded config to checkboxes
            UpdateToolsCheckboxes();
        }

        #region Tools Tab Methods

        private string GetToolsConfigPath()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var configDir = Path.Combine(appData, "ScreenControl");
            Directory.CreateDirectory(configDir);
            return Path.Combine(configDir, "tools-config.json");
        }

        private void LoadToolsConfig()
        {
            try
            {
                var configPath = GetToolsConfigPath();
                if (File.Exists(configPath))
                {
                    var json = File.ReadAllText(configPath);
                    var loaded = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, bool>>>(json);
                    if (loaded != null)
                    {
                        _toolsConfig = loaded;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to load tools config: {ex.Message}");
            }

            // Ensure all categories and tools exist with defaults
            EnsureAllToolsExist();
        }

        private void EnsureAllToolsExist()
        {
            foreach (var categoryEntry in ToolCategories)
            {
                var categoryId = categoryEntry.Key;
                var (_, tools) = categoryEntry.Value;

                if (!_toolsConfig.ContainsKey(categoryId))
                {
                    _toolsConfig[categoryId] = new Dictionary<string, bool>();
                }

                foreach (var tool in tools)
                {
                    if (!_toolsConfig[categoryId].ContainsKey(tool))
                    {
                        _toolsConfig[categoryId][tool] = true; // Default to enabled
                    }
                }
            }
        }

        private void SaveToolsConfig()
        {
            try
            {
                var json = JsonSerializer.Serialize(_toolsConfig, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(GetToolsConfigPath(), json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to save tools config: {ex.Message}");
            }
        }

        private void UpdateToolsCheckboxes()
        {
            _suppressCheckboxEvents = true;
            try
            {
                foreach (var categoryEntry in ToolCategories)
                {
                    var categoryId = categoryEntry.Key;
                    var (_, tools) = categoryEntry.Value;

                    if (!_toolsConfig.ContainsKey(categoryId)) continue;
                    if (!_categoryCheckboxes.ContainsKey(categoryId)) continue;
                    if (!_toolCheckboxes.ContainsKey(categoryId)) continue;

                    // Update individual tool checkboxes
                    bool allEnabled = true;
                    bool anyEnabled = false;

                    foreach (var tool in tools)
                    {
                        if (_toolsConfig[categoryId].TryGetValue(tool, out var enabled) &&
                            _toolCheckboxes[categoryId].TryGetValue(tool, out var checkbox))
                        {
                            checkbox.Checked = enabled;
                            if (enabled) anyEnabled = true;
                            else allEnabled = false;
                        }
                    }

                    // Update category checkbox state
                    var catCheckbox = _categoryCheckboxes[categoryId];
                    catCheckbox.Checked = allEnabled || anyEnabled;
                    catCheckbox.CheckState = allEnabled ? CheckState.Checked :
                                             anyEnabled ? CheckState.Indeterminate :
                                             CheckState.Unchecked;
                }
            }
            finally
            {
                _suppressCheckboxEvents = false;
            }
        }

        private void OnCategoryCheckboxChanged(object? sender, EventArgs e)
        {
            if (_suppressCheckboxEvents) return;
            if (sender is not CheckBox checkbox) return;
            if (checkbox.Tag is not string categoryId) return;

            var isChecked = checkbox.Checked;

            // Update all tools in this category
            if (_toolsConfig.ContainsKey(categoryId) && _toolCheckboxes.ContainsKey(categoryId))
            {
                _suppressCheckboxEvents = true;
                try
                {
                    foreach (var tool in _toolsConfig[categoryId].Keys.ToArray())
                    {
                        _toolsConfig[categoryId][tool] = isChecked;
                        if (_toolCheckboxes[categoryId].TryGetValue(tool, out var toolCheckbox))
                        {
                            toolCheckbox.Checked = isChecked;
                        }
                    }
                }
                finally
                {
                    _suppressCheckboxEvents = false;
                }

                SaveToolsConfig();
            }
        }

        private void OnToolCheckboxChanged(object? sender, EventArgs e)
        {
            if (_suppressCheckboxEvents) return;
            if (sender is not CheckBox checkbox) return;
            if (checkbox.Tag is not (string categoryId, string tool)) return;

            var isChecked = checkbox.Checked;

            // Update config
            if (_toolsConfig.ContainsKey(categoryId))
            {
                _toolsConfig[categoryId][tool] = isChecked;
                SaveToolsConfig();

                // Update category checkbox state
                UpdateCategoryCheckboxState(categoryId);
            }
        }

        private void UpdateCategoryCheckboxState(string categoryId)
        {
            if (!_categoryCheckboxes.TryGetValue(categoryId, out var catCheckbox)) return;
            if (!_toolsConfig.TryGetValue(categoryId, out var tools)) return;

            bool allEnabled = tools.Values.All(v => v);
            bool anyEnabled = tools.Values.Any(v => v);

            _suppressCheckboxEvents = true;
            try
            {
                catCheckbox.CheckState = allEnabled ? CheckState.Checked :
                                         anyEnabled ? CheckState.Indeterminate :
                                         CheckState.Unchecked;
            }
            finally
            {
                _suppressCheckboxEvents = false;
            }
        }

        // Public method to check if a tool is enabled
        public bool IsToolEnabled(string categoryId, string tool)
        {
            if (_toolsConfig.TryGetValue(categoryId, out var category) &&
                category.TryGetValue(tool, out var enabled))
            {
                return enabled;
            }
            return true; // Default to enabled if not found
        }

        #endregion

        private void InitializeDebugTab(TabPage tab)
        {
            var mainPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                Padding = new Padding(10)
            };

            mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            mainPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            mainPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            // Connection Settings Group
            var connectionGroup = new GroupBox
            {
                Text = "Debug Connection Settings",
                Dock = DockStyle.Top,
                Height = 180,
                Padding = new Padding(10)
            };

            var connPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 5,
                Padding = new Padding(5)
            };
            connPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
            connPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            // Server URL
            connPanel.Controls.Add(new Label { Text = "Server URL:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            _debugServerUrlTextBox = new TextBox { Width = 280, Text = "wss://screencontrol.knws.co.uk/ws" };
            connPanel.Controls.Add(_debugServerUrlTextBox, 1, 0);

            // Endpoint UUID
            connPanel.Controls.Add(new Label { Text = "Endpoint UUID:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 1);
            _debugEndpointUuidTextBox = new TextBox { Width = 280 };
            connPanel.Controls.Add(_debugEndpointUuidTextBox, 1, 1);

            // Customer ID
            connPanel.Controls.Add(new Label { Text = "Customer ID:", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
            _debugCustomerIdTextBox = new TextBox { Width = 280 };
            connPanel.Controls.Add(_debugCustomerIdTextBox, 1, 2);

            // Connect on startup checkbox
            _debugConnectOnStartupCheckBox = new CheckBox { Text = "Connect automatically on startup", AutoSize = true };
            connPanel.Controls.Add(_debugConnectOnStartupCheckBox, 1, 3);

            // Buttons
            var buttonPanel = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
            _debugConnectButton = new Button { Text = "Connect", Size = new Size(80, 28) };
            _debugConnectButton.Click += OnDebugConnectClick;
            _debugDisconnectButton = new Button { Text = "Disconnect", Size = new Size(80, 28), Enabled = false };
            _debugDisconnectButton.Click += OnDebugDisconnectClick;
            _debugSaveSettingsButton = new Button { Text = "Save Settings", Size = new Size(90, 28) };
            _debugSaveSettingsButton.Click += OnDebugSaveSettingsClick;
            _debugCopyMcpUrlButton = new Button { Text = "Copy MCP URL", Size = new Size(100, 28) };
            _debugCopyMcpUrlButton.Click += OnDebugCopyMcpUrlClick;
            buttonPanel.Controls.Add(_debugConnectButton);
            buttonPanel.Controls.Add(_debugDisconnectButton);
            buttonPanel.Controls.Add(_debugSaveSettingsButton);
            buttonPanel.Controls.Add(_debugCopyMcpUrlButton);
            connPanel.Controls.Add(buttonPanel, 1, 4);

            connectionGroup.Controls.Add(connPanel);
            mainPanel.Controls.Add(connectionGroup, 0, 0);

            // Status Group
            var statusGroup = new GroupBox
            {
                Text = "Connection Status",
                Dock = DockStyle.Top,
                Height = 80,
                Padding = new Padding(10)
            };

            var statusPanel = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                AutoSize = true
            };

            _debugConnectionStatusLabel = new Label { Text = "Status: Not connected", AutoSize = true, ForeColor = Color.Gray };
            _debugLicenseStatusLabel = new Label { Text = "License: --", AutoSize = true };
            _debugAgentIdLabel = new Label { Text = "Agent ID: --", AutoSize = true };
            statusPanel.Controls.Add(_debugConnectionStatusLabel);
            statusPanel.Controls.Add(_debugLicenseStatusLabel);
            statusPanel.Controls.Add(_debugAgentIdLabel);

            statusGroup.Controls.Add(statusPanel);
            mainPanel.Controls.Add(statusGroup, 0, 1);

            // Log Group
            var logGroup = new GroupBox
            {
                Text = "Connection Log",
                Dock = DockStyle.Fill,
                Padding = new Padding(10)
            };

            _debugLogTextBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 9)
            };

            logGroup.Controls.Add(_debugLogTextBox);
            mainPanel.Controls.Add(logGroup, 0, 2);

            tab.Controls.Add(mainPanel);
        }

        #region Debug Tab Event Handlers

        private string GetDebugConfigPath()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var configDir = Path.Combine(appData, "ScreenControl");
            Directory.CreateDirectory(configDir);
            return Path.Combine(configDir, "debug-config.json");
        }

        private void LoadDebugConfig()
        {
            try
            {
                var configPath = GetDebugConfigPath();
                DebugConfig? config = null;

                if (File.Exists(configPath))
                {
                    var json = File.ReadAllText(configPath);
                    config = JsonSerializer.Deserialize<DebugConfig>(json);
                }

                if (config != null)
                {
                    _debugServerUrlTextBox.Text = config.ServerUrl;
                    _debugEndpointUuidTextBox.Text = config.EndpointUuid;
                    _debugCustomerIdTextBox.Text = config.CustomerId;
                    _debugConnectOnStartupCheckBox.Checked = config.ConnectOnStartup;
                }

                // Auto-generate Endpoint UUID if empty
                if (string.IsNullOrWhiteSpace(_debugEndpointUuidTextBox.Text))
                {
                    _debugEndpointUuidTextBox.Text = Guid.NewGuid().ToString();
                    // Save immediately so the UUID persists
                    SaveDebugConfig();
                }
            }
            catch (Exception ex)
            {
                DebugLog($"Failed to load debug config: {ex.Message}");
            }
        }

        private void SaveDebugConfig()
        {
            try
            {
                var config = new DebugConfig
                {
                    ServerUrl = _debugServerUrlTextBox.Text,
                    EndpointUuid = _debugEndpointUuidTextBox.Text,
                    CustomerId = _debugCustomerIdTextBox.Text,
                    ConnectOnStartup = _debugConnectOnStartupCheckBox.Checked
                };

                var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(GetDebugConfigPath(), json);
                DebugLog("Settings saved");
            }
            catch (Exception ex)
            {
                DebugLog($"Failed to save debug config: {ex.Message}");
            }
        }

        private async void OnDebugConnectClick(object? sender, EventArgs e)
        {
            if (_webSocketClient != null && _webSocketClient.IsConnected)
                return;

            _webSocketClient?.Dispose();
            _webSocketClient = new WebSocketClient();

            // Wire up events
            _webSocketClient.OnLog += DebugLog;
            _webSocketClient.OnConnectionChanged += OnDebugConnectionChanged;
            _webSocketClient.OnStatusChanged += OnDebugStatusChanged;
            _webSocketClient.OnPermissionsChanged += OnPermissionsChanged;

            var config = new DebugConfig
            {
                ServerUrl = _debugServerUrlTextBox.Text,
                EndpointUuid = _debugEndpointUuidTextBox.Text,
                CustomerId = _debugCustomerIdTextBox.Text
            };

            _debugConnectButton.Enabled = false;
            _debugConnectionStatusLabel.Text = "Status: Connecting...";
            _debugConnectionStatusLabel.ForeColor = Color.Orange;

            await _webSocketClient.ConnectAsync(config);
        }

        private async void OnDebugDisconnectClick(object? sender, EventArgs e)
        {
            if (_webSocketClient == null) return;

            _debugDisconnectButton.Enabled = false;
            await _webSocketClient.DisconnectAsync();
        }

        private void OnDebugSaveSettingsClick(object? sender, EventArgs e)
        {
            SaveDebugConfig();
            MessageBox.Show("Debug settings saved.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnDebugCopyMcpUrlClick(object? sender, EventArgs e)
        {
            var endpointUuid = _debugEndpointUuidTextBox.Text.Trim();
            if (string.IsNullOrEmpty(endpointUuid))
            {
                MessageBox.Show("Please enter an Endpoint UUID first.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var serverUrl = _debugServerUrlTextBox.Text.Trim();
            if (string.IsNullOrEmpty(serverUrl))
            {
                serverUrl = "wss://screencontrol.knws.co.uk/ws";
            }

            // Convert WebSocket URL to HTTP URL
            var httpUrl = serverUrl
                .Replace("wss://", "https://")
                .Replace("ws://", "http://");

            if (httpUrl.EndsWith("/ws"))
            {
                httpUrl = httpUrl[..^3];
            }

            var mcpUrl = $"{httpUrl}/mcp/{endpointUuid}";
            Clipboard.SetText(mcpUrl);
            DebugLog($"MCP URL copied: {mcpUrl}");
            MessageBox.Show("MCP URL copied to clipboard.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnDebugConnectionChanged(bool connected)
        {
            if (InvokeRequired)
            {
                Invoke(new Action(() => OnDebugConnectionChanged(connected)));
                return;
            }

            _debugConnectButton.Enabled = !connected;
            _debugDisconnectButton.Enabled = connected;

            if (connected)
            {
                _debugConnectionStatusLabel.Text = "Status: Connected";
                _debugConnectionStatusLabel.ForeColor = Color.Green;
            }
            else
            {
                _debugConnectionStatusLabel.Text = "Status: Disconnected";
                _debugConnectionStatusLabel.ForeColor = Color.Gray;
                _debugLicenseStatusLabel.Text = "License: --";
                _debugAgentIdLabel.Text = "Agent ID: --";
            }
        }

        private void OnDebugStatusChanged(string agentId, string licenseStatus)
        {
            if (InvokeRequired)
            {
                Invoke(new Action(() => OnDebugStatusChanged(agentId, licenseStatus)));
                return;
            }

            _debugAgentIdLabel.Text = $"Agent ID: {agentId}";
            _debugLicenseStatusLabel.Text = $"License: {licenseStatus.ToUpper()}";

            if (licenseStatus == "active")
            {
                _debugLicenseStatusLabel.ForeColor = Color.Green;
            }
            else if (licenseStatus == "pending")
            {
                _debugLicenseStatusLabel.ForeColor = Color.Orange;
            }
            else
            {
                _debugLicenseStatusLabel.ForeColor = Color.Red;
            }
        }

        private void OnPermissionsChanged(bool masterMode, bool fileTransfer, bool localSettingsLocked)
        {
            if (InvokeRequired)
            {
                Invoke(new Action(() => OnPermissionsChanged(masterMode, fileTransfer, localSettingsLocked)));
                return;
            }

            _localSettingsLocked = localSettingsLocked;
            UpdateLockedState();
        }

        private void UpdateLockedState()
        {
            // When local settings are locked, disable Settings and Tools tabs
            if (_localSettingsLocked)
            {
                // Disable Settings tab controls
                _controlServerUrlTextBox.Enabled = false;
                _portNumeric.Enabled = false;
                _autoStartCheckBox.Enabled = false;
                _loggingCheckBox.Enabled = false;
                _saveButton.Enabled = false;
                _lockScreenUsernameTextBox.Enabled = false;
                _lockScreenPasswordTextBox.Enabled = false;
                _saveCredentialsButton.Enabled = false;

                // Disable Tools tab
                _toolsPanel.Enabled = false;

                // Update locked status label if it exists
                if (_lockedStatusLabel != null)
                {
                    _lockedStatusLabel.Text = "Settings are locked by administrator";
                    _lockedStatusLabel.Visible = true;
                }

                DebugLog("Local settings locked by administrator");
            }
            else
            {
                // Enable Settings tab controls
                _controlServerUrlTextBox.Enabled = true;
                _portNumeric.Enabled = true;
                _autoStartCheckBox.Enabled = true;
                _loggingCheckBox.Enabled = true;
                _saveButton.Enabled = true;
                _lockScreenUsernameTextBox.Enabled = true;
                _lockScreenPasswordTextBox.Enabled = true;
                _saveCredentialsButton.Enabled = true;

                // Enable Tools tab
                _toolsPanel.Enabled = true;

                // Hide locked status label
                if (_lockedStatusLabel != null)
                {
                    _lockedStatusLabel.Visible = false;
                }
            }
        }

        private void DebugLog(string message)
        {
            if (InvokeRequired)
            {
                Invoke(new Action(() => DebugLog(message)));
                return;
            }

            _debugLogTextBox.AppendText(message + Environment.NewLine);
            _debugLogTextBox.ScrollToCaret();
        }

        #endregion

        private async Task LoadDataAsync()
        {
            try
            {
                // Load status
                var status = await _serviceClient.GetStatusAsync();

                if (status.IsRunning)
                {
                    _statusLabel.Text = "Running";
                    _statusLabel.ForeColor = Color.Green;
                    _versionLabel.Text = status.Version;
                    _machineIdLabel.Text = status.MachineId.Length > 20
                        ? status.MachineId[..20] + "..."
                        : status.MachineId;
                    _machineIdLabel.Tag = status.MachineId;

                    _licenseStatusLabel.Text = status.IsLicensed ? "Licensed" : "Not Licensed";
                    _licenseStatusLabel.ForeColor = status.IsLicensed ? Color.Green : Color.Orange;
                    _expiryLabel.Text = status.LicenseExpiry?.ToString("yyyy-MM-dd") ?? "N/A";

                    _deactivateButton.Enabled = status.IsLicensed;
                }
                else
                {
                    _statusLabel.Text = "Not Running";
                    _statusLabel.ForeColor = Color.Red;
                    _versionLabel.Text = "-";
                    _machineIdLabel.Text = "-";
                    _licenseStatusLabel.Text = "Service not running";
                    _licenseStatusLabel.ForeColor = Color.Gray;
                    _expiryLabel.Text = "-";
                    _deactivateButton.Enabled = false;
                }

                // Load settings
                var settings = await _serviceClient.GetSettingsAsync();
                _controlServerUrlTextBox.Text = settings.ControlServerUrl;
                _portNumeric.Value = settings.Port;
                _autoStartCheckBox.Checked = settings.AutoStart;
                _loggingCheckBox.Checked = settings.EnableLogging;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    $"Failed to load data: {ex.Message}",
                    "Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void OnCopyMachineIdClick(object? sender, EventArgs e)
        {
            var machineId = _machineIdLabel.Tag as string;
            if (!string.IsNullOrEmpty(machineId))
            {
                Clipboard.SetText(machineId);
                MessageBox.Show("Machine ID copied to clipboard.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private async void OnActivateClick(object? sender, EventArgs e)
        {
            var licenseKey = _licenseKeyTextBox.Text.Trim();
            if (string.IsNullOrEmpty(licenseKey))
            {
                MessageBox.Show("Please enter a license key.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            _activateButton.Enabled = false;
            try
            {
                var (success, message) = await _serviceClient.ActivateLicenseAsync(licenseKey);

                if (success)
                {
                    MessageBox.Show("License activated successfully!", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    await LoadDataAsync();
                }
                else
                {
                    MessageBox.Show($"Activation failed: {message}", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            finally
            {
                _activateButton.Enabled = true;
            }
        }

        private async void OnDeactivateClick(object? sender, EventArgs e)
        {
            var result = MessageBox.Show(
                "Are you sure you want to deactivate this license?",
                "Confirm Deactivation",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            if (result != DialogResult.Yes)
                return;

            _deactivateButton.Enabled = false;
            try
            {
                var (success, message) = await _serviceClient.DeactivateLicenseAsync();

                if (success)
                {
                    MessageBox.Show("License deactivated.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    _licenseKeyTextBox.Text = "";
                    await LoadDataAsync();
                }
                else
                {
                    MessageBox.Show($"Deactivation failed: {message}", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            finally
            {
                _deactivateButton.Enabled = true;
            }
        }

        private async void OnSaveClick(object? sender, EventArgs e)
        {
            _saveButton.Enabled = false;
            try
            {
                var settings = new ServiceSettings
                {
                    ControlServerUrl = _controlServerUrlTextBox.Text.Trim(),
                    Port = (int)_portNumeric.Value,
                    AutoStart = _autoStartCheckBox.Checked,
                    EnableLogging = _loggingCheckBox.Checked
                };

                var success = await _serviceClient.SaveSettingsAsync(settings);

                if (success)
                {
                    MessageBox.Show("Settings saved successfully.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("Failed to save settings.", "ScreenControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            finally
            {
                _saveButton.Enabled = true;
            }
        }
    }
}
