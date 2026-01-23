/**
 * ScreenControl App Delegate Implementation
 * Runs as a menu bar app with status icon and native settings window
 */

#import "AppDelegate.h"
#import "FilesystemTools.h"
#import "ShellTools.h"
#import <ServiceManagement/ServiceManagement.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Security/Security.h>
#import <IOKit/IOKitLib.h>
#import <signal.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>

#ifdef DEBUG
#import "TestServer.h"
#endif

// Settings keys for UserDefaults
static NSString * const kAgentNameKey = @"AgentName";
static NSString * const kNetworkModeKey = @"NetworkMode";
static NSString * const kPortKey = @"Port";
static NSString * const kAPIKeyKey = @"APIKey";
static NSString * const kControlServerAddressKey = @"ControlServerAddress";

// Tools configuration path
static NSString * const kToolsConfigFilename = @"tools.json";

// Forward declare C++ agent functions
#ifdef __cplusplus
extern "C" {
#endif
    void* mcp_eyes_create_agent(void);
    void mcp_eyes_destroy_agent(void* agent);
    int mcp_eyes_start(void* agent);
    void mcp_eyes_stop(void* agent);
    int mcp_eyes_is_running(void* agent);
    const char* mcp_eyes_get_name(void* agent);
    int mcp_eyes_get_port(void* agent);
#ifdef __cplusplus
}
#endif

@interface AppDelegate ()
@property (strong) MCPServer* mcpServer;
@property (strong) NSTimer* statusTimer;
@property (strong) NSDate* startTime;
@property (assign) BOOL isRemoteMode;
@property (strong) NSURLSession* urlSession;
@property (assign) BOOL isUpdatingPermissionIndicators;
@property (assign) BOOL isUpdatingSettingsStatus;
@property (strong) NSImage* cachedNormalIcon;
@property (strong) NSImage* cachedLockedIcon;
@property (assign) BOOL currentIconIsLocked;
@property (assign) BOOL isAppTerminating;
@property (strong) NSString* logFilePath;

// App Nap prevention - keeps app responsive for remote commands
@property (strong) id<NSObject> appNapActivity;

// Helper method declarations
- (NSString *)getToolsConfigPath;
- (void)loadToolsConfig;
- (void)saveToolsConfig;
- (void)createDefaultToolsConfig;
- (BOOL)ensureAllCategoriesExist;
- (NSArray *)getToolsForCategory:(NSString *)categoryId;
- (NSView *)createGeneralTabView;
- (NSView *)createToolsTabView;
- (NSView *)createPermissionsTabView;
- (NSView *)createDebugTabView;
- (void)debugConnect:(id)sender;
- (void)debugDisconnect:(id)sender;
- (void)debugLog:(NSString *)message;
- (void)fileLog:(NSString *)message;
- (NSString *)getMachineId;
- (CGFloat)addCategoryBox:(NSString *)categoryName categoryId:(NSString *)categoryId tools:(NSArray *)tools toView:(NSView *)documentView atY:(CGFloat)y;
- (void)categoryToggleChanged:(NSButton *)sender;
- (void)toolToggleChanged:(NSButton *)sender;
- (void)loadBundledDebugConfig;
@end

@implementation AppDelegate

#pragma mark - Application Lifecycle

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.startTime = [NSDate date];

    // Prevent App Nap - CRITICAL for menu bar apps that need to stay responsive
    // Without this, macOS may suspend the app and the GUIBridgeServer becomes unresponsive
    // causing "Tray app unavailable" errors from the service
    self.appNapActivity = [[NSProcessInfo processInfo] beginActivityWithOptions:(NSActivityUserInitiated | NSActivityLatencyCritical)
                                                                          reason:@"ScreenControl must stay responsive for remote commands"];

    // Initialize file logging
    NSString *logsDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/ScreenControl"];
    [[NSFileManager defaultManager] createDirectoryAtPath:logsDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    [formatter setDateFormat:@"yyyy-MM-dd_HH-mm-ss"];
    NSString *timestamp = [formatter stringFromDate:[NSDate date]];
    self.logFilePath = [logsDir stringByAppendingPathComponent:[NSString stringWithFormat:@"crash_%@.log", timestamp]];

    [self fileLog:@"========================================"];
    [self fileLog:@"ScreenControl Agent Starting"];
    [self fileLog:[NSString stringWithFormat:@"PID: %d", [[NSProcessInfo processInfo] processIdentifier]]];
    [self fileLog:[NSString stringWithFormat:@"Version: %@", [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"]]];
    [self fileLog:@"========================================"];

    // Initialize URL session for control server connections
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
    config.timeoutIntervalForRequest = 10.0;
    self.urlSession = [NSURLSession sessionWithConfiguration:config];

    // Initialize tools configuration dictionaries
    self.categoryToggles = [NSMutableDictionary dictionary];
    self.toolToggles = [NSMutableDictionary dictionary];
    [self loadToolsConfig];

    // Create status bar item with googly eyes icon
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
    [self updateStatusBarIcon:NO];
    self.statusItem.button.toolTip = @"ScreenControl Agent";

    // Create menu
    [self createStatusMenu];
    self.statusItem.menu = self.statusMenu;

    // Create settings window
    [self createSettingsWindow];

    // Load bundled debug config to auto-fill debug connection settings
    [self loadBundledDebugConfig];

    // Check permissions on launch
    [self checkPermissions];

    // Start agent
    [self startAgent];

    // Start browser bridge server (manages Firefox/Chrome extension communication)
    NSLog(@"[Startup] About to call startBrowserBridge...");
    [self fileLog:@"[Startup] About to call startBrowserBridge..."];
    [self startBrowserBridge];
    NSLog(@"[Startup] startBrowserBridge returned");
    [self fileLog:@"[Startup] startBrowserBridge returned"];

    // Start GUI Bridge server (receives commands from service)
    [self startGUIBridgeServer];

    // Ensure bundled service is running before monitoring it
    [self ensureBundledServiceRunning];

    // Give service a moment to start before monitoring
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        // Start Service client (monitors service status)
        [self startServiceClient];
    });

    // Check control server connection status (now via service)
    [self checkControlServerConnection];

    // Update status periodically
    self.statusTimer = [NSTimer scheduledTimerWithTimeInterval:5.0
                                                        target:self
                                                      selector:@selector(updateStatus)
                                                      userInfo:nil
                                                       repeats:YES];

#ifdef DEBUG
    // Start test server for automated testing (DEBUG builds only)
    // Use port 3458 to avoid conflict with MCPServer on 3456
    self.testServer = [[TestServer alloc] initWithAppDelegate:self];
    if ([self.testServer startOnPort:3458]) {
        NSLog(@"[ScreenControl] Test server started - agent is now remotely controllable via localhost:3458");
    } else {
        NSLog(@"[ScreenControl] WARNING: Failed to start test server");
    }
#endif
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self fileLog:@"========================================"];
    [self fileLog:@"APPLICATION WILL TERMINATE"];
    [self fileLog:[NSString stringWithFormat:@"Notification: %@", notification]];
    [self fileLog:[NSString stringWithFormat:@"Reason: %@", notification.userInfo]];
    [self fileLog:@"Stack trace:"];
    for (NSString *line in [NSThread callStackSymbols]) {
        [self fileLog:[NSString stringWithFormat:@"  %@", line]];
    }
    [self fileLog:@"========================================"];

    self.isAppTerminating = YES;

#ifdef DEBUG
    [self.testServer stop];
#endif

    // End App Nap prevention activity
    if (self.appNapActivity) {
        [[NSProcessInfo processInfo] endActivity:self.appNapActivity];
        self.appNapActivity = nil;
    }

    [self stopGUIBridgeServer];
    [self stopServiceClient];
    [self stopBundledService];
    [self stopBrowserBridge];
    [self stopAgent];
    [self.statusTimer invalidate];
}

#pragma mark - Googly Eyes Icon

- (void)updateStatusBarIcon:(BOOL)locked {
    // Ensure we're on the main thread
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self updateStatusBarIcon:locked];
        });
        return;
    }

    // Only update if the state actually changed
    if (self.currentIconIsLocked == locked && (locked ? self.cachedLockedIcon : self.cachedNormalIcon) != nil) {
        return;
    }

    self.currentIconIsLocked = locked;

    // Check if we have cached icons
    NSImage *targetIcon = locked ? self.cachedLockedIcon : self.cachedNormalIcon;

    if (!targetIcon) {
        // Create icons if not cached
        CGFloat menuBarSize = 22.0;

        // Load app icon from bundle
        NSImage *appIcon = [[NSWorkspace sharedWorkspace] iconForFile:[NSBundle mainBundle].bundlePath];
        if (!appIcon || appIcon.size.width == 0) {
            appIcon = [NSImage imageNamed:@"AppIcon"];
        }

        if (appIcon && appIcon.size.width > 0) {
            // Create the icon using lockFocusFlipped for better rendering
            targetIcon = [[NSImage alloc] initWithSize:NSMakeSize(menuBarSize, menuBarSize)];
            [targetIcon lockFocus];

            // Save graphics state
            [NSGraphicsContext saveGraphicsState];

            NSGraphicsContext *context = [NSGraphicsContext currentContext];
            context.imageInterpolation = NSImageInterpolationHigh;
            context.shouldAntialias = YES;

            // Draw base icon
            [appIcon drawInRect:NSMakeRect(0, 0, menuBarSize, menuBarSize)
                        fromRect:NSZeroRect
                       operation:NSCompositingOperationSourceOver
                        fraction:1.0];

            // Draw X overlay if locked
            if (locked) {
                NSBezierPath *xPath = [NSBezierPath bezierPath];
                xPath.lineWidth = 2.0;
                [[NSColor systemRedColor] setStroke];

                // Left X
                [xPath moveToPoint:NSMakePoint(menuBarSize * 0.25 - 3, menuBarSize * 0.5 - 3)];
                [xPath lineToPoint:NSMakePoint(menuBarSize * 0.25 + 3, menuBarSize * 0.5 + 3)];
                [xPath moveToPoint:NSMakePoint(menuBarSize * 0.25 + 3, menuBarSize * 0.5 - 3)];
                [xPath lineToPoint:NSMakePoint(menuBarSize * 0.25 - 3, menuBarSize * 0.5 + 3)];

                // Right X
                [xPath moveToPoint:NSMakePoint(menuBarSize * 0.75 - 3, menuBarSize * 0.5 - 3)];
                [xPath lineToPoint:NSMakePoint(menuBarSize * 0.75 + 3, menuBarSize * 0.5 + 3)];
                [xPath moveToPoint:NSMakePoint(menuBarSize * 0.75 + 3, menuBarSize * 0.5 - 3)];
                [xPath lineToPoint:NSMakePoint(menuBarSize * 0.75 - 3, menuBarSize * 0.5 + 3)];

                [xPath stroke];
            }

            // Restore graphics state
            [NSGraphicsContext restoreGraphicsState];
            [targetIcon unlockFocus];

            targetIcon.template = NO;

            // Cache the created icon
            if (locked) {
                self.cachedLockedIcon = targetIcon;
            } else {
                self.cachedNormalIcon = targetIcon;
            }
        } else {
            // Fallback icon
            targetIcon = [[NSImage alloc] initWithSize:NSMakeSize(menuBarSize, menuBarSize)];
            [targetIcon lockFocus];
            [[NSColor systemGrayColor] setFill];
            NSRectFill(NSMakeRect(0, 0, menuBarSize, menuBarSize));
            [targetIcon unlockFocus];
        }
    }

    // Apply the icon
    if (targetIcon) {
        self.statusItem.button.image = targetIcon;
    }
}

#pragma mark - Status Menu

- (void)createStatusMenu {
    self.statusMenu = [[NSMenu alloc] init];

    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    NSString *headerTitle = [NSString stringWithFormat:@"ScreenControl v%@", version ?: @"?"];
    NSMenuItem *headerItem = [[NSMenuItem alloc] initWithTitle:headerTitle
                                                        action:nil
                                                 keyEquivalent:@""];
    headerItem.enabled = NO;
    [self.statusMenu addItem:headerItem];

    NSMenuItem *statusItem = [[NSMenuItem alloc] initWithTitle:@"Starting..."
                                                        action:nil
                                                 keyEquivalent:@""];
    statusItem.tag = 100;
    [self.statusMenu addItem:statusItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *settingsItem = [[NSMenuItem alloc] initWithTitle:@"Settings..."
                                                          action:@selector(openSettings:)
                                                   keyEquivalent:@","];
    [self.statusMenu addItem:settingsItem];

    NSMenuItem *copyKeyItem = [[NSMenuItem alloc] initWithTitle:@"Copy API Key"
                                                         action:@selector(copyAPIKey:)
                                                  keyEquivalent:@"k"];
    [self.statusMenu addItem:copyKeyItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *permissionsItem = [[NSMenuItem alloc] initWithTitle:@"Permissions"
                                                             action:nil
                                                      keyEquivalent:@""];
    NSMenu *permissionsMenu = [[NSMenu alloc] init];

    NSMenuItem *accessibilityItem = [[NSMenuItem alloc] initWithTitle:@"Accessibility: Checking..."
                                                               action:@selector(openAccessibilityPrefs:)
                                                        keyEquivalent:@""];
    accessibilityItem.tag = 200;
    [permissionsMenu addItem:accessibilityItem];

    NSMenuItem *screenRecordingItem = [[NSMenuItem alloc] initWithTitle:@"Screen Recording: Checking..."
                                                                 action:@selector(openScreenRecordingPrefs:)
                                                          keyEquivalent:@""];
    screenRecordingItem.tag = 201;
    [permissionsMenu addItem:screenRecordingItem];

    permissionsItem.submenu = permissionsMenu;
    [self.statusMenu addItem:permissionsItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *loginItem = [[NSMenuItem alloc] initWithTitle:@"Start at Login"
                                                       action:@selector(toggleLoginItem:)
                                                keyEquivalent:@""];
    loginItem.tag = 300;
    [self.statusMenu addItem:loginItem];

    [self.statusMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit ScreenControl"
                                                      action:@selector(quit:)
                                               keyEquivalent:@"q"];
    [self.statusMenu addItem:quitItem];
}

#pragma mark - Settings Window

- (void)createSettingsWindow {
    CGFloat windowWidth = 600;
    CGFloat windowHeight = 700;

    NSRect windowRect = NSMakeRect(0, 0, windowWidth, windowHeight);

    self.settingsWindow = [[NSWindow alloc] initWithContentRect:windowRect
                                                      styleMask:(NSWindowStyleMaskTitled |
                                                                NSWindowStyleMaskClosable |
                                                                NSWindowStyleMaskMiniaturizable)
                                                        backing:NSBackingStoreBuffered
                                                          defer:NO];

    self.settingsWindow.title = @"ScreenControl Settings";
    self.settingsWindow.delegate = self;
    [self.settingsWindow center];

    NSView *contentView = self.settingsWindow.contentView;

    // Create tab view
    self.settingsTabView = [[NSTabView alloc] initWithFrame:NSMakeRect(0, 50, windowWidth, windowHeight - 50)];

    // Create tabs
    NSTabViewItem *generalTab = [[NSTabViewItem alloc] initWithIdentifier:@"general"];
    generalTab.label = @"General";
    generalTab.view = [self createGeneralTabView];
    [self.settingsTabView addTabViewItem:generalTab];

    NSTabViewItem *toolsTab = [[NSTabViewItem alloc] initWithIdentifier:@"tools"];
    toolsTab.label = @"Tools";
    toolsTab.view = [self createToolsTabView];
    [self.settingsTabView addTabViewItem:toolsTab];

    NSTabViewItem *permissionsTab = [[NSTabViewItem alloc] initWithIdentifier:@"permissions"];
    permissionsTab.label = @"Permissions";
    permissionsTab.view = [self createPermissionsTabView];
    [self.settingsTabView addTabViewItem:permissionsTab];

    NSTabViewItem *debugTab = [[NSTabViewItem alloc] initWithIdentifier:@"debug"];
    debugTab.label = @"Debug";
    debugTab.view = [self createDebugTabView];
    [self.settingsTabView addTabViewItem:debugTab];

    [contentView addSubview:self.settingsTabView];

    // Save Button
    CGFloat padding = 20;
    NSButton *saveButton = [[NSButton alloc] initWithFrame:NSMakeRect(windowWidth - padding - 100, 15, 90, 32)];
    saveButton.title = @"Save";
    saveButton.bezelStyle = NSBezelStyleRounded;
    saveButton.keyEquivalent = @"\r";
    saveButton.target = self;
    saveButton.action = @selector(saveSettings:);
    [contentView addSubview:saveButton];

    [self updatePermissionIndicators];
}

#pragma mark - Tab View Creation

- (NSView *)createGeneralTabView {
    CGFloat tabWidth = 600;
    CGFloat tabHeight = 650;
    NSView *tabView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, tabWidth, tabHeight)];

    CGFloat padding = 20;
    CGFloat labelWidth = 120;
    CGFloat controlWidth = tabWidth - padding * 2 - labelWidth - 10;
    CGFloat rowHeight = 30;
    CGFloat y = tabHeight - 50;  // Increased gap to prevent tab overlap

    // Agent Configuration Section
    NSBox *configBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 140, tabWidth - padding * 2, 150)];
    configBox.title = @"Agent Configuration";
    configBox.titlePosition = NSAtTop;
    [tabView addSubview:configBox];

    CGFloat boxPadding = 15;
    CGFloat boxY = 100;

    NSTextField *nameLabel = [self createLabel:@"Agent Name:"
                                         frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [configBox addSubview:nameLabel];

    self.agentNameField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 20, 24)];
    self.agentNameField.placeholderString = @"My Mac";
    self.agentNameField.stringValue = [self loadSetting:kAgentNameKey defaultValue:[[NSHost currentHost] localizedName]];
    self.agentNameField.delegate = self;
    [configBox addSubview:self.agentNameField];
    boxY -= rowHeight + 5;

    NSTextField *modeLabel = [self createLabel:@"Network Mode:"
                                         frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [configBox addSubview:modeLabel];

    self.networkModePopup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 20, 24)];
    [self.networkModePopup addItemsWithTitles:@[@"Localhost Only", @"Local Network (LAN)", @"Internet (WAN)"]];
    NSString *savedMode = [self loadSetting:kNetworkModeKey defaultValue:@"localhost"];
    if ([savedMode isEqualToString:@"lan"]) {
        [self.networkModePopup selectItemAtIndex:1];
    } else if ([savedMode isEqualToString:@"wan"]) {
        [self.networkModePopup selectItemAtIndex:2];
    }
    [self.networkModePopup setTarget:self];
    [self.networkModePopup setAction:@selector(networkModeChanged:)];
    [configBox addSubview:self.networkModePopup];
    boxY -= rowHeight + 5;

    NSTextField *portLabel = [self createLabel:@"Port:"
                                         frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [configBox addSubview:portLabel];

    self.portField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, 80, 24)];
    self.portField.stringValue = [self loadSetting:kPortKey defaultValue:@"3456"];
    self.portField.delegate = self;
    [configBox addSubview:self.portField];

    y -= 160;

    // Security Section
    NSBox *securityBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 90, tabWidth - padding * 2, 100)];
    securityBox.title = @"Security";
    securityBox.titlePosition = NSAtTop;
    [tabView addSubview:securityBox];

    boxY = 50;

    NSTextField *keyLabel = [self createLabel:@"API Key:"
                                        frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [securityBox addSubview:keyLabel];

    self.apiKeyField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 60, 24)];
    self.apiKeyField.stringValue = [self loadOrGenerateAPIKey];
    self.apiKeyField.editable = NO;
    self.apiKeyField.selectable = YES;
    self.apiKeyField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    [securityBox addSubview:self.apiKeyField];

    // Copy button with clipboard icon
    self.duplicateKeyButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth + controlWidth - 55, boxY, 24, 24)];
    self.duplicateKeyButton.bezelStyle = NSBezelStyleRounded;
    self.duplicateKeyButton.image = [NSImage imageWithSystemSymbolName:@"doc.on.doc" accessibilityDescription:@"Copy"];
    self.duplicateKeyButton.imagePosition = NSImageOnly;
    self.duplicateKeyButton.toolTip = @"Copy API Key";
    self.duplicateKeyButton.target = self;
    self.duplicateKeyButton.action = @selector(copyAPIKey:);
    [securityBox addSubview:self.duplicateKeyButton];

    // Regenerate button with refresh icon
    self.regenerateKeyButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth + controlWidth - 28, boxY, 24, 24)];
    self.regenerateKeyButton.bezelStyle = NSBezelStyleRounded;
    self.regenerateKeyButton.image = [NSImage imageWithSystemSymbolName:@"arrow.clockwise" accessibilityDescription:@"Regenerate"];
    self.regenerateKeyButton.imagePosition = NSImageOnly;
    self.regenerateKeyButton.toolTip = @"Regenerate API Key";
    self.regenerateKeyButton.target = self;
    self.regenerateKeyButton.action = @selector(regenerateAPIKey:);
    [securityBox addSubview:self.regenerateKeyButton];

    y -= 110;

    // Control Server Section
    NSBox *controlServerBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 105, tabWidth - padding * 2, 115)];
    controlServerBox.title = @"Control Server (Remote Mode)";
    controlServerBox.titlePosition = NSAtTop;
    [tabView addSubview:controlServerBox];

    boxY = 70;

    // URL field with Connect button
    NSTextField *urlLabel = [self createLabel:@"URL:"
                                        frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [controlServerBox addSubview:urlLabel];

    self.controlServerAddressField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 100, 24)];
    self.controlServerAddressField.placeholderString = @"https://control.example.com";
    self.controlServerAddressField.stringValue = [self loadSetting:kControlServerAddressKey defaultValue:@""];
    self.controlServerAddressField.delegate = self;
    [controlServerBox addSubview:self.controlServerAddressField];

    // Connect button
    self.connectButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth + controlWidth - 95, boxY, 80, 24)];
    self.connectButton.title = @"Connect";
    self.connectButton.bezelStyle = NSBezelStyleRounded;
    self.connectButton.target = self;
    self.connectButton.action = @selector(connectControlServer:);
    [controlServerBox addSubview:self.connectButton];
    boxY -= rowHeight + 5;

    // Health status label
    self.healthStatusLabel = [self createLabel:@"Health: --"
                                         frame:NSMakeRect(boxPadding, boxY, controlWidth / 2, 20)];
    self.healthStatusLabel.textColor = [NSColor secondaryLabelColor];
    [controlServerBox addSubview:self.healthStatusLabel];

    // Connection status label
    self.connectionStatusLabel = [self createLabel:@"Status: Not connected"
                                             frame:NSMakeRect(boxPadding + controlWidth / 2, boxY, controlWidth / 2, 20)];
    self.connectionStatusLabel.textColor = [NSColor secondaryLabelColor];
    [controlServerBox addSubview:self.connectionStatusLabel];

    y -= 115;

    // Service Status Section (Background Service)
    NSBox *serviceBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 100, tabWidth - padding * 2, 110)];
    serviceBox.title = @"Background Service";
    serviceBox.titlePosition = NSAtTop;
    [tabView addSubview:serviceBox];

    boxY = 65;

    // Service connection status with indicator
    self.serviceStatusIndicator = [[NSImageView alloc] initWithFrame:NSMakeRect(boxPadding, boxY, 12, 12)];
    self.serviceStatusIndicator.image = [NSImage imageWithSystemSymbolName:@"circle.fill" accessibilityDescription:@"Status"];
    self.serviceStatusIndicator.contentTintColor = [NSColor systemGrayColor];
    [serviceBox addSubview:self.serviceStatusIndicator];

    self.serviceStatusLabel = [self createLabel:@"Service: Checking..."
                                          frame:NSMakeRect(boxPadding + 18, boxY - 4, tabWidth - padding * 2 - boxPadding * 2 - 20, 20)];
    [serviceBox addSubview:self.serviceStatusLabel];
    boxY -= 25;

    // Run at Login checkbox
    self.runAtLoginCheckbox = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    self.runAtLoginCheckbox.title = @"Start ScreenControl at login";
    [self.runAtLoginCheckbox setButtonType:NSButtonTypeSwitch];
    self.runAtLoginCheckbox.state = [self isRunAtLoginEnabled] ? NSControlStateValueOn : NSControlStateValueOff;
    self.runAtLoginCheckbox.target = self;
    self.runAtLoginCheckbox.action = @selector(runAtLoginCheckboxChanged:);
    [serviceBox addSubview:self.runAtLoginCheckbox];
    boxY -= 25;

    // Service info label
    NSTextField *serviceInfoLabel = [self createLabel:@"The background service handles remote connections and survives screen lock."
                                                frame:NSMakeRect(boxPadding, boxY - 5, tabWidth - padding * 2 - boxPadding * 2, 30)];
    serviceInfoLabel.textColor = [NSColor secondaryLabelColor];
    serviceInfoLabel.font = [NSFont systemFontOfSize:10];
    [serviceBox addSubview:serviceInfoLabel];

    y -= 120;

    // Status Section
    NSBox *statusBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 70, tabWidth - padding * 2, 80)];
    statusBox.title = @"Status";
    statusBox.titlePosition = NSAtTop;
    [tabView addSubview:statusBox];

    boxY = 35;

    self.statusLabel = [self createLabel:@"Server: Starting..."
                                   frame:NSMakeRect(boxPadding, boxY, tabWidth - padding * 2 - boxPadding * 2, 20)];
    [statusBox addSubview:self.statusLabel];
    boxY -= 25;

    self.uptimeLabel = [self createLabel:@"Uptime: 0s"
                                   frame:NSMakeRect(boxPadding, boxY, tabWidth - padding * 2 - boxPadding * 2, 20)];
    self.uptimeLabel.textColor = [NSColor secondaryLabelColor];
    [statusBox addSubview:self.uptimeLabel];

    return tabView;
}

- (NSView *)createToolsTabView {
    CGFloat tabWidth = 600;
    CGFloat tabHeight = 650;
    NSView *tabView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, tabWidth, tabHeight)];

    CGFloat padding = 20;

    // Create scroll view for tools list
    self.toolsScrollView = [[NSScrollView alloc] initWithFrame:NSMakeRect(padding, 20, tabWidth - padding * 2, tabHeight - 40)];
    self.toolsScrollView.hasVerticalScroller = YES;
    self.toolsScrollView.autohidesScrollers = YES;
    self.toolsScrollView.borderType = NSBezelBorder;

    // Tools configuration should already be loaded in applicationDidFinishLaunching
    // Only load if it hasn't been loaded yet
    if (!self.toolsConfig) {
        [self loadToolsConfig];
    }

    // Calculate total height needed first (two-pass approach to avoid layout recursion)
    CGFloat calculatedHeight = 20;
    NSArray *categories = @[
        @{@"id": @"gui", @"name": @"GUI & Accessibility"},
        @{@"id": @"browser", @"name": @"Browser Automation"},
        @{@"id": @"filesystem", @"name": @"File System"},
        @{@"id": @"shell", @"name": @"Shell Commands"}
    ];

    // First pass: calculate total height needed
    for (NSDictionary *category in categories) {
        NSString *categoryId = category[@"id"];
        NSArray *categoryTools = [self getToolsForCategory:categoryId];
        CGFloat boxHeight = 50 + (categoryTools.count * 25);
        calculatedHeight += boxHeight + 15; // spacing between boxes
    }

    // Create document view with correct height from the start
    NSView *documentView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, tabWidth - padding * 2 - 20, calculatedHeight)];

    // Second pass: add category boxes
    CGFloat y = 20;
    for (NSDictionary *category in categories) {
        NSString *categoryId = category[@"id"];
        NSString *categoryName = category[@"name"];

        // Get tools for this category
        NSArray *categoryTools = [self getToolsForCategory:categoryId];

        y = [self addCategoryBox:categoryName
                      categoryId:categoryId
                           tools:categoryTools
                          toView:documentView
                            atY:y];
        y += 15; // spacing between boxes
    }

    // Set document view after all content is added (no frame changes after this)
    self.toolsScrollView.documentView = documentView;
    [tabView addSubview:self.toolsScrollView];

    return tabView;
}

- (NSView *)createPermissionsTabView {
    CGFloat tabWidth = 600;
    CGFloat tabHeight = 650;
    NSView *tabView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, tabWidth, tabHeight)];

    CGFloat padding = 20;
    CGFloat y = tabHeight - 40;

    // Permissions Section
    NSBox *permBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 90, tabWidth - padding * 2, 100)];
    permBox.title = @"Permissions";
    permBox.titlePosition = NSAtTop;
    [tabView addSubview:permBox];

    CGFloat boxPadding = 15;
    CGFloat boxY = 55;

    self.accessibilityIndicator = [[NSImageView alloc] initWithFrame:NSMakeRect(boxPadding, boxY, 20, 20)];
    [permBox addSubview:self.accessibilityIndicator];

    self.accessibilityLabel = [self createLabel:@"Accessibility"
                                          frame:NSMakeRect(boxPadding + 25, boxY, 150, 20)];
    [permBox addSubview:self.accessibilityLabel];

    NSButton *grantAccessBtn = [[NSButton alloc] initWithFrame:NSMakeRect(tabWidth - padding * 2 - 100, boxY, 80, 24)];
    grantAccessBtn.title = @"Grant";
    grantAccessBtn.bezelStyle = NSBezelStyleRounded;
    grantAccessBtn.target = self;
    grantAccessBtn.action = @selector(openAccessibilityPrefs:);
    [permBox addSubview:grantAccessBtn];
    boxY -= 30;

    self.screenRecordingIndicator = [[NSImageView alloc] initWithFrame:NSMakeRect(boxPadding, boxY, 20, 20)];
    [permBox addSubview:self.screenRecordingIndicator];

    self.screenRecordingLabel = [self createLabel:@"Screen Recording"
                                            frame:NSMakeRect(boxPadding + 25, boxY, 150, 20)];
    [permBox addSubview:self.screenRecordingLabel];

    NSButton *grantScreenBtn = [[NSButton alloc] initWithFrame:NSMakeRect(tabWidth - padding * 2 - 100, boxY, 80, 24)];
    grantScreenBtn.title = @"Grant";
    grantScreenBtn.bezelStyle = NSBezelStyleRounded;
    grantScreenBtn.target = self;
    grantScreenBtn.action = @selector(openScreenRecordingPrefs:);
    [permBox addSubview:grantScreenBtn];

    return tabView;
}

- (NSView *)createDebugTabView {
    CGFloat tabWidth = 600;
    CGFloat tabHeight = 750;  // Increased for OAuth section
    NSView *tabView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, tabWidth, tabHeight)];

    CGFloat padding = 20;
    CGFloat labelWidth = 120;
    CGFloat controlWidth = tabWidth - padding * 2 - labelWidth - 10;
    CGFloat rowHeight = 30;
    CGFloat y = tabHeight - 50;
    CGFloat boxPadding = 15;
    CGFloat boxY;

    // OAuth Join Section (Join by URL - like Claude MCP)
    NSBox *oauthBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 100, tabWidth - padding * 2, 110)];
    oauthBox.title = @"Join by URL (OAuth Discovery)";
    oauthBox.titlePosition = NSAtTop;
    [tabView addSubview:oauthBox];

    boxY = 65;

    // MCP URL field
    NSTextField *mcpUrlLabel = [self createLabel:@"MCP URL:"
                                           frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [oauthBox addSubview:mcpUrlLabel];

    self.debugMcpUrlField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 130, 24)];
    self.debugMcpUrlField.placeholderString = @"https://screencontrol.knws.co.uk/mcp/<uuid>";
    self.debugMcpUrlField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    [oauthBox addSubview:self.debugMcpUrlField];

    // Discover & Join button
    self.debugDiscoverButton = [[NSButton alloc] initWithFrame:NSMakeRect(controlWidth - 5, boxY - 3, 120, 28)];
    self.debugDiscoverButton.title = @"Discover & Join";
    self.debugDiscoverButton.bezelStyle = NSBezelStyleRounded;
    self.debugDiscoverButton.target = self;
    self.debugDiscoverButton.action = @selector(discoverAndJoinClicked:);
    [oauthBox addSubview:self.debugDiscoverButton];
    boxY -= rowHeight + 5;

    // OAuth status
    self.debugOAuthStatusLabel = [self createLabel:@"OAuth: Not configured"
                                             frame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    self.debugOAuthStatusLabel.textColor = [NSColor secondaryLabelColor];
    [oauthBox addSubview:self.debugOAuthStatusLabel];

    y -= 120;

    // ScreenControl Connection Section (Manual/Debug)
    NSBox *connectionBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 200, tabWidth - padding * 2, 210)];
    connectionBox.title = @"Manual Connection (Debug)";
    connectionBox.titlePosition = NSAtTop;
    [tabView addSubview:connectionBox];

    boxY = 165;

    // Server URL
    NSTextField *urlLabel = [self createLabel:@"Server URL:"
                                        frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [connectionBox addSubview:urlLabel];

    self.debugServerUrlField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 20, 24)];
    self.debugServerUrlField.placeholderString = @"wss://screencontrol.knws.co.uk/ws";
    self.debugServerUrlField.stringValue = @"wss://screencontrol.knws.co.uk/ws";
    [connectionBox addSubview:self.debugServerUrlField];
    boxY -= rowHeight + 5;

    // Endpoint UUID (simulates stamped build)
    NSTextField *endpointLabel = [self createLabel:@"Endpoint UUID:"
                                             frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [connectionBox addSubview:endpointLabel];

    self.debugEndpointUuidField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 20, 24)];
    self.debugEndpointUuidField.placeholderString = @"From MCP connection in dashboard";
    self.debugEndpointUuidField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    [connectionBox addSubview:self.debugEndpointUuidField];
    boxY -= rowHeight + 5;

    // Customer ID (optional)
    NSTextField *customerLabel = [self createLabel:@"Customer ID:"
                                             frame:NSMakeRect(boxPadding, boxY, labelWidth, rowHeight)];
    [connectionBox addSubview:customerLabel];

    self.debugCustomerIdField = [[NSTextField alloc] initWithFrame:NSMakeRect(boxPadding + labelWidth, boxY, controlWidth - 20, 24)];
    self.debugCustomerIdField.placeholderString = @"Optional - User ID from dashboard";
    self.debugCustomerIdField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    [connectionBox addSubview:self.debugCustomerIdField];
    boxY -= rowHeight + 10;

    // Connect/Disconnect buttons
    self.debugConnectButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding, boxY, 100, 32)];
    self.debugConnectButton.title = @"Connect";
    self.debugConnectButton.bezelStyle = NSBezelStyleRounded;
    self.debugConnectButton.target = self;
    self.debugConnectButton.action = @selector(debugConnect:);
    [connectionBox addSubview:self.debugConnectButton];

    self.debugDisconnectButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + 110, boxY, 100, 32)];
    self.debugDisconnectButton.title = @"Disconnect";
    self.debugDisconnectButton.bezelStyle = NSBezelStyleRounded;
    self.debugDisconnectButton.target = self;
    self.debugDisconnectButton.action = @selector(debugDisconnect:);
    self.debugDisconnectButton.enabled = NO;
    [connectionBox addSubview:self.debugDisconnectButton];

    // Reconnect button (for forcing immediate reconnection)
    self.debugReconnectButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + 220, boxY, 100, 32)];
    self.debugReconnectButton.title = @"Reconnect";
    self.debugReconnectButton.bezelStyle = NSBezelStyleRounded;
    self.debugReconnectButton.target = self;
    self.debugReconnectButton.action = @selector(debugReconnectClicked:);
    self.debugReconnectButton.enabled = NO;  // Enabled when connected or during reconnect attempts
    [connectionBox addSubview:self.debugReconnectButton];

    // Save Settings button
    NSButton *saveSettingsButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + 330, boxY, 70, 32)];
    saveSettingsButton.title = @"Save";
    saveSettingsButton.bezelStyle = NSBezelStyleRounded;
    saveSettingsButton.target = self;
    saveSettingsButton.action = @selector(debugSaveSettingsClicked:);
    [connectionBox addSubview:saveSettingsButton];

    // Copy MCP URL button
    NSButton *copyMcpUrlButton = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + 410, boxY, 110, 32)];
    copyMcpUrlButton.title = @"Copy MCP URL";
    copyMcpUrlButton.bezelStyle = NSBezelStyleRounded;
    copyMcpUrlButton.target = self;
    copyMcpUrlButton.action = @selector(copyMcpUrl:);
    [connectionBox addSubview:copyMcpUrlButton];
    boxY -= rowHeight + 5;

    // Connect on startup checkbox
    self.debugConnectOnStartupCheckbox = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    self.debugConnectOnStartupCheckbox.title = @"Connect automatically on app startup";
    [self.debugConnectOnStartupCheckbox setButtonType:NSButtonTypeSwitch];
    self.debugConnectOnStartupCheckbox.state = [[NSUserDefaults standardUserDefaults] boolForKey:@"debugConnectOnStartup"] ? NSControlStateValueOn : NSControlStateValueOff;
    [connectionBox addSubview:self.debugConnectOnStartupCheckbox];
    boxY -= rowHeight + 5;

    // NOTE: Bypass mode checkbox removed - service now handles heartbeats
    boxY -= 5;

    // Connection status
    self.debugConnectionStatusLabel = [self createLabel:@"Status: Not connected"
                                                  frame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    self.debugConnectionStatusLabel.textColor = [NSColor secondaryLabelColor];
    [connectionBox addSubview:self.debugConnectionStatusLabel];

    y -= 220;

    // Status Section
    NSBox *statusBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, y - 80, tabWidth - padding * 2, 90)];
    statusBox.title = @"Agent Status";
    statusBox.titlePosition = NSAtTop;
    [tabView addSubview:statusBox];

    boxY = 45;

    self.debugLicenseStatusLabel = [self createLabel:@"License: --"
                                               frame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    [statusBox addSubview:self.debugLicenseStatusLabel];
    boxY -= 25;

    self.debugAgentIdLabel = [self createLabel:@"Agent ID: --"
                                         frame:NSMakeRect(boxPadding, boxY, controlWidth, 20)];
    self.debugAgentIdLabel.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    [statusBox addSubview:self.debugAgentIdLabel];

    y -= 100;

    // Log Section
    NSBox *logBox = [[NSBox alloc] initWithFrame:NSMakeRect(padding, 20, tabWidth - padding * 2, y - 30)];
    logBox.title = @"Connection Log";
    logBox.titlePosition = NSAtTop;
    [tabView addSubview:logBox];

    NSScrollView *logScrollView = [[NSScrollView alloc] initWithFrame:NSMakeRect(10, 10, logBox.frame.size.width - 20, logBox.frame.size.height - 35)];
    logScrollView.hasVerticalScroller = YES;
    logScrollView.autohidesScrollers = YES;
    logScrollView.borderType = NSBezelBorder;

    self.debugLogView = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, logScrollView.contentSize.width, logScrollView.contentSize.height)];
    self.debugLogTextView = self.debugLogView;  // Alias for TestServer
    self.debugLogView.editable = NO;
    self.debugLogView.font = [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular];
    self.debugLogView.backgroundColor = [NSColor textBackgroundColor];
    [self.debugLogView setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    logScrollView.documentView = self.debugLogView;
    [logBox addSubview:logScrollView];

    return tabView;
}

#pragma mark - Debug WebSocket Connection

- (NSString *)getMachineId {
    // Get hardware UUID as machine ID
    io_service_t platformExpert = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"));
    if (platformExpert) {
        CFTypeRef serialNumberAsCFString = IORegistryEntryCreateCFProperty(platformExpert, CFSTR(kIOPlatformUUIDKey), kCFAllocatorDefault, 0);
        IOObjectRelease(platformExpert);
        if (serialNumberAsCFString) {
            NSString *uuid = (__bridge_transfer NSString *)serialNumberAsCFString;
            return uuid;
        }
    }
    return [[NSUUID UUID] UUIDString]; // Fallback
}

- (void)debugLog:(NSString *)message {
    // Also write to file
    [self fileLog:message];

    dispatch_async(dispatch_get_main_queue(), ^{
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"HH:mm:ss";
        NSString *timestamp = [formatter stringFromDate:[NSDate date]];
        NSString *logLine = [NSString stringWithFormat:@"[%@] %@\n", timestamp, message];

        NSAttributedString *attrStr = [[NSAttributedString alloc] initWithString:logLine attributes:@{
            NSFontAttributeName: [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular],
            NSForegroundColorAttributeName: [NSColor textColor]
        }];
        [[self.debugLogView textStorage] appendAttributedString:attrStr];
        [self.debugLogView scrollRangeToVisible:NSMakeRange(self.debugLogView.string.length, 0)];
    });
}

- (void)fileLog:(NSString *)message {
    @try {
        if (!self.logFilePath) return;

        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
        NSString *timestamp = [formatter stringFromDate:[NSDate date]];
        NSString *logLine = [NSString stringWithFormat:@"[%@] %@\n", timestamp, message];

        NSFileHandle *fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.logFilePath];
        if (fileHandle) {
            [fileHandle seekToEndOfFile];
            [fileHandle writeData:[logLine dataUsingEncoding:NSUTF8StringEncoding]];
            [fileHandle closeFile];
        } else {
            [logLine writeToFile:self.logFilePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        }
    } @catch (NSException *exception) {
        NSLog(@"Failed to write to log file: %@", exception);
    }
}

- (void)debugConnect:(id)sender {
    NSLog(@"[DEBUG] ========== debugConnect called (via Service) ==========");

    // Check if service is available first
    if (!self.serviceClient.isServiceAvailable) {
        [self debugLog:@"ERROR: Service not available. Please start the ScreenControl service first."];
        self.debugConnectionStatusLabel.stringValue = @"Status: Service not running";
        self.debugConnectionStatusLabel.textColor = [NSColor systemRedColor];
        return;
    }

    NSString *serverUrl = self.debugServerUrlField.stringValue;
    if (serverUrl.length == 0) {
        serverUrl = @"wss://screencontrol.knws.co.uk/ws";
    }

    NSString *endpointUuid = self.debugEndpointUuidField.stringValue;
    NSString *customerId = self.debugCustomerIdField.stringValue;
    NSString *agentName = self.agentNameField.stringValue ?: [[NSHost currentHost] localizedName];

    [self debugLog:[NSString stringWithFormat:@"Connecting to %@ via service...", serverUrl]];

    // Update UI
    self.debugConnectButton.enabled = NO;
    self.debugDisconnectButton.enabled = YES;
    self.debugReconnectButton.enabled = NO;
    self.debugConnectionStatusLabel.stringValue = @"Status: Connecting...";
    self.debugConnectionStatusLabel.textColor = [NSColor systemOrangeColor];

    // Build connection config
    NSDictionary *config = @{
        @"serverUrl": serverUrl,
        @"endpointUuid": endpointUuid ?: @"",
        @"customerId": customerId ?: @"",
        @"agentName": agentName ?: @""
    };

    // Connect via service
    __weak typeof(self) weakSelf = self;
    [self.serviceClient connectToControlServerWithConfig:config completion:^(BOOL success, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (success) {
                [weakSelf debugLog:@"Connection request sent to service"];
                // Status will be updated via ServiceClient delegate callbacks
            } else {
                [weakSelf debugLog:[NSString stringWithFormat:@"ERROR: Failed to connect - %@", error.localizedDescription]];
                weakSelf.debugConnectButton.enabled = YES;
                weakSelf.debugDisconnectButton.enabled = NO;
                weakSelf.debugConnectionStatusLabel.stringValue = @"Status: Connection failed";
                weakSelf.debugConnectionStatusLabel.textColor = [NSColor systemRedColor];
            }
        });
    }];
}

- (void)debugDisconnect:(id)sender {
    [self debugLog:@"Disconnecting via service..."];

    // Update UI immediately
    self.debugConnectButton.enabled = NO;
    self.debugDisconnectButton.enabled = NO;
    self.debugReconnectButton.enabled = NO;
    self.debugConnectionStatusLabel.stringValue = @"Status: Disconnecting...";
    self.debugConnectionStatusLabel.textColor = [NSColor systemOrangeColor];

    // Disconnect via service
    __weak typeof(self) weakSelf = self;
    [self.serviceClient disconnectFromControlServerWithCompletion:^(BOOL success, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            weakSelf.debugIsConnected = NO;
            weakSelf.debugConnectButton.enabled = YES;
            weakSelf.debugDisconnectButton.enabled = NO;
            weakSelf.debugReconnectButton.enabled = NO;
            weakSelf.debugConnectionStatusLabel.stringValue = @"Status: Disconnected";
            weakSelf.debugConnectionStatusLabel.textColor = [NSColor secondaryLabelColor];
            weakSelf.debugLicenseStatusLabel.stringValue = @"License: --";
            weakSelf.debugAgentIdLabel.stringValue = @"Agent ID: --";

            // Update General tab connection status
            weakSelf.connectionStatusLabel.stringValue = @"Status: Not connected";
            weakSelf.connectionStatusLabel.textColor = [NSColor secondaryLabelColor];
            weakSelf.connectButton.enabled = YES;

            [weakSelf debugLog:@"Disconnected"];
        });
    }];
}

#pragma mark - Reconnect (via Service)

- (IBAction)debugReconnectClicked:(id)sender {
    [self debugLog:@"Manual reconnect requested via service"];

    // Update UI
    self.debugConnectButton.enabled = NO;
    self.debugDisconnectButton.enabled = NO;
    self.debugReconnectButton.enabled = NO;
    self.debugConnectionStatusLabel.stringValue = @"Status: Reconnecting...";
    self.debugConnectionStatusLabel.textColor = [NSColor systemOrangeColor];

    // Ask service to reconnect - it handles the WebSocket connection
    // We simply call connect again with the current settings
    [self debugConnect:nil];
}

#pragma mark - OAuth Discovery and Connection

- (void)discoverAndJoinClicked:(id)sender {
    NSString *mcpUrl = self.debugMcpUrlField.stringValue;
    if (mcpUrl.length == 0) {
        [self debugLog:@"ERROR: Please enter an MCP URL"];
        self.debugOAuthStatusLabel.stringValue = @"OAuth: Enter MCP URL first";
        self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
        return;
    }

    [self debugLog:[NSString stringWithFormat:@"Discovering OAuth from: %@", mcpUrl]];
    self.debugOAuthStatusLabel.stringValue = @"OAuth: Discovering...";
    self.debugOAuthStatusLabel.textColor = [NSColor systemOrangeColor];
    self.debugDiscoverButton.enabled = NO;

    [self discoverOAuthFromMcpUrl:mcpUrl];
}

- (void)discoverOAuthFromMcpUrl:(NSString *)mcpUrl {
    // Parse the MCP URL to extract base URL and endpoint UUID
    // Format: https://screencontrol.knws.co.uk/mcp/<uuid>
    NSURL *url = [NSURL URLWithString:mcpUrl];
    if (!url) {
        [self debugLog:@"ERROR: Invalid MCP URL format"];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: Invalid URL";
            self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
            self.debugDiscoverButton.enabled = YES;
        });
        return;
    }

    // Extract base URL and UUID from path
    NSString *scheme = url.scheme;
    NSString *host = url.host;
    NSNumber *port = url.port;
    NSString *path = url.path;

    // Build base URL
    NSString *baseUrl;
    if (port) {
        baseUrl = [NSString stringWithFormat:@"%@://%@:%@", scheme, host, port];
    } else {
        baseUrl = [NSString stringWithFormat:@"%@://%@", scheme, host];
    }
    self.mcpBaseUrl = baseUrl;

    // Extract UUID from path (e.g., /mcp/cmivv9aar000310vcfp9lg0qj)
    NSArray *pathComponents = [path componentsSeparatedByString:@"/"];
    if (pathComponents.count >= 3 && [pathComponents[1] isEqualToString:@"mcp"]) {
        self.mcpEndpointUuid = pathComponents[2];
        [self debugLog:[NSString stringWithFormat:@"Extracted UUID: %@", self.mcpEndpointUuid]];
    } else {
        [self debugLog:@"WARNING: Could not extract UUID from path"];
    }

    // Fetch OAuth discovery document from .well-known endpoint
    NSString *discoveryUrl = [NSString stringWithFormat:@"%@/.well-known/oauth-authorization-server", baseUrl];
    [self debugLog:[NSString stringWithFormat:@"Fetching: %@", discoveryUrl]];

    NSURL *discoverURL = [NSURL URLWithString:discoveryUrl];
    NSURLSessionDataTask *task = [self.urlSession dataTaskWithURL:discoverURL completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self debugLog:[NSString stringWithFormat:@"ERROR: Discovery failed: %@", error.localizedDescription]];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Discovery failed";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        if (httpResponse.statusCode != 200) {
            [self debugLog:[NSString stringWithFormat:@"ERROR: Discovery returned %ld", (long)httpResponse.statusCode]];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = [NSString stringWithFormat:@"OAuth: HTTP %ld", (long)httpResponse.statusCode];
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSError *jsonError;
        NSDictionary *discovery = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
        if (jsonError || !discovery) {
            [self debugLog:@"ERROR: Failed to parse discovery JSON"];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Invalid JSON";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        // Extract OAuth endpoints
        self.oauthIssuer = discovery[@"issuer"];
        self.oauthAuthorizationEndpoint = discovery[@"authorization_endpoint"];
        self.oauthTokenEndpoint = discovery[@"token_endpoint"];
        self.oauthRegistrationEndpoint = discovery[@"registration_endpoint"];

        [self debugLog:[NSString stringWithFormat:@"Discovered issuer: %@", self.oauthIssuer]];
        [self debugLog:[NSString stringWithFormat:@"Token endpoint: %@", self.oauthTokenEndpoint]];
        [self debugLog:[NSString stringWithFormat:@"Registration endpoint: %@", self.oauthRegistrationEndpoint]];

        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: Discovered, registering...";
            self.debugOAuthStatusLabel.textColor = [NSColor systemOrangeColor];
        });

        // Check if we have stored credentials for this endpoint
        [self loadOAuthCredentialsFromKeychain];

        if (self.oauthClientId && self.oauthClientSecret) {
            [self debugLog:@"Found stored OAuth credentials, requesting token..."];
            [self requestOAuthToken];
        } else {
            [self debugLog:@"No stored credentials, registering new client..."];
            [self registerOAuthClient];
        }
    }];
    [task resume];
}

- (void)registerOAuthClient {
    if (!self.oauthRegistrationEndpoint) {
        [self debugLog:@"ERROR: No registration endpoint discovered"];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: No registration endpoint";
            self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
            self.debugDiscoverButton.enabled = YES;
        });
        return;
    }

    [self debugLog:@"Registering OAuth client..."];

    // Build registration request
    NSString *hostname = [[NSHost currentHost] localizedName];
    NSString *machineId = [self getMachineId];

    NSDictionary *regRequest = @{
        @"client_name": [NSString stringWithFormat:@"ScreenControl Agent - %@", hostname],
        @"grant_types": @[@"client_credentials"],
        @"token_endpoint_auth_method": @"client_secret_basic",
        @"scope": @"mcp:tools mcp:resources mcp:agents:read mcp:agents:write",
        @"software_id": @"screencontrol-agent-macos",
        @"software_version": @"1.0.0",
        @"client_uri": [NSString stringWithFormat:@"local://%@", machineId],
        // Redirect URIs required by server even for client_credentials (localhost allowed)
        @"redirect_uris": @[@"http://localhost/oauth/callback"],
        // Include endpoint UUID if we have it (links this client to the MCP endpoint)
        @"mcp_endpoint_uuid": self.mcpEndpointUuid ?: @""
    };

    NSError *jsonError;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:regRequest options:0 error:&jsonError];
    if (jsonError) {
        [self debugLog:@"ERROR: Failed to serialize registration request"];
        return;
    }

    NSURL *regUrl = [NSURL URLWithString:self.oauthRegistrationEndpoint];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:regUrl];
    request.HTTPMethod = @"POST";
    request.HTTPBody = jsonData;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

    NSURLSessionDataTask *task = [self.urlSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self debugLog:[NSString stringWithFormat:@"ERROR: Registration failed: %@", error.localizedDescription]];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Registration failed";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        if (httpResponse.statusCode != 201 && httpResponse.statusCode != 200) {
            NSString *responseBody = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            [self debugLog:[NSString stringWithFormat:@"ERROR: Registration returned %ld: %@", (long)httpResponse.statusCode, responseBody]];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = [NSString stringWithFormat:@"OAuth: Reg failed (%ld)", (long)httpResponse.statusCode];
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSError *parseError;
        NSDictionary *regResponse = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
        if (parseError || !regResponse) {
            [self debugLog:@"ERROR: Failed to parse registration response"];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Invalid response";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        // Extract client credentials
        self.oauthClientId = regResponse[@"client_id"];
        self.oauthClientSecret = regResponse[@"client_secret"];

        if (!self.oauthClientId || !self.oauthClientSecret) {
            [self debugLog:@"ERROR: Registration response missing credentials"];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Missing credentials in response";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        [self debugLog:[NSString stringWithFormat:@"Registered client_id: %@", self.oauthClientId]];

        // Save credentials to keychain
        [self saveOAuthCredentialsToKeychain];

        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: Registered, getting token...";
        });

        // Now request an access token
        [self requestOAuthToken];
    }];
    [task resume];
}

- (void)requestOAuthToken {
    if (!self.oauthTokenEndpoint || !self.oauthClientId || !self.oauthClientSecret) {
        [self debugLog:@"ERROR: Missing OAuth configuration for token request"];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: Missing configuration";
            self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
            self.debugDiscoverButton.enabled = YES;
        });
        return;
    }

    [self debugLog:@"Requesting OAuth access token..."];

    // Build token request (client_credentials grant)
    NSString *body = [NSString stringWithFormat:@"grant_type=client_credentials&scope=%@",
                      [@"mcp:tools mcp:resources mcp:agents:read mcp:agents:write" stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLQueryAllowedCharacterSet]]];

    NSURL *tokenUrl = [NSURL URLWithString:self.oauthTokenEndpoint];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:tokenUrl];
    request.HTTPMethod = @"POST";
    request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
    [request setValue:@"application/x-www-form-urlencoded" forHTTPHeaderField:@"Content-Type"];

    // Add Basic auth header with client credentials
    NSString *credentials = [NSString stringWithFormat:@"%@:%@", self.oauthClientId, self.oauthClientSecret];
    NSData *credData = [credentials dataUsingEncoding:NSUTF8StringEncoding];
    NSString *base64Creds = [credData base64EncodedStringWithOptions:0];
    [request setValue:[NSString stringWithFormat:@"Basic %@", base64Creds] forHTTPHeaderField:@"Authorization"];

    NSURLSessionDataTask *task = [self.urlSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            [self debugLog:[NSString stringWithFormat:@"ERROR: Token request failed: %@", error.localizedDescription]];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Token request failed";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        if (httpResponse.statusCode != 200) {
            NSString *responseBody = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            [self debugLog:[NSString stringWithFormat:@"ERROR: Token request returned %ld: %@", (long)httpResponse.statusCode, responseBody]];

            // If unauthorized, clear stored credentials and re-register
            if (httpResponse.statusCode == 401) {
                [self debugLog:@"Credentials invalid, clearing and re-registering..."];
                [self clearOAuthCredentials];
                dispatch_async(dispatch_get_main_queue(), ^{
                    self.debugOAuthStatusLabel.stringValue = @"OAuth: Re-registering...";
                });
                [self registerOAuthClient];
                return;
            }

            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = [NSString stringWithFormat:@"OAuth: Token failed (%ld)", (long)httpResponse.statusCode];
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        NSError *parseError;
        NSDictionary *tokenResponse = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
        if (parseError || !tokenResponse) {
            [self debugLog:@"ERROR: Failed to parse token response"];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: Invalid token response";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        // Extract access token
        self.oauthAccessToken = tokenResponse[@"access_token"];
        NSNumber *expiresIn = tokenResponse[@"expires_in"];

        if (!self.oauthAccessToken) {
            [self debugLog:@"ERROR: Token response missing access_token"];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.debugOAuthStatusLabel.stringValue = @"OAuth: No token in response";
                self.debugOAuthStatusLabel.textColor = [NSColor systemRedColor];
                self.debugDiscoverButton.enabled = YES;
            });
            return;
        }

        // Calculate token expiry and schedule refresh
        if (expiresIn) {
            self.oauthTokenExpiry = [NSDate dateWithTimeIntervalSinceNow:expiresIn.doubleValue];
            [self debugLog:[NSString stringWithFormat:@"Token expires in %@ seconds", expiresIn]];

            // Schedule token refresh at 90% of expiry time (or 5 minutes before, whichever is less)
            NSTimeInterval refreshDelay = MIN(expiresIn.doubleValue * 0.9, expiresIn.doubleValue - 300);
            if (refreshDelay < 60) refreshDelay = 60; // At minimum, wait 60 seconds before refresh

            dispatch_async(dispatch_get_main_queue(), ^{
                [self.oauthRefreshTimer invalidate];
                self.oauthRefreshTimer = [NSTimer scheduledTimerWithTimeInterval:refreshDelay
                                                                          target:self
                                                                        selector:@selector(oauthRefreshTokenIfNeeded)
                                                                        userInfo:nil
                                                                         repeats:NO];
                [self debugLog:[NSString stringWithFormat:@"Scheduled token refresh in %.0f seconds", refreshDelay]];
            });
        }

        [self debugLog:@"OAuth token obtained successfully!"];

        dispatch_async(dispatch_get_main_queue(), ^{
            self.debugOAuthStatusLabel.stringValue = @"OAuth: Connected!";
            self.debugOAuthStatusLabel.textColor = [NSColor systemGreenColor];
            self.debugDiscoverButton.enabled = YES;

            // Auto-fill the manual connection fields
            if (self.mcpBaseUrl) {
                self.debugServerUrlField.stringValue = [NSString stringWithFormat:@"%@/ws", [self.mcpBaseUrl stringByReplacingOccurrencesOfString:@"http://" withString:@"ws://"]];
                self.debugServerUrlField.stringValue = [self.debugServerUrlField.stringValue stringByReplacingOccurrencesOfString:@"https://" withString:@"wss://"];
            }
            if (self.mcpEndpointUuid) {
                self.debugEndpointUuidField.stringValue = self.mcpEndpointUuid;
            }
        });

        // Connect using the OAuth token
        [self connectWithOAuthToken];
    }];
    [task resume];
}

- (void)oauthRefreshTokenIfNeeded {
    [self debugLog:@"Token refresh timer fired - checking if refresh needed..."];

    // Check if we have the necessary credentials to refresh
    if (!self.oauthTokenEndpoint || !self.oauthClientId || !self.oauthClientSecret) {
        [self debugLog:@"Cannot refresh token - missing OAuth configuration"];
        return;
    }

    // Check if token is actually expiring soon (within 5 minutes)
    if (self.oauthTokenExpiry) {
        NSTimeInterval timeUntilExpiry = [self.oauthTokenExpiry timeIntervalSinceNow];
        [self debugLog:[NSString stringWithFormat:@"Token expires in %.0f seconds", timeUntilExpiry]];

        if (timeUntilExpiry > 300) {
            [self debugLog:@"Token not expiring soon, skipping refresh"];
            return;
        }
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        self.debugOAuthStatusLabel.stringValue = @"OAuth: Refreshing token...";
        self.debugOAuthStatusLabel.textColor = [NSColor systemOrangeColor];
    });

    [self debugLog:@"Refreshing OAuth token..."];
    [self requestOAuthToken];
}

- (void)connectWithOAuthToken {
    if (!self.oauthAccessToken) {
        [self debugLog:@"ERROR: No OAuth token available"];
        return;
    }

    [self debugLog:@"Connecting with OAuth token..."];

    // Build WebSocket URL with token
    NSString *wsUrl = self.debugServerUrlField.stringValue;
    if (wsUrl.length == 0 && self.mcpBaseUrl) {
        wsUrl = [NSString stringWithFormat:@"%@/ws", [self.mcpBaseUrl stringByReplacingOccurrencesOfString:@"http://" withString:@"ws://"]];
        wsUrl = [wsUrl stringByReplacingOccurrencesOfString:@"https://" withString:@"wss://"];
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        self.debugServerUrlField.stringValue = wsUrl;

        // Set endpoint UUID
        if (self.mcpEndpointUuid) {
            self.debugEndpointUuidField.stringValue = self.mcpEndpointUuid;
        }

        // Trigger connection
        [self debugConnect:nil];
    });
}

#pragma mark - Keychain Helpers

static NSString * const kKeychainService = @"com.screencontrol.agent.oauth";

- (void)saveOAuthCredentialsToKeychain {
    if (!self.oauthClientId || !self.oauthClientSecret || !self.mcpBaseUrl) return;

    [self debugLog:@"Saving OAuth credentials to Keychain..."];

    // Create a unique account name based on the server URL
    NSString *account = [NSString stringWithFormat:@"%@::%@", self.mcpBaseUrl, self.mcpEndpointUuid ?: @"default"];

    // Store credentials as JSON
    NSDictionary *credentials = @{
        @"client_id": self.oauthClientId,
        @"client_secret": self.oauthClientSecret,
        @"endpoint_uuid": self.mcpEndpointUuid ?: @"",
        @"base_url": self.mcpBaseUrl
    };

    NSError *jsonError;
    NSData *credData = [NSJSONSerialization dataWithJSONObject:credentials options:0 error:&jsonError];
    if (jsonError) {
        [self debugLog:@"ERROR: Failed to serialize credentials for Keychain"];
        return;
    }

    // Delete any existing item first
    NSDictionary *deleteQuery = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: kKeychainService,
        (__bridge id)kSecAttrAccount: account
    };
    SecItemDelete((__bridge CFDictionaryRef)deleteQuery);

    // Add new item
    NSDictionary *addQuery = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: kKeychainService,
        (__bridge id)kSecAttrAccount: account,
        (__bridge id)kSecValueData: credData,
        (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlock
    };

    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)addQuery, NULL);
    if (status == errSecSuccess) {
        [self debugLog:@"OAuth credentials saved to Keychain"];
    } else {
        [self debugLog:[NSString stringWithFormat:@"WARNING: Failed to save to Keychain (status: %d)", (int)status]];
    }
}

- (void)loadOAuthCredentialsFromKeychain {
    if (!self.mcpBaseUrl) return;

    NSString *account = [NSString stringWithFormat:@"%@::%@", self.mcpBaseUrl, self.mcpEndpointUuid ?: @"default"];

    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: kKeychainService,
        (__bridge id)kSecAttrAccount: account,
        (__bridge id)kSecReturnData: @YES,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne
    };

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);

    if (status == errSecSuccess && result) {
        NSData *credData = (__bridge_transfer NSData *)result;
        NSError *jsonError;
        NSDictionary *credentials = [NSJSONSerialization JSONObjectWithData:credData options:0 error:&jsonError];

        if (!jsonError && credentials) {
            self.oauthClientId = credentials[@"client_id"];
            self.oauthClientSecret = credentials[@"client_secret"];
            [self debugLog:[NSString stringWithFormat:@"Loaded OAuth credentials from Keychain for %@", account]];
        }
    } else {
        [self debugLog:@"No stored OAuth credentials found"];
    }
}

- (void)clearOAuthCredentials {
    self.oauthClientId = nil;
    self.oauthClientSecret = nil;
    self.oauthAccessToken = nil;
    self.oauthTokenExpiry = nil;

    // Cancel any pending token refresh
    [self.oauthRefreshTimer invalidate];
    self.oauthRefreshTimer = nil;

    if (self.mcpBaseUrl) {
        NSString *account = [NSString stringWithFormat:@"%@::%@", self.mcpBaseUrl, self.mcpEndpointUuid ?: @"default"];

        NSDictionary *deleteQuery = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: kKeychainService,
            (__bridge id)kSecAttrAccount: account
        };
        SecItemDelete((__bridge CFDictionaryRef)deleteQuery);
        [self debugLog:@"Cleared OAuth credentials from Keychain"];
    }
}

// NOTE: debugSendRegistration, debugSendHeartbeat, and debugReceiveMessage have been removed
// The service (port 3459) now handles all WebSocket communication with the control server

// NOTE: debugNotifyToolsChanged now sends to service instead of direct WebSocket
- (void)debugNotifyToolsChanged {
    // Service handles WebSocket communication, but we can notify it of tool changes
    // via the HTTP API if needed. For now, just log the event.
    BOOL bridgeRunning = (self.browserBridgeServer && self.browserBridgeServer.isRunning) ||
                        (self.browserWebSocketServer && self.browserWebSocketServer.isRunning);
    NSLog(@"[Agent] Tools changed notification (browserBridge: %@)", bridgeRunning ? @"running" : @"stopped");
}

// NOTE: debugReceiveMessage has been removed - the service (port 3459) handles WebSocket communication

- (NSTextField *)createLabel:(NSString *)text frame:(NSRect)frame {
    NSTextField *label = [[NSTextField alloc] initWithFrame:frame];
    label.stringValue = text;
    label.bezeled = NO;
    label.drawsBackground = NO;
    label.editable = NO;
    label.selectable = NO;
    return label;
}

#pragma mark - Settings Management

- (NSString *)loadSetting:(NSString *)key defaultValue:(NSString *)defaultValue {
    NSString *value = [[NSUserDefaults standardUserDefaults] stringForKey:key];
    return value ?: defaultValue;
}

- (void)saveSetting:(NSString *)key value:(NSString *)value {
    [[NSUserDefaults standardUserDefaults] setObject:value forKey:key];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

- (NSString *)loadOrGenerateAPIKey {
    NSString *key = [[NSUserDefaults standardUserDefaults] stringForKey:kAPIKeyKey];
    if (!key || key.length == 0) {
        key = [self generateAPIKey];
        [self saveSetting:kAPIKeyKey value:key];
    }
    return key;
}

- (NSString *)generateAPIKey {
    NSMutableData *data = [NSMutableData dataWithLength:32];
    OSStatus status = SecRandomCopyBytes(kSecRandomDefault, 32, data.mutableBytes);
    if (status != errSecSuccess) {
        NSLog(@"Warning: SecRandomCopyBytes failed with status %d", (int)status);
    }

    NSMutableString *hexString = [NSMutableString stringWithCapacity:64];
    const unsigned char *bytes = data.bytes;
    for (int i = 0; i < 32; i++) {
        [hexString appendFormat:@"%02x", bytes[i]];
    }
    return hexString;
}

#pragma mark - Tools Configuration Management

- (NSString *)getToolsConfigPath {
    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    NSString *appSupportDir = [paths firstObject];
    NSString *screenControlDir = [appSupportDir stringByAppendingPathComponent:@"ScreenControl"];

    // Create directory if it doesn't exist
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:screenControlDir]) {
        [fileManager createDirectoryAtPath:screenControlDir withIntermediateDirectories:YES attributes:nil error:nil];
    }

    return [screenControlDir stringByAppendingPathComponent:kToolsConfigFilename];
}

- (void)loadToolsConfig {
    NSString *configPath = [self getToolsConfigPath];
    NSFileManager *fileManager = [NSFileManager defaultManager];

    if ([fileManager fileExistsAtPath:configPath]) {
        NSData *data = [NSData dataWithContentsOfFile:configPath];
        NSError *error = nil;
        NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];

        if (config && !error) {
            self.toolsConfig = [NSMutableDictionary dictionaryWithDictionary:config];
            
            BOOL needsSave = NO;
            
            // Migrate old "accessibility" category to "gui" if it exists
            if (self.toolsConfig[@"accessibility"] && !self.toolsConfig[@"gui"]) {
                NSLog(@"Migrating 'accessibility' category to 'gui'");
                self.toolsConfig[@"gui"] = self.toolsConfig[@"accessibility"];
                [self.toolsConfig removeObjectForKey:@"accessibility"];
                needsSave = YES;
            }
            
            // Ensure all expected categories exist with default tools
            BOOL categoriesChanged = [self ensureAllCategoriesExist];
            needsSave = needsSave || categoriesChanged;
            
            // Only save if we made changes
            if (needsSave) {
                [self saveToolsConfig];
            }
            
            NSLog(@"Loaded tools config from %@", configPath);
        } else {
            NSLog(@"Error loading tools config: %@", error);
            [self createDefaultToolsConfig];
        }
    } else {
        NSLog(@"No tools config found, creating default");
        [self createDefaultToolsConfig];
    }
}

- (BOOL)ensureAllCategoriesExist {
    // Get the complete list of tools from default config
    NSDictionary *defaultToolDefinitions = @{
        @"gui": @[
            @"listApplications",
            @"focusApplication",
            @"launchApplication",
            @"screenshot",
            @"screenshot_app",
            @"click",
            @"click_absolute",
            @"doubleClick",
            @"clickElement",
            @"moveMouse",
            @"scroll",
            @"scrollMouse",
            @"drag",
            @"getClickableElements",
            @"getUIElements",
            @"getMousePosition",
            @"typeText",
            @"pressKey",
            @"analyzeWithOCR",
            @"checkPermissions",
            @"closeApp",
            @"wait",
            @"system_info",
            @"window_list",
            @"clipboard_read",
            @"clipboard_write"
        ],
        @"browser": @[
            @"browser_listConnected",
            @"browser_setDefaultBrowser",
            @"browser_getTabs",
            @"browser_getActiveTab",
            @"browser_focusTab",
            @"browser_createTab",
            @"browser_closeTab",
            @"browser_getPageInfo",
            @"browser_inspectCurrentPage",
            @"browser_getInteractiveElements",
            @"browser_getPageContext",
            @"browser_clickElement",
            @"browser_fillElement",
            @"browser_fillFormField",
            @"browser_fillWithFallback",
            @"browser_fillFormNative",
            @"browser_scrollTo",
            @"browser_executeScript",
            @"browser_getFormData",
            @"browser_setWatchMode",
            @"browser_getVisibleText",
            @"browser_searchVisibleText",
            @"browser_getUIElements",
            @"browser_waitForSelector",
            @"browser_waitForPageLoad",
            @"browser_selectOption",
            @"browser_isElementVisible",
            @"browser_getConsoleLogs",
            @"browser_getNetworkRequests",
            @"browser_getLocalStorage",
            @"browser_getCookies",
            // Enhanced browser tools
            @"browser_clickByText",
            @"browser_clickMultiple",
            @"browser_getFormStructure",
            @"browser_answerQuestions",
            @"browser_getDropdownOptions",
            @"browser_openDropdownNative",
            @"browser_listInteractiveElements",
            @"browser_clickElementWithDebug",
            @"browser_findElementWithDebug",
            @"browser_findTabByUrl",
            // Playwright-style browser automation tools
            @"browser_navigate",
            @"browser_screenshot",
            @"browser_go_back",
            @"browser_go_forward",
            @"browser_get_visible_html",
            @"browser_hover",
            @"browser_drag",
            @"browser_press_key",
            @"browser_upload_file",
            @"browser_save_as_pdf"
        ],
        @"filesystem": @[
            @"fs_list",
            @"fs_read",
            @"fs_read_range",
            @"fs_write",
            @"fs_delete",
            @"fs_move",
            @"fs_search",
            @"fs_grep",
            @"fs_patch"
        ],
        @"shell": @[
            @"shell_exec",
            @"shell_start_session",
            @"shell_send_input",
            @"shell_stop_session"
        ]
    };
    
    BOOL madeChanges = NO;
    
    // Ensure each category exists and has all expected tools
    for (NSString *categoryId in defaultToolDefinitions) {
        NSDictionary *existingCategoryConfig = self.toolsConfig[categoryId];
        NSMutableDictionary *categoryConfig;
        
        if (existingCategoryConfig) {
            // Make a mutable copy of the existing config
            categoryConfig = [existingCategoryConfig mutableCopy];
        } else {
            // Create a new category config
            categoryConfig = [NSMutableDictionary dictionary];
            categoryConfig[@"enabled"] = @YES;
            madeChanges = YES;
        }
        
        // Ensure tools dictionary is mutable
        NSDictionary *existingTools = categoryConfig[@"tools"];
        NSMutableDictionary *tools;
        if (existingTools) {
            tools = [existingTools mutableCopy];
        } else {
            tools = [NSMutableDictionary dictionary];
        }
        
        // Add any missing tools from the default list
        NSArray *expectedTools = defaultToolDefinitions[categoryId];
        for (NSString *toolName in expectedTools) {
            if (!tools[toolName]) {
                tools[toolName] = @YES; // Default to enabled
                madeChanges = YES;
            }
        }
        
        categoryConfig[@"tools"] = tools;
        self.toolsConfig[categoryId] = categoryConfig;
    }
    
    // Return YES if we made any changes (added missing categories or tools)
    return madeChanges;
}

- (void)saveToolsConfig {
    NSString *configPath = [self getToolsConfigPath];
    NSError *error = nil;

    NSData *data = [NSJSONSerialization dataWithJSONObject:self.toolsConfig
                                                   options:NSJSONWritingPrettyPrinted
                                                     error:&error];

    if (data && !error) {
        [data writeToFile:configPath atomically:YES];
        NSLog(@"Saved tools config to %@", configPath);
    } else {
        NSLog(@"Error saving tools config: %@", error);
    }
}

- (void)createDefaultToolsConfig {
    self.toolsConfig = [NSMutableDictionary dictionary];

    // Define all tools with their categories
    NSDictionary *toolDefinitions = @{
        @"gui": @[
            @"listApplications",
            @"focusApplication",
            @"launchApplication",
            @"screenshot",
            @"screenshot_app",
            @"click",
            @"click_absolute",
            @"doubleClick",
            @"clickElement",
            @"moveMouse",
            @"scroll",
            @"scrollMouse",
            @"drag",
            @"getClickableElements",
            @"getUIElements",
            @"getMousePosition",
            @"typeText",
            @"pressKey",
            @"analyzeWithOCR",
            @"checkPermissions",
            @"closeApp",
            @"wait",
            @"system_info",
            @"window_list",
            @"clipboard_read",
            @"clipboard_write"
        ],
        @"browser": @[
            @"browser_listConnected",
            @"browser_setDefaultBrowser",
            @"browser_getTabs",
            @"browser_getActiveTab",
            @"browser_focusTab",
            @"browser_createTab",
            @"browser_closeTab",
            @"browser_getPageInfo",
            @"browser_inspectCurrentPage",
            @"browser_getInteractiveElements",
            @"browser_getPageContext",
            @"browser_clickElement",
            @"browser_fillElement",
            @"browser_fillFormField",
            @"browser_fillWithFallback",
            @"browser_fillFormNative",
            @"browser_scrollTo",
            @"browser_executeScript",
            @"browser_getFormData",
            @"browser_setWatchMode",
            @"browser_getVisibleText",
            @"browser_searchVisibleText",
            @"browser_getUIElements",
            @"browser_waitForSelector",
            @"browser_waitForPageLoad",
            @"browser_selectOption",
            @"browser_isElementVisible",
            @"browser_getConsoleLogs",
            @"browser_getNetworkRequests",
            @"browser_getLocalStorage",
            @"browser_getCookies",
            // Enhanced browser tools
            @"browser_clickByText",
            @"browser_clickMultiple",
            @"browser_getFormStructure",
            @"browser_answerQuestions",
            @"browser_getDropdownOptions",
            @"browser_openDropdownNative",
            @"browser_listInteractiveElements",
            @"browser_clickElementWithDebug",
            @"browser_findElementWithDebug",
            @"browser_findTabByUrl",
            // Playwright-style browser automation tools
            @"browser_navigate",
            @"browser_screenshot",
            @"browser_go_back",
            @"browser_go_forward",
            @"browser_get_visible_html",
            @"browser_hover",
            @"browser_drag",
            @"browser_press_key",
            @"browser_upload_file",
            @"browser_save_as_pdf"
        ],
        @"filesystem": @[
            @"fs_list",
            @"fs_read",
            @"fs_read_range",
            @"fs_write",
            @"fs_delete",
            @"fs_move",
            @"fs_search",
            @"fs_grep",
            @"fs_patch"
        ],
        @"shell": @[
            @"shell_exec",
            @"shell_start_session",
            @"shell_send_input",
            @"shell_stop_session"
        ]
    };

    // Initialize categories with all tools enabled
    for (NSString *category in toolDefinitions) {
        NSMutableDictionary *categoryConfig = [NSMutableDictionary dictionary];
        categoryConfig[@"enabled"] = @YES;

        NSMutableDictionary *tools = [NSMutableDictionary dictionary];
        NSArray *toolNames = toolDefinitions[category];
        for (NSString *toolName in toolNames) {
            tools[toolName] = @YES;
        }
        categoryConfig[@"tools"] = tools;

        self.toolsConfig[category] = categoryConfig;
    }

    [self saveToolsConfig];
}

- (NSArray *)getToolsForCategory:(NSString *)categoryId {
    NSDictionary *categoryConfig = self.toolsConfig[categoryId];
    if (!categoryConfig) return @[];

    NSDictionary *tools = categoryConfig[@"tools"];
    if (!tools) return @[];

    return [tools.allKeys sortedArrayUsingSelector:@selector(compare:)];
}

- (CGFloat)addCategoryBox:(NSString *)categoryName
               categoryId:(NSString *)categoryId
                    tools:(NSArray *)tools
                   toView:(NSView *)documentView
                     atY:(CGFloat)y {

    CGFloat boxWidth = documentView.frame.size.width - 20;
    CGFloat boxHeight = 50 + (tools.count * 25);

    NSBox *categoryBox = [[NSBox alloc] initWithFrame:NSMakeRect(10, y, boxWidth, boxHeight)];
    categoryBox.title = categoryName;
    categoryBox.titlePosition = NSAtTop;
    [documentView addSubview:categoryBox];

    CGFloat boxPadding = 15;
    CGFloat boxY = boxHeight - 40;

    // Category master toggle
    NSButton *categoryToggle = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding, boxY, boxWidth - boxPadding * 2, 20)];
    [categoryToggle setButtonType:NSButtonTypeSwitch];
    categoryToggle.title = @"Enable All";
    categoryToggle.tag = [categoryId hash]; // Use hash as tag

    // Set initial state
    NSDictionary *categoryConfig = self.toolsConfig[categoryId];
    BOOL categoryEnabled = [categoryConfig[@"enabled"] boolValue];
    categoryToggle.state = categoryEnabled ? NSControlStateValueOn : NSControlStateValueOff;

    categoryToggle.target = self;
    categoryToggle.action = @selector(categoryToggleChanged:);
    [categoryBox addSubview:categoryToggle];

    // Store toggle reference
    if (!self.categoryToggles) {
        self.categoryToggles = [NSMutableDictionary dictionary];
    }
    self.categoryToggles[categoryId] = categoryToggle;

    boxY -= 30;

    // Individual tool toggles
    if (!self.toolToggles) {
        self.toolToggles = [NSMutableDictionary dictionary];
    }

    NSDictionary *toolsConfig = categoryConfig[@"tools"];

    for (NSString *toolName in tools) {
        NSButton *toolToggle = [[NSButton alloc] initWithFrame:NSMakeRect(boxPadding + 20, boxY, boxWidth - boxPadding * 2 - 20, 20)];
        [toolToggle setButtonType:NSButtonTypeSwitch];
        toolToggle.title = toolName;

        // Set initial state
        BOOL toolEnabled = [toolsConfig[toolName] boolValue];
        toolToggle.state = toolEnabled ? NSControlStateValueOn : NSControlStateValueOff;
        toolToggle.enabled = categoryEnabled;

        toolToggle.target = self;
        toolToggle.action = @selector(toolToggleChanged:);
        [categoryBox addSubview:toolToggle];

        // Store toggle reference with composite key
        NSString *toolKey = [NSString stringWithFormat:@"%@.%@", categoryId, toolName];
        self.toolToggles[toolKey] = toolToggle;

        boxY -= 25;
    }

    return y + boxHeight;
}

- (void)categoryToggleChanged:(NSButton *)sender {
    // Find which category this belongs to
    NSString *categoryId = nil;
    for (NSString *catId in self.categoryToggles) {
        if (self.categoryToggles[catId] == sender) {
            categoryId = catId;
            break;
        }
    }

    if (!categoryId) return;

    BOOL enabled = (sender.state == NSControlStateValueOn);

    // Update config
    NSMutableDictionary *categoryConfig = [self.toolsConfig[categoryId] mutableCopy];
    categoryConfig[@"enabled"] = @(enabled);
    self.toolsConfig[categoryId] = categoryConfig;

    // Enable/disable all tool toggles in this category
    NSArray *tools = [self getToolsForCategory:categoryId];
    for (NSString *toolName in tools) {
        NSString *toolKey = [NSString stringWithFormat:@"%@.%@", categoryId, toolName];
        NSButton *toolToggle = self.toolToggles[toolKey];
        toolToggle.enabled = enabled;
    }

    NSLog(@"Category %@ %@", categoryId, enabled ? @"enabled" : @"disabled");
}

- (void)toolToggleChanged:(NSButton *)sender {
    // Find which tool this belongs to
    NSString *categoryId = nil;
    NSString *toolName = sender.title;

    for (NSString *toolKey in self.toolToggles) {
        if (self.toolToggles[toolKey] == sender) {
            NSArray *parts = [toolKey componentsSeparatedByString:@"."];
            if (parts.count == 2) {
                categoryId = parts[0];
                break;
            }
        }
    }

    if (!categoryId || !toolName) return;

    BOOL enabled = (sender.state == NSControlStateValueOn);

    // Update config
    NSMutableDictionary *categoryConfig = [self.toolsConfig[categoryId] mutableCopy];
    NSMutableDictionary *toolsConfig = [categoryConfig[@"tools"] mutableCopy];
    toolsConfig[toolName] = @(enabled);
    categoryConfig[@"tools"] = toolsConfig;
    self.toolsConfig[categoryId] = categoryConfig;

    NSLog(@"Tool %@.%@ %@", categoryId, toolName, enabled ? @"enabled" : @"disabled");
}

- (void)saveSettings:(id)sender {
    // Track which settings need restart vs immediate apply
    NSString *oldPort = [self loadSetting:kPortKey defaultValue:@"3456"];
    NSString *oldNetworkMode = [self loadSetting:kNetworkModeKey defaultValue:@"localhost"];

    [self saveSetting:kAgentNameKey value:self.agentNameField.stringValue];

    NSInteger modeIndex = self.networkModePopup.indexOfSelectedItem;
    NSString *mode = @"localhost";
    if (modeIndex == 1) mode = @"lan";
    else if (modeIndex == 2) mode = @"wan";
    [self saveSetting:kNetworkModeKey value:mode];

    [self saveSetting:kPortKey value:self.portField.stringValue];

    // Save control server settings
    [self saveSetting:kControlServerAddressKey value:self.controlServerAddressField.stringValue];

    // Save tools configuration
    [self saveToolsConfig];

    // Apply control server settings immediately (no restart needed)
    [self checkControlServerConnection];

    // Check if MCP server settings changed (these need restart)
    BOOL needsRestart = ![oldPort isEqualToString:self.portField.stringValue] ||
                        ![oldNetworkMode isEqualToString:mode];

    if (needsRestart) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Settings Saved";
        alert.informativeText = @"Port or network mode changed. Restart the agent for these changes to take effect.";
        alert.alertStyle = NSAlertStyleInformational;
        [alert addButtonWithTitle:@"OK"];
        [alert addButtonWithTitle:@"Restart Now"];

        NSModalResponse response = [alert runModal];
        if (response == NSAlertSecondButtonReturn) {
            [self restartAgent];
        }
    } else {
        // Just show confirmation - control server settings applied immediately
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Settings Saved";
        alert.informativeText = @"Your settings have been applied.";
        alert.alertStyle = NSAlertStyleInformational;
        [alert addButtonWithTitle:@"OK"];
        [alert runModal];
    }

    [self.settingsWindow close];
}

- (void)networkModeChanged:(id)sender {
    NSInteger modeIndex = self.networkModePopup.indexOfSelectedItem;
    if (modeIndex == 2) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Internet Mode Warning";
        alert.informativeText = @"Exposing this agent to the internet requires:\n\n"
                                @"1. A strong API key (auto-generated)\n"
                                @"2. Firewall/router configuration\n"
                                @"3. Optionally, TLS encryption\n\n"
                                @"Only enable this if you understand the security implications.";
        alert.alertStyle = NSAlertStyleWarning;
        [alert addButtonWithTitle:@"I Understand"];
        [alert addButtonWithTitle:@"Cancel"];

        NSModalResponse response = [alert runModal];
        if (response == NSAlertSecondButtonReturn) {
            [self.networkModePopup selectItemAtIndex:0];
        }
    }
}

- (void)regenerateAPIKey:(id)sender {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Regenerate API Key?";
    alert.informativeText = @"This will invalidate any existing connections using the current key.";
    alert.alertStyle = NSAlertStyleWarning;
    [alert addButtonWithTitle:@"Regenerate"];
    [alert addButtonWithTitle:@"Cancel"];

    NSModalResponse response = [alert runModal];
    if (response == NSAlertFirstButtonReturn) {
        NSString *newKey = [self generateAPIKey];
        [self saveSetting:kAPIKeyKey value:newKey];
        self.apiKeyField.stringValue = newKey;
    }
}

#pragma mark - Control Server Management

- (void)connectControlServer:(id)sender {
    NSString *address = self.controlServerAddressField.stringValue;
    if (address.length == 0) {
        if (sender != nil) {
            // Only show alert if user clicked the button
            NSAlert *alert = [[NSAlert alloc] init];
            alert.messageText = @"Missing URL";
            alert.informativeText = @"Please enter a control server URL.";
            alert.alertStyle = NSAlertStyleWarning;
            [alert addButtonWithTitle:@"OK"];
            [alert runModal];
        }
        return;
    }

    // Parse address (may include port)
    NSString *urlString = address;
    if (![urlString hasPrefix:@"http://"] && ![urlString hasPrefix:@"https://"]) {
        urlString = [NSString stringWithFormat:@"https://%@", address];
    }

    // Parse MCP URL to extract endpoint UUID if present
    // Format: https://server.com/mcp/UUID or https://server.com
    NSURL *parsedUrl = [NSURL URLWithString:urlString];
    NSString *baseUrl = urlString;
    NSString *endpointUuid = @"";

    if (parsedUrl) {
        NSString *path = parsedUrl.path;
        // Check if path contains /mcp/UUID
        if ([path hasPrefix:@"/mcp/"]) {
            // Extract UUID from path
            NSString *uuidPart = [path substringFromIndex:5]; // Skip "/mcp/"
            // Remove any trailing slashes or path components
            NSRange slashRange = [uuidPart rangeOfString:@"/"];
            if (slashRange.location != NSNotFound) {
                uuidPart = [uuidPart substringToIndex:slashRange.location];
            }
            endpointUuid = uuidPart;

            // Build base URL without the /mcp/UUID path
            NSString *scheme = parsedUrl.scheme ?: @"https";
            NSString *host = parsedUrl.host ?: @"";
            NSNumber *port = parsedUrl.port;
            if (port) {
                baseUrl = [NSString stringWithFormat:@"%@://%@:%@", scheme, host, port];
            } else {
                baseUrl = [NSString stringWithFormat:@"%@://%@", scheme, host];
            }

            NSLog(@"Parsed MCP URL - Base: %@, Endpoint UUID: %@", baseUrl, endpointUuid);
        }
    }

    // Store endpoint UUID in debug field (used by registration)
    self.debugEndpointUuidField.stringValue = endpointUuid;

    // Save the URL to UserDefaults
    [self saveSetting:kControlServerAddressKey value:self.controlServerAddressField.stringValue];

    // Start health check in background (use base URL)
    [self checkServerHealth:baseUrl];

    // Build WebSocket URL from base URL
    NSString *wsUrl = baseUrl;
    wsUrl = [wsUrl stringByReplacingOccurrencesOfString:@"https://" withString:@"wss://"];
    wsUrl = [wsUrl stringByReplacingOccurrencesOfString:@"http://" withString:@"ws://"];
    wsUrl = [NSString stringWithFormat:@"%@/ws", wsUrl];

    // Update debug server URL field and initiate WebSocket connection
    self.debugServerUrlField.stringValue = wsUrl;

    // Update UI
    self.connectButton.enabled = NO;
    self.connectionStatusLabel.stringValue = @"Status: Connecting...";
    self.connectionStatusLabel.textColor = [NSColor systemOrangeColor];

    // Check if service is available
    if (!self.serviceClient.isServiceAvailable) {
        self.connectionStatusLabel.stringValue = @"Status: Service not running";
        self.connectionStatusLabel.textColor = [NSColor systemRedColor];
        self.connectButton.enabled = YES;
        [self debugLog:@"ERROR: Service not available. Please start the ScreenControl service first."];
        return;
    }

    // Update debug tab UI as well
    self.debugConnectButton.enabled = NO;
    self.debugDisconnectButton.enabled = YES;
    self.debugReconnectButton.enabled = NO;
    self.debugConnectionStatusLabel.stringValue = @"Status: Connecting...";
    self.debugConnectionStatusLabel.textColor = [NSColor systemOrangeColor];

    // Build connection config for service
    NSString *agentName = self.agentNameField.stringValue ?: [[NSHost currentHost] localizedName];
    NSString *customerId = self.debugCustomerIdField.stringValue ?: @"";

    NSDictionary *config = @{
        @"serverUrl": wsUrl,
        @"endpointUuid": endpointUuid ?: @"",
        @"customerId": customerId,
        @"agentName": agentName ?: @""
    };

    [self debugLog:[NSString stringWithFormat:@"Connecting to %@ via service...", wsUrl]];

    // Connect via service - the service handles the WebSocket connection
    __weak typeof(self) weakSelf = self;
    [self.serviceClient connectToControlServerWithConfig:config completion:^(BOOL success, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (success) {
                [weakSelf debugLog:@"Connection request sent to service"];
                // Status will be updated via ServiceClient delegate callbacks
            } else {
                [weakSelf debugLog:[NSString stringWithFormat:@"ERROR: Failed to connect - %@", error.localizedDescription]];
                weakSelf.connectButton.enabled = YES;
                weakSelf.debugConnectButton.enabled = YES;
                weakSelf.debugDisconnectButton.enabled = NO;
                weakSelf.connectionStatusLabel.stringValue = @"Status: Connection failed";
                weakSelf.connectionStatusLabel.textColor = [NSColor systemRedColor];
                weakSelf.debugConnectionStatusLabel.stringValue = @"Status: Connection failed";
                weakSelf.debugConnectionStatusLabel.textColor = [NSColor systemRedColor];
            }
        });
    }];
}

- (void)checkServerHealth:(NSString *)urlString {
    NSURL *testURL = [NSURL URLWithString:[NSString stringWithFormat:@"%@/api/health", urlString]];
    if (!testURL) {
        self.healthStatusLabel.stringValue = @"Health: Invalid URL";
        self.healthStatusLabel.textColor = [NSColor systemRedColor];
        return;
    }

    self.healthStatusLabel.stringValue = @"Health: Checking...";
    self.healthStatusLabel.textColor = [NSColor systemOrangeColor];

    NSURLRequest *request = [NSURLRequest requestWithURL:testURL
                                             cachePolicy:NSURLRequestUseProtocolCachePolicy
                                         timeoutInterval:10.0];

    NSURLSessionDataTask *task = [self.urlSession dataTaskWithRequest:request
                                                    completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error) {
                self.healthStatusLabel.stringValue = @"Health: Error";
                self.healthStatusLabel.textColor = [NSColor systemRedColor];
                return;
            }

            NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
            if (httpResponse.statusCode == 200 && data) {
                NSError *jsonError;
                NSDictionary *result = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
                if (result && [result[@"status"] isEqualToString:@"ok"]) {
                    self.healthStatusLabel.stringValue = @"Health: Ok";
                    self.healthStatusLabel.textColor = [NSColor systemGreenColor];
                } else {
                    self.healthStatusLabel.stringValue = @"Health: Bad";
                    self.healthStatusLabel.textColor = [NSColor systemRedColor];
                }
            } else {
                self.healthStatusLabel.stringValue = [NSString stringWithFormat:@"Health: %ld", (long)httpResponse.statusCode];
                self.healthStatusLabel.textColor = [NSColor systemRedColor];
            }
        });
    }];

    [task resume];
}

- (void)checkControlServerConnection {
    NSString *address = [self loadSetting:kControlServerAddressKey defaultValue:@""];
    if (address.length == 0) {
        self.isRemoteMode = NO;
        self.connectionStatusLabel.stringValue = @"Not connected";
        self.connectionStatusLabel.textColor = [NSColor secondaryLabelColor];
        [self updateStatusBarIcon:[self isScreenLocked]];
        return;
    }

    // Check if service is available and already connected
    if (self.serviceClient.isServiceAvailable && self.serviceClient.isControlServerConnected) {
        // Already connected via service
        return;
    }

    // If address is configured and not connected, try to connect
    [self connectControlServer:nil];
}

#pragma mark - Agent Management

- (void)startAgent {
    NSLog(@"ScreenControl Agent starting... [BUILD-TEST-v123]");

    NSString *apiKey = [self loadOrGenerateAPIKey];
    NSString *portStr = [self loadSetting:kPortKey defaultValue:@"3456"];
    NSUInteger port = [portStr integerValue];

    fprintf(stderr, "[DEBUG-STDERR] About to create MCPServer\n"); fflush(stderr);
    self.mcpServer = [[MCPServer alloc] initWithPort:port apiKey:apiKey];
    fprintf(stderr, "[DEBUG-STDERR] MCPServer created at %p\n", (__bridge void *)self.mcpServer); fflush(stderr);
    NSLog(@"[startAgent] MCPServer created at %p", (__bridge void *)self.mcpServer);
    self.mcpServer.delegate = self;
    fprintf(stderr, "[DEBUG-STDERR] Delegate set\n"); fflush(stderr);
    NSLog(@"[startAgent] Delegate set, about to call start");

    fprintf(stderr, "[DEBUG-STDERR] About to call start\n"); fflush(stderr);
    if ([self.mcpServer start]) {
        NSLog(@"MCP Server started on port %lu", (unsigned long)port);
        [self saveTokenFile:apiKey port:port];
    } else {
        NSLog(@"Failed to start MCP Server");
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [self updateStatus];
    });

    NSLog(@"[startAgent] EXITING startAgent method");
}

- (void)stopAgent {
    NSLog(@"ScreenControl Agent stopped");
    [self.mcpServer stop];
    self.mcpServer = nil;
}

- (void)restartAgent {
    [self stopAgent];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        [self startAgent];
    });
}

#pragma mark - Browser Bridge Server

- (void)startBrowserBridge {
    [self fileLog:@"[startBrowserBridge] ENTRY - starting browser bridge setup"];

    // Check if WebSocket server is already running
    if (self.browserWebSocketServer && self.browserWebSocketServer.isRunning) {
        NSLog(@"[WebSocket Bridge] WebSocket server already running");
        [self fileLog:@"[startBrowserBridge] WebSocket server already running, returning early"];
        return;
    }

    // Stop legacy bridge server if running (can't both use port 3457)
    if (self.browserBridgeServer && self.browserBridgeServer.isRunning) {
        NSLog(@"[Browser Bridge] Stopping legacy bridge server...");
        [self fileLog:@"[startBrowserBridge] Stopping legacy bridge server"];
        [self.browserBridgeServer stop];
        self.browserBridgeServer = nil;
    }

    // Start native WebSocket server (replaces legacy bridge and Node.js dependency)
    NSLog(@"[WebSocket Bridge] Starting native WebSocket server...");
    [self fileLog:@"[startBrowserBridge] Creating BrowserWebSocketServer on port 3457"];

    @try {
        self.browserWebSocketServer = [[BrowserWebSocketServer alloc] initWithPort:3457];
        [self fileLog:@"[startBrowserBridge] BrowserWebSocketServer allocated, setting delegate"];
        self.browserWebSocketServer.delegate = self;

        // Load default browser preference from service config
        [self loadBrowserPreferenceFromServiceConfig];

        [self fileLog:@"[startBrowserBridge] Calling start on WebSocket server"];
        BOOL wsSuccess = [self.browserWebSocketServer start];
        if (wsSuccess) {
            NSLog(@"[WebSocket Bridge] Native WebSocket server started on port 3457");
            [self fileLog:@"[startBrowserBridge] SUCCESS - WebSocket server started on port 3457"];
        } else {
            NSLog(@"[WebSocket Bridge] Failed to start WebSocket server");
            [self fileLog:@"[startBrowserBridge] FAILED - WebSocket server start returned NO"];
            self.browserWebSocketServer = nil;
        }
    } @catch (NSException *exception) {
        [self fileLog:[NSString stringWithFormat:@"[startBrowserBridge] EXCEPTION: %@ - %@", exception.name, exception.reason]];
        NSLog(@"[WebSocket Bridge] Exception starting server: %@", exception);
        self.browserWebSocketServer = nil;
    }

    [self fileLog:@"[startBrowserBridge] EXIT"];
}

- (void)stopBrowserBridge {
    // Stop legacy Node.js bridge server
    if (self.browserBridgeServer) {
        NSLog(@"[Browser Bridge] Stopping browser bridge server...");
        [self.browserBridgeServer stop];
        self.browserBridgeServer = nil;
    }

    // Stop native WebSocket server
    if (self.browserWebSocketServer) {
        NSLog(@"[WebSocket Bridge] Stopping WebSocket server...");
        [self.browserWebSocketServer stop];
        self.browserWebSocketServer = nil;
    }
}

- (void)loadBrowserPreferenceFromServiceConfig {
    // Read the service config from /Library/Application Support/ScreenControl/config.json
    NSString *configPath = @"/Library/Application Support/ScreenControl/config.json";

    if (![[NSFileManager defaultManager] fileExistsAtPath:configPath]) {
        NSLog(@"[Browser Config] Service config not found at %@, using system default", configPath);
        self.browserWebSocketServer.defaultBrowser = @"system";
        return;
    }

    NSError *error = nil;
    NSData *configData = [NSData dataWithContentsOfFile:configPath options:0 error:&error];
    if (!configData) {
        NSLog(@"[Browser Config] Failed to read service config: %@", error.localizedDescription);
        self.browserWebSocketServer.defaultBrowser = @"system";
        return;
    }

    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:configData options:0 error:&error];
    if (!config) {
        NSLog(@"[Browser Config] Failed to parse service config: %@", error.localizedDescription);
        self.browserWebSocketServer.defaultBrowser = @"system";
        return;
    }

    NSString *defaultBrowser = config[@"defaultBrowser"];
    if (defaultBrowser && [defaultBrowser length] > 0) {
        self.browserWebSocketServer.defaultBrowser = defaultBrowser;
        NSLog(@"[Browser Config] Loaded default browser preference: %@", defaultBrowser);
    } else {
        self.browserWebSocketServer.defaultBrowser = @"system";
        NSLog(@"[Browser Config] No browser preference in config, using system default");
    }
}

- (void)reloadBrowserPreference {
    // Called when config changes - reload browser preference
    if (self.browserWebSocketServer) {
        [self loadBrowserPreferenceFromServiceConfig];
    }
}

#pragma mark - GUI Bridge Server (Service Communication)

- (void)startGUIBridgeServer {
    if (self.guiBridgeServer && self.guiBridgeServer.isRunning) {
        NSLog(@"[GUI Bridge] Server already running");
        return;
    }

    self.guiBridgeServer = [GUIBridgeServer sharedInstance];
    self.guiBridgeServer.delegate = self;

    if ([self.guiBridgeServer start]) {
        NSLog(@"[GUI Bridge] Server started on port %d", self.guiBridgeServer.port);
    } else {
        NSLog(@"[GUI Bridge] Failed to start server");
    }
}

- (void)stopGUIBridgeServer {
    if (self.guiBridgeServer) {
        [self.guiBridgeServer stop];
        self.guiBridgeServer = nil;
        NSLog(@"[GUI Bridge] Server stopped");
    }
}

#pragma mark - GUIBridgeServerDelegate

- (NSDictionary *)guiBridgeServer:(id)server executeToolWithName:(NSString *)name arguments:(NSDictionary *)arguments {
    // Route GUI tool requests to our existing tool execution logic
    // This is called when the service forwards a GUI operation to us
    NSLog(@"[GUI Bridge] Executing tool: %@ with args: %@", name, arguments);

    // Create MCP-style params for executeToolFromWebSocket
    NSDictionary *mcpParams = @{
        @"name": name,
        @"arguments": arguments ?: @{}
    };

    return [self executeToolFromWebSocket:mcpParams];
}

- (void)guiBridgeServerDidStart:(id)server {
    NSLog(@"[GUI Bridge] Delegate: Server started");
}

- (void)guiBridgeServerDidStop:(id)server {
    NSLog(@"[GUI Bridge] Delegate: Server stopped");
}

- (void)guiBridgeServer:(id)server logMessage:(NSString *)message {
    NSLog(@"[GUI Bridge] %@", message);
}

#pragma mark - Service Client (Service Monitoring)

- (void)startServiceClient {
    self.serviceClient = [ServiceClient sharedInstance];
    self.serviceClient.delegate = self;
    [self.serviceClient startMonitoring];
    NSLog(@"[Service Client] Started monitoring service");
}

- (void)stopServiceClient {
    if (self.serviceClient) {
        [self.serviceClient stopMonitoring];
        self.serviceClient = nil;
        NSLog(@"[Service Client] Stopped monitoring");
    }
}

#pragma mark - ServiceClientDelegate

- (void)serviceClient:(id)client didChangeConnectionState:(ServiceConnectionState)state {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *stateString;
        NSColor *indicatorColor;

        switch (state) {
            case ServiceConnectionStateConnected:
                stateString = @"Running";
                indicatorColor = [NSColor systemGreenColor];
                break;
            case ServiceConnectionStateConnecting:
                stateString = @"Connecting...";
                indicatorColor = [NSColor systemYellowColor];
                break;
            case ServiceConnectionStateError:
                stateString = @"Error";
                indicatorColor = [NSColor systemRedColor];
                break;
            default:
                stateString = @"Not Running";
                indicatorColor = [NSColor systemGrayColor];
                break;
        }
        NSLog(@"[Service Client] State changed: %@", stateString);

        // Update UI if we have a service status label
        if (self.serviceStatusLabel) {
            self.serviceStatusLabel.stringValue = [NSString stringWithFormat:@"Service: %@", stateString];
        }

        // Update indicator color
        if (self.serviceStatusIndicator) {
            self.serviceStatusIndicator.contentTintColor = indicatorColor;
        }

        // Update status icon based on service connection
        [self updateStatusBarIcon:(state != ServiceConnectionStateConnected)];
    });
}

- (void)serviceClient:(id)client controlServerDidConnect:(BOOL)connected agentId:(NSString *)agentId licenseStatus:(NSString *)status {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"[Service Client] Control server %@, Agent: %@, License: %@",
              connected ? @"connected" : @"disconnected", agentId ?: @"none", status ?: @"unknown");

        // Update debug tab UI fields
        if (self.debugConnectionStatusLabel) {
            if (connected) {
                self.debugConnectionStatusLabel.stringValue = @"Status: Connected (via Service)";
                self.debugConnectionStatusLabel.textColor = [NSColor systemGreenColor];
            } else {
                self.debugConnectionStatusLabel.stringValue = @"Status: Disconnected";
                self.debugConnectionStatusLabel.textColor = [NSColor secondaryLabelColor];
            }
        }

        if (self.debugAgentIdLabel) {
            self.debugAgentIdLabel.stringValue = agentId ? [NSString stringWithFormat:@"Agent ID: %@", agentId] : @"Agent ID: --";
        }

        if (self.debugLicenseStatusLabel) {
            self.debugLicenseStatusLabel.stringValue = status ? [NSString stringWithFormat:@"License: %@", status] : @"License: --";
        }

        // Update debug tab button states
        self.debugConnectButton.enabled = !connected;
        self.debugDisconnectButton.enabled = connected;
        self.debugReconnectButton.enabled = connected;

        // Update General tab connection status
        if (self.connectionStatusLabel) {
            if (connected) {
                self.connectionStatusLabel.stringValue = @"Status: Connected";
                self.connectionStatusLabel.textColor = [NSColor systemGreenColor];
            } else {
                self.connectionStatusLabel.stringValue = @"Status: Disconnected";
                self.connectionStatusLabel.textColor = [NSColor secondaryLabelColor];
            }
        }

        if (self.connectButton) {
            self.connectButton.enabled = !connected;
        }

        // Update connection state
        self.debugIsConnected = connected;
        self.isRemoteMode = connected;

        // Update status bar icon based on connection
        [self updateStatusBarIcon:!connected];
    });
}

- (void)serviceClient:(id)client logMessage:(NSString *)message {
    [self debugLog:message];
}

- (void)serviceClient:(id)client permissionsDidChange:(BOOL)masterModeEnabled fileTransferEnabled:(BOOL)fileTransferEnabled localSettingsLocked:(BOOL)localSettingsLocked {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"[Service Client] Permissions changed: masterMode=%@, fileTransfer=%@, localSettingsLocked=%@",
              masterModeEnabled ? @"YES" : @"NO",
              fileTransferEnabled ? @"YES" : @"NO",
              localSettingsLocked ? @"YES" : @"NO");

        [self debugLog:[NSString stringWithFormat:@"Permissions updated: masterMode=%@, fileTransfer=%@, locked=%@",
                        masterModeEnabled ? @"ON" : @"OFF",
                        fileTransferEnabled ? @"ON" : @"OFF",
                        localSettingsLocked ? @"YES" : @"NO"]];

        // Handle local settings lock
        [self updateSettingsLockedState:localSettingsLocked];
    });
}

- (void)updateSettingsLockedState:(BOOL)locked {
    // When local settings are locked, disable certain UI elements
    if (locked) {
        // Disable General tab settings
        if (self.controlServerAddressField) {
            self.controlServerAddressField.enabled = NO;
        }

        // Disable Tools tab checkboxes
        for (NSString *categoryId in self.categoryToggles) {
            NSButton *toggle = self.categoryToggles[categoryId];
            toggle.enabled = NO;
        }
        for (NSString *categoryId in self.toolToggles) {
            NSDictionary *tools = self.toolToggles[categoryId];
            for (NSString *toolName in tools) {
                NSButton *toggle = tools[toolName];
                toggle.enabled = NO;
            }
        }

        // Update status bar tooltip
        self.statusItem.button.toolTip = @"ScreenControl Agent (Settings Locked)";

        NSLog(@"[AppDelegate] Settings locked by administrator");
    } else {
        // Enable General tab settings
        if (self.controlServerAddressField) {
            self.controlServerAddressField.enabled = YES;
        }

        // Enable Tools tab checkboxes
        for (NSString *categoryId in self.categoryToggles) {
            NSButton *toggle = self.categoryToggles[categoryId];
            toggle.enabled = YES;
        }
        for (NSString *categoryId in self.toolToggles) {
            NSDictionary *tools = self.toolToggles[categoryId];
            for (NSString *toolName in tools) {
                NSButton *toggle = tools[toolName];
                toggle.enabled = YES;
            }
        }

        // Update status bar tooltip
        self.statusItem.button.toolTip = @"ScreenControl Agent";
    }
}

#pragma mark - BrowserBridgeServerDelegate

- (void)browserBridgeServerDidStart:(NSUInteger)port {
    NSLog(@"[Browser Bridge] Delegate: Server started on port %lu", (unsigned long)port);
    // Notify control server that tools have changed (browser tools now available)
    [self debugNotifyToolsChanged];
}

- (void)browserBridgeServerDidStop {
    NSLog(@"[Browser Bridge] Delegate: Server stopped");
    // Notify control server that tools have changed (browser tools no longer available)
    [self debugNotifyToolsChanged];
}

- (void)browserDidConnect:(BrowserType)browserType name:(NSString *)name {
    NSLog(@"[Browser Bridge] Delegate: Browser connected - %@ (%@)", name, @(browserType));
    // Notify control server that tools have changed (browser extension connected)
    [self debugNotifyToolsChanged];
}

- (void)browserDidDisconnect:(BrowserType)browserType {
    NSLog(@"[Browser Bridge] Delegate: Browser disconnected - type %@", @(browserType));
    // Notify control server that tools have changed (browser extension disconnected)
    [self debugNotifyToolsChanged];
}

- (void)saveTokenFile:(NSString *)apiKey port:(NSUInteger)port {
    // Save token file for MCP proxy to read
    NSString *tokenPath = [NSHomeDirectory() stringByAppendingPathComponent:@".screencontrol-token"];
    NSDictionary *tokenData = @{
        @"apiKey": apiKey,
        @"port": @(port),
        @"host": @"127.0.0.1",
        @"createdAt": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]]
    };

    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:tokenData options:0 error:nil];
    [jsonData writeToFile:tokenPath atomically:YES];

    // Set file permissions to owner only (0600)
    [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0600} ofItemAtPath:tokenPath error:nil];
}

- (void)updateStatus {
    // Batch UI updates to prevent animation conflicts
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self updateStatus];
        });
        return;
    }

    // Cache the last state to avoid unnecessary updates
    static BOOL lastScreenLocked = NO;
    static BOOL lastRunning = NO;
    static NSString *lastPort = nil;
    static BOOL lastRemoteMode = NO;

    NSMenuItem *statusItem = [self.statusMenu itemWithTag:100];
    BOOL screenLocked = [self isScreenLocked];
    BOOL running = self.mcpServer.isRunning;
    NSString *port = [self loadSetting:kPortKey defaultValue:@"3456"];

    // Batch all UI updates in a single animation block
    [NSAnimationContext beginGrouping];
    [[NSAnimationContext currentContext] setDuration:0];

    // Only update icon if state changed
    if (screenLocked != lastScreenLocked || running != lastRunning || self.isRemoteMode != lastRemoteMode) {
        [self updateStatusBarIcon:screenLocked];
        lastScreenLocked = screenLocked;
        lastRunning = running;
        lastRemoteMode = self.isRemoteMode;
    }

    // Update menu item
    NSString *newTitle = nil;
    if (screenLocked) {
        newTitle = @"Screen Locked - waiting...";
    } else if (running) {
        NSString *mode = self.isRemoteMode ? @" (Remote)" : @"";
        newTitle = [NSString stringWithFormat:@"Running on port %@%@", port, mode];
    } else {
        newTitle = @"Stopped";
    }

    if (![statusItem.title isEqualToString:newTitle]) {
        statusItem.title = newTitle;
    }

    [NSAnimationContext endGrouping];

    lastPort = port;

    // Only update settings window if visible
    if (self.settingsWindow.isVisible && !self.isUpdatingSettingsStatus) {
        [self updateSettingsWindowStatus];
    }

    // Check permissions less frequently (every 3 updates = 15 seconds)
    static NSUInteger permissionCheckCounter = 0;
    if (++permissionCheckCounter % 3 == 0) {
        [self checkPermissions];
    }

    // Periodically check control server connection
    static NSUInteger checkCounter = 0;
    if (++checkCounter % 12 == 0) { // Every 60 seconds (12 * 5s)
        [self checkControlServerConnection];
    }
}

- (BOOL)isScreenLocked {
    CFDictionaryRef sessionDict = CGSessionCopyCurrentDictionary();
    if (sessionDict) {
        CFBooleanRef screenLocked = CFDictionaryGetValue(sessionDict, CFSTR("CGSSessionScreenIsLocked"));
        BOOL locked = (screenLocked && CFBooleanGetValue(screenLocked));
        CFRelease(sessionDict);
        if (locked) return YES;
    }

    NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if ([frontApp.bundleIdentifier isEqualToString:@"com.apple.loginwindow"] ||
        [frontApp.bundleIdentifier isEqualToString:@"com.apple.ScreenSaver.Engine"]) {
        return YES;
    }

    return NO;
}

- (void)updateSettingsWindowStatus {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self updateSettingsWindowStatus];
        });
        return;
    }

    if (self.isUpdatingSettingsStatus) {
        return;
    }

    self.isUpdatingSettingsStatus = YES;
    [self applySettingsWindowStatus];
}

- (void)applySettingsWindowStatus {
    // Batch UI updates
    [NSAnimationContext beginGrouping];
    [[NSAnimationContext currentContext] setDuration:0];

    NSString *port = [self loadSetting:kPortKey defaultValue:@"3456"];
    self.statusLabel.stringValue = [NSString stringWithFormat:@"Server: Running on port %@", port];

    NSTimeInterval uptime = [[NSDate date] timeIntervalSinceDate:self.startTime];
    if (uptime < 60) {
        self.uptimeLabel.stringValue = [NSString stringWithFormat:@"Uptime: %.0fs", uptime];
    } else if (uptime < 3600) {
        self.uptimeLabel.stringValue = [NSString stringWithFormat:@"Uptime: %.0fm %.0fs",
                                        floor(uptime / 60), fmod(uptime, 60)];
    } else {
        self.uptimeLabel.stringValue = [NSString stringWithFormat:@"Uptime: %.0fh %.0fm",
                                        floor(uptime / 3600), fmod(floor(uptime / 60), 60)];
    }

    [NSAnimationContext endGrouping];

    [self updatePermissionIndicators];
    self.isUpdatingSettingsStatus = NO;
}

#pragma mark - BrowserWebSocketServerDelegate

- (void)browserWebSocketServerDidStart:(BrowserWebSocketServer *)server onPort:(NSUInteger)port {
    NSLog(@"[WebSocket Bridge] Delegate: WebSocket server started on port %lu", (unsigned long)port);
    // Notify control server that tools have changed (browser tools now available)
    [self debugNotifyToolsChanged];
}

- (void)browserWebSocketServerDidStop:(BrowserWebSocketServer *)server {
    NSLog(@"[WebSocket Bridge] Delegate: WebSocket server stopped");
    // Notify control server that tools have changed (browser tools no longer available)
    [self debugNotifyToolsChanged];
}

- (void)browserWebSocketServer:(BrowserWebSocketServer *)server
         didReceiveToolRequest:(NSDictionary *)request
                   fromBrowser:(NSString *)browserId {
    NSLog(@"[WebSocket Bridge] Delegate: Received message from browser %@: %@", browserId, request);

    // Check if this is an identify message
    NSString *action = request[@"action"];
    if (action && [action isEqualToString:@"identify"]) {
        NSLog(@"[WebSocket Bridge] Browser %@ identified: %@ %@",
              browserId, request[@"browserName"], request[@"userAgent"]);

        // Send acknowledgment back to browser
        NSDictionary *ackResponse = @{
            @"type": @"identify_ack",
            @"id": request[@"id"] ?: @"unknown",
            @"success": @YES
        };
        [server sendResponse:ackResponse toBrowser:browserId];
        return;
    }

    // Extract tool information from WebSocket request
    NSString *requestId = request[@"id"];
    NSString *toolName = request[@"tool"];
    NSDictionary *params = request[@"params"] ?: @{};

    // Validate required fields for tool requests
    if (!requestId || !toolName) {
        NSLog(@"[WebSocket Bridge] ERROR: Missing required fields (requestId: %@, toolName: %@)", requestId, toolName);
        NSDictionary *errorResponse = @{
            @"type": @"tool_response",
            @"id": requestId ?: @"unknown",
            @"success": @NO,
            @"error": @"Missing required fields: id or tool"
        };
        [self.browserWebSocketServer sendResponse:errorResponse toBrowser:browserId];
        return;
    }

    NSLog(@"[WebSocket Bridge] Delegate: Executing tool %@ from browser %@", toolName, browserId);

    // Create MCP-style params for executeToolFromWebSocket:
    NSDictionary *mcpParams = @{
        @"name": toolName,
        @"arguments": params
    };

    // Execute the tool
    NSDictionary *result = [self executeToolFromWebSocket:mcpParams];

    // Prepare WebSocket response
    NSDictionary *response = @{
        @"type": @"tool_response",
        @"id": requestId,
        @"success": result[@"error"] ? @NO : @YES,
        @"result": result
    };

    // Send response back to browser
    [server sendResponse:response toBrowser:browserId];
}

#pragma mark - Permissions

- (void)checkPermissions {
    BOOL hasAccessibility = AXIsProcessTrusted();

    // Find the Permissions submenu
    NSMenuItem *permissionsMenuItem = nil;
    for (NSMenuItem *item in self.statusMenu.itemArray) {
        if ([item.title isEqualToString:@"Permissions"]) {
            permissionsMenuItem = item;
            break;
        }
    }

    if (permissionsMenuItem && permissionsMenuItem.submenu) {
        NSMenuItem *accessItem = [permissionsMenuItem.submenu itemWithTag:200];
        if (accessItem) {
            accessItem.title = hasAccessibility ? @"Accessibility: Granted ✓" : @"Accessibility: Not Granted ✗";
        }

        BOOL hasScreenRecording = NO;
        if (@available(macOS 10.15, *)) {
            hasScreenRecording = CGPreflightScreenCaptureAccess();
        } else {
            hasScreenRecording = YES;
        }

        NSMenuItem *screenItem = [permissionsMenuItem.submenu itemWithTag:201];
        if (screenItem) {
            screenItem.title = hasScreenRecording ? @"Screen Recording: Granted ✓" : @"Screen Recording: Not Granted ✗";
        }
    }
}

- (void)updatePermissionIndicators {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self updatePermissionIndicators];
        });
        return;
    }

    if (self.isUpdatingPermissionIndicators) {
        return;
    }

    self.isUpdatingPermissionIndicators = YES;
    [self applyPermissionIndicatorState];
}

- (void)applyPermissionIndicatorState {
    BOOL hasAccessibility = AXIsProcessTrusted();
    BOOL hasScreenRecording = NO;
    if (@available(macOS 10.15, *)) {
        hasScreenRecording = CGPreflightScreenCaptureAccess();
    } else {
        hasScreenRecording = YES;
    }

    // Batch UI updates
    [NSAnimationContext beginGrouping];
    [[NSAnimationContext currentContext] setDuration:0];

    self.accessibilityLabel.stringValue = @"Accessibility";
    if (hasAccessibility) {
        self.accessibilityIndicator.image = [NSImage imageWithSystemSymbolName:@"checkmark.circle.fill" accessibilityDescription:@"Granted"];
        self.accessibilityIndicator.contentTintColor = [NSColor systemGreenColor];
    } else {
        self.accessibilityIndicator.image = [NSImage imageWithSystemSymbolName:@"xmark.circle.fill" accessibilityDescription:@"Not Granted"];
        self.accessibilityIndicator.contentTintColor = [NSColor systemRedColor];
    }

    self.screenRecordingLabel.stringValue = @"Screen Recording";
    if (hasScreenRecording) {
        self.screenRecordingIndicator.image = [NSImage imageWithSystemSymbolName:@"checkmark.circle.fill" accessibilityDescription:@"Granted"];
        self.screenRecordingIndicator.contentTintColor = [NSColor systemGreenColor];
    } else {
        self.screenRecordingIndicator.image = [NSImage imageWithSystemSymbolName:@"xmark.circle.fill" accessibilityDescription:@"Not Granted"];
        self.screenRecordingIndicator.contentTintColor = [NSColor systemRedColor];
    }

    [NSAnimationContext endGrouping];

    self.isUpdatingPermissionIndicators = NO;
}

#pragma mark - Actions

- (void)openSettings:(id)sender {
    [self updateSettingsWindowStatus];
    [self.settingsWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)copyAPIKey:(id)sender {
    NSString *apiKey = self.apiKeyField ? self.apiKeyField.stringValue : nil;
    if (!apiKey || apiKey.length == 0) {
        apiKey = [self loadOrGenerateAPIKey];
    }

    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    [pasteboard clearContents];
    [pasteboard setString:apiKey forType:NSPasteboardTypeString];

    self.statusItem.button.toolTip = @"API Key Copied!";
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        self.statusItem.button.toolTip = @"ScreenControl Agent";
    });
}

- (void)openAccessibilityPrefs:(id)sender {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

- (void)openScreenRecordingPrefs:(id)sender {
    if (@available(macOS 10.15, *)) {
        CGRequestScreenCaptureAccess();
    }

    NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"];
    [[NSWorkspace sharedWorkspace] openURL:url];
}

- (void)toggleLoginItem:(id)sender {
    NSMenuItem *item = (NSMenuItem *)sender;
    BOOL currentState = (item.state == NSControlStateValueOn);

    if (@available(macOS 13.0, *)) {
        SMAppService *service = [SMAppService mainAppService];
        NSError *error = nil;

        if (currentState) {
            [service unregisterAndReturnError:&error];
        } else {
            [service registerAndReturnError:&error];
        }

        if (error) {
            NSLog(@"Failed to toggle login item: %@", error);
        }
    }

    item.state = currentState ? NSControlStateValueOff : NSControlStateValueOn;
}

- (void)quit:(id)sender {
    [NSApp terminate:nil];
}

#pragma mark - NSWindowDelegate

- (void)windowWillClose:(NSNotification *)notification {
}

#pragma mark - NSTextFieldDelegate

- (void)controlTextDidEndEditing:(NSNotification *)notification {
}

#pragma mark - MCPServerDelegate

- (void)serverDidStart:(NSUInteger)port {
    NSLog(@"MCP Server started on port %lu", (unsigned long)port);
    [self updateStatus];
}

- (void)serverDidStop {
    NSLog(@"MCP Server stopped");
    [self updateStatus];
}

- (void)serverDidReceiveRequest:(NSString *)path {
    NSLog(@"MCP Request: %@", path);
}

#pragma mark - Browser Bridge Server Management

- (NSString *)browserBridgeServerPath {
    // First check if running from Xcode (development)
    NSString *devPath = [NSHomeDirectory() stringByAppendingPathComponent:@"dev/screencontrol/dist/browser-bridge-server.js"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:devPath]) {
        return devPath;
    }

    // Check bundle resources
    NSString *bundlePath = [[NSBundle mainBundle] pathForResource:@"browser-bridge-server" ofType:@"js"];
    if (bundlePath) {
        return bundlePath;
    }

    // Fallback to npm global install
    NSString *npmPath = @"/usr/local/lib/node_modules/screencontrol/dist/browser-bridge-server.js";
    if ([[NSFileManager defaultManager] fileExistsAtPath:npmPath]) {
        return npmPath;
    }

    return nil;
}

- (NSString *)nodeExecutablePath {
    // Check common Node.js installation paths
    NSArray *nodePaths = @[
        @"/usr/local/bin/node",
        @"/opt/homebrew/bin/node",
        @"/usr/bin/node",
        [NSHomeDirectory() stringByAppendingPathComponent:@".nvm/versions/node/*/bin/node"]
    ];

    for (NSString *path in nodePaths) {
        if ([path containsString:@"*"]) {
            // Handle glob pattern for nvm
            NSString *baseDir = [path stringByDeletingLastPathComponent];
            baseDir = [baseDir stringByDeletingLastPathComponent];
            NSArray *contents = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:baseDir error:nil];
            for (NSString *version in contents) {
                NSString *nodePath = [[baseDir stringByAppendingPathComponent:version] stringByAppendingPathComponent:@"bin/node"];
                if ([[NSFileManager defaultManager] isExecutableFileAtPath:nodePath]) {
                    return nodePath;
                }
            }
        } else if ([[NSFileManager defaultManager] isExecutableFileAtPath:path]) {
            return path;
        }
    }

    return nil;
}

- (BOOL)isBrowserBridgeRunning {
    return self.browserBridgeServer && self.browserBridgeServer.isRunning;
}

#pragma mark - Debug Configuration

- (void)loadBundledDebugConfig {
    // Load debug-config.json from app bundle Resources
    NSString *configPath = [[NSBundle mainBundle] pathForResource:@"debug-config" ofType:@"json"];
    if (!configPath) {
        NSLog(@"No bundled debug-config.json found - using defaults");
        return;
    }

    NSError *error = nil;
    NSData *configData = [NSData dataWithContentsOfFile:configPath options:0 error:&error];
    if (!configData) {
        NSLog(@"Failed to read debug-config.json: %@", error.localizedDescription);
        return;
    }

    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:configData options:0 error:&error];
    if (!config) {
        NSLog(@"Failed to parse debug-config.json: %@", error.localizedDescription);
        return;
    }

    NSLog(@"Loaded bundled debug config: %@", config);

    // Auto-fill debug fields if autoFillDebugSettings is true
    if ([config[@"autoFillDebugSettings"] boolValue]) {
        if (config[@"serverUrl"] && [config[@"serverUrl"] length] > 0) {
            self.debugServerUrlField.stringValue = config[@"serverUrl"];
        }
        if (config[@"endpointUuid"] && [config[@"endpointUuid"] length] > 0) {
            self.debugEndpointUuidField.stringValue = config[@"endpointUuid"];
        }
        if (config[@"customerId"] && [config[@"customerId"] length] > 0) {
            self.debugCustomerIdField.stringValue = config[@"customerId"];
        }

        // Log who this debug build belongs to
        NSString *developerEmail = config[@"developerEmail"];
        NSString *environment = config[@"environment"];
        if (developerEmail) {
            NSLog(@"Debug build configured for developer: %@", developerEmail);
        }
        if (environment) {
            NSLog(@"Environment: %@", environment);
        }
    }

    // NOTE: Auto-reconnect is now handled by the service

    // Auto-connect on startup if configured
    if ([config[@"connectOnStartup"] boolValue]) {
        NSLog(@"Auto-connecting to debug server on startup...");
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [self debugConnect:nil];
        });
    }
}

#pragma mark - WebSocket Tool Execution

- (NSDictionary *)executeToolFromWebSocket:(NSDictionary *)params {
    // Extract tool name and arguments from MCP-style request
    NSString *toolName = params[@"name"];
    NSDictionary *arguments = params[@"arguments"] ?: @{};

    if (!toolName) {
        return @{@"error": @"Missing tool name"};
    }

    [self debugLog:[NSString stringWithFormat:@"→ Executing tool: %@ with args: %@", toolName, arguments]];

    // Route to appropriate MCPServer method
    @try {
        // ============= TOOL ADVERTISEMENT =============

        // Handle tools/list request (for dynamic tool discovery)
        if ([toolName isEqualToString:@"tools/list"]) {
            NSArray *availableTools = [self getAvailableTools];
            NSLog(@"[Agent] Advertising %lu tools to control server", (unsigned long)availableTools.count);
            return @{@"tools": availableTools};
        }

        // ============= NATIVE MACOS TOOLS =============

        // Permissions
        if ([toolName isEqualToString:@"checkPermissions"]) {
            return [self.mcpServer checkPermissions];
        }

        // Application management
        else if ([toolName isEqualToString:@"listApplications"]) {
            return @{@"applications": [self.mcpServer listApplications]};
        }
        else if ([toolName isEqualToString:@"focusApplication"]) {
            NSString *identifier = arguments[@"identifier"];
            if (!identifier) {
                return @{@"error": @"identifier is required"};
            }
            BOOL success = [self.mcpServer focusApplication:identifier];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"launchApplication"]) {
            NSString *identifier = arguments[@"identifier"];
            if (!identifier) {
                return @{@"error": @"identifier is required (bundle ID or app name)"};
            }
            return [self.mcpServer launchApplication:identifier];
        }
        else if ([toolName isEqualToString:@"closeApp"]) {
            NSString *identifier = arguments[@"identifier"];
            NSNumber *force = arguments[@"force"] ?: @NO;
            if (!identifier) {
                return @{@"error": @"identifier is required"};
            }
            return [self.mcpServer closeApplication:identifier force:force.boolValue];
        }
        else if ([toolName isEqualToString:@"currentApp"]) {
            return self.currentAppBundleId ?
                @{@"bundleId": self.currentAppBundleId, @"bounds": self.currentAppBounds ?: @{}} :
                @{@"bundleId": [NSNull null], @"bounds": @{}};
        }

        // Screenshots (desktop_screenshot is the MCP advertised name, screenshot is the internal name)
        else if ([toolName isEqualToString:@"screenshot"] || [toolName isEqualToString:@"desktop_screenshot"]) {
            NSData *imageData = [self.mcpServer takeScreenshot];
            if (!imageData) {
                return @{@"error": @"Failed to take screenshot"};
            }
            NSString *base64 = [imageData base64EncodedStringWithOptions:0];
            return @{@"image": base64, @"format": @"png"};
        }
        // screenshot_app is the internal name for window-specific screenshots
        else if ([toolName isEqualToString:@"screenshot_app"]) {
            NSString *appIdentifier = arguments[@"identifier"];
            CGWindowID windowID = kCGNullWindowID;

            if (appIdentifier) {
                windowID = [self.mcpServer getWindowIDForApp:appIdentifier];
            } else if (self.currentAppBundleId) {
                windowID = [self.mcpServer getWindowIDForCurrentApp];
            }

            NSData *imageData = nil;
            if (windowID != kCGNullWindowID) {
                imageData = [self.mcpServer takeScreenshotOfWindow:windowID];
            }

            if (!imageData) {
                return @{@"error": @"Failed to take screenshot. No app focused or app not found."};
            }
            NSString *base64 = [imageData base64EncodedStringWithOptions:0];
            return @{@"image": base64, @"format": @"png"};
        }

        // Mouse and click actions
        else if ([toolName isEqualToString:@"click"]) {
            NSNumber *x = arguments[@"x"];
            NSNumber *y = arguments[@"y"];
            if (!x || !y) {
                return @{@"error": @"x and y are required"};
            }
            NSString *button = arguments[@"button"] ?: @"left";
            BOOL success = [self.mcpServer clickAtX:x.floatValue y:y.floatValue rightButton:[button isEqualToString:@"right"]];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"click_absolute"]) {
            NSNumber *x = arguments[@"x"];
            NSNumber *y = arguments[@"y"];
            if (!x || !y) {
                return @{@"error": @"x and y are required (absolute screen coordinates in pixels)"};
            }
            NSString *button = arguments[@"button"] ?: @"left";
            BOOL success = [self.mcpServer clickAbsoluteX:x.floatValue y:y.floatValue rightButton:[button isEqualToString:@"right"]];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"doubleClick"]) {
            NSNumber *x = arguments[@"x"];
            NSNumber *y = arguments[@"y"];
            if (!x || !y) {
                return @{@"error": @"x and y are required"};
            }
            BOOL success = [self.mcpServer doubleClickAtX:x.floatValue y:y.floatValue];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"clickElement"]) {
            NSNumber *elementIndex = arguments[@"elementIndex"];
            if (!elementIndex) {
                return @{@"error": @"elementIndex is required"};
            }
            return [self.mcpServer clickElementAtIndex:elementIndex.integerValue];
        }
        else if ([toolName isEqualToString:@"moveMouse"]) {
            NSNumber *x = arguments[@"x"];
            NSNumber *y = arguments[@"y"];
            if (!x || !y) {
                return @{@"error": @"x and y are required"};
            }
            BOOL success = [self.mcpServer moveMouseToX:x.floatValue y:y.floatValue];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"getMousePosition"]) {
            CGPoint mouseLocation = [NSEvent mouseLocation];
            NSScreen *mainScreen = [NSScreen mainScreen];
            CGFloat screenHeight = mainScreen.frame.size.height;
            return @{@"x": @(mouseLocation.x), @"y": @(screenHeight - mouseLocation.y)};
        }

        // Scroll and drag
        else if ([toolName isEqualToString:@"scroll"]) {
            NSNumber *deltaX = arguments[@"deltaX"] ?: @0;
            NSNumber *deltaY = arguments[@"deltaY"] ?: @0;
            NSNumber *x = arguments[@"x"];
            NSNumber *y = arguments[@"y"];
            BOOL success = [self.mcpServer scrollDeltaX:deltaX.intValue deltaY:deltaY.intValue atX:x y:y];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"scrollMouse"]) {
            NSString *direction = arguments[@"direction"];
            NSNumber *amount = arguments[@"amount"] ?: @3;
            if (!direction) {
                return @{@"error": @"direction is required (up or down)"};
            }
            int deltaY = [direction isEqualToString:@"up"] ? amount.intValue : -amount.intValue;
            BOOL success = [self.mcpServer scrollDeltaX:0 deltaY:deltaY atX:nil y:nil];
            return @{@"success": @(success), @"direction": direction, @"amount": amount};
        }
        else if ([toolName isEqualToString:@"drag"]) {
            NSNumber *startX = arguments[@"startX"];
            NSNumber *startY = arguments[@"startY"];
            NSNumber *endX = arguments[@"endX"];
            NSNumber *endY = arguments[@"endY"];
            if (!startX || !startY || !endX || !endY) {
                return @{@"error": @"startX, startY, endX, and endY are required"};
            }
            BOOL success = [self.mcpServer dragFromX:startX.floatValue y:startY.floatValue toX:endX.floatValue y:endY.floatValue];
            return @{@"success": @(success)};
        }

        // UI elements
        else if ([toolName isEqualToString:@"getClickableElements"]) {
            return [self.mcpServer getClickableElements];
        }
        else if ([toolName isEqualToString:@"getUIElements"]) {
            return [self.mcpServer getUIElements];
        }

        // Keyboard input
        else if ([toolName isEqualToString:@"typeText"]) {
            NSString *text = arguments[@"text"];
            if (!text) {
                return @{@"error": @"text is required"};
            }
            BOOL success = [self.mcpServer typeText:text];
            return @{@"success": @(success)};
        }
        else if ([toolName isEqualToString:@"pressKey"]) {
            NSString *key = arguments[@"key"];
            if (!key) {
                return @{@"error": @"key is required"};
            }
            BOOL success = [self.mcpServer pressKey:key];
            return @{@"success": @(success)};
        }

        // OCR and analysis
        else if ([toolName isEqualToString:@"analyzeWithOCR"]) {
            return [self.mcpServer analyzeWithOCR];
        }

        // Utility
        else if ([toolName isEqualToString:@"wait"]) {
            NSNumber *milliseconds = arguments[@"milliseconds"] ?: @1000;
            [NSThread sleepForTimeInterval:milliseconds.doubleValue / 1000.0];
            return @{@"success": @YES, @"waited_ms": milliseconds};
        }

        // ============= SYSTEM INFO =============
        else if ([toolName isEqualToString:@"system_info"]) {
            NSProcessInfo *processInfo = [NSProcessInfo processInfo];
            NSOperatingSystemVersion osVersion = processInfo.operatingSystemVersion;

            unsigned long long physicalMemory = processInfo.physicalMemory;
            double memoryGB = physicalMemory / (1024.0 * 1024.0 * 1024.0);

            NSUInteger cpuCount = processInfo.processorCount;
            NSUInteger activeCPUs = processInfo.activeProcessorCount;

            return @{
                @"hostname": processInfo.hostName,
                @"os": @"macOS",
                @"osVersion": [NSString stringWithFormat:@"%ld.%ld.%ld",
                              (long)osVersion.majorVersion,
                              (long)osVersion.minorVersion,
                              (long)osVersion.patchVersion],
                @"osBuild": [[NSProcessInfo processInfo] operatingSystemVersionString],
                @"cpuCores": @(cpuCount),
                @"activeCpuCores": @(activeCPUs),
                @"memoryGB": @(memoryGB),
                @"memoryBytes": @(physicalMemory),
                @"systemUptime": @(processInfo.systemUptime),
                @"userName": NSUserName(),
                @"homeDirectory": NSHomeDirectory()
            };
        }

        // ============= WINDOW LIST =============
        else if ([toolName isEqualToString:@"window_list"]) {
            NSMutableArray *windows = [NSMutableArray array];

            CFArrayRef windowList = CGWindowListCopyWindowInfo(
                kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                kCGNullWindowID
            );

            if (windowList) {
                NSArray *windowArray = (__bridge_transfer NSArray *)windowList;
                for (NSDictionary *window in windowArray) {
                    NSString *ownerName = window[(NSString *)kCGWindowOwnerName];
                    NSString *windowName = window[(NSString *)kCGWindowName];
                    NSNumber *windowID = window[(NSString *)kCGWindowNumber];
                    NSNumber *layer = window[(NSString *)kCGWindowLayer];
                    NSDictionary *bounds = window[(NSString *)kCGWindowBounds];

                    if (!ownerName || [layer intValue] < 0) continue;

                    NSMutableDictionary *windowInfo = [NSMutableDictionary dictionary];
                    windowInfo[@"id"] = windowID;
                    windowInfo[@"app"] = ownerName;
                    if (windowName && windowName.length > 0) {
                        windowInfo[@"title"] = windowName;
                    }
                    if (bounds) {
                        windowInfo[@"bounds"] = bounds;
                    }
                    windowInfo[@"layer"] = layer;

                    [windows addObject:windowInfo];
                }
            }

            return @{@"windows": windows, @"count": @(windows.count)};
        }

        // ============= CLIPBOARD =============
        else if ([toolName isEqualToString:@"clipboard_read"]) {
            NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
            NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
            if (text) {
                return @{@"text": text, @"success": @YES};
            } else {
                NSArray *types = [pasteboard types];
                return @{@"text": [NSNull null], @"availableTypes": types, @"message": @"No text content in clipboard"};
            }
        }
        else if ([toolName isEqualToString:@"clipboard_write"]) {
            NSString *text = arguments[@"text"];
            if (!text) {
                return @{@"error": @"text is required"};
            }

            NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
            [pasteboard clearContents];
            BOOL success = [pasteboard setString:text forType:NSPasteboardTypeString];
            return @{@"success": @(success)};
        }

        // ============= FILESYSTEM TOOLS =============

        else if ([toolName isEqualToString:@"fs_list"]) {
            NSString *fsPath = arguments[@"path"];
            if (!fsPath) {
                return @{@"error": @"path is required"};
            }
            BOOL recursive = [arguments[@"recursive"] boolValue];
            NSInteger maxDepth = [arguments[@"max_depth"] integerValue] ?: 3;
            return [self.mcpServer.filesystemTools listDirectory:fsPath recursive:recursive maxDepth:maxDepth];
        }
        else if ([toolName isEqualToString:@"fs_read"]) {
            NSString *fsPath = arguments[@"path"];
            if (!fsPath) {
                return @{@"error": @"path is required"};
            }
            NSInteger maxBytes = [arguments[@"max_bytes"] integerValue] ?: 131072;
            return [self.mcpServer.filesystemTools readFile:fsPath maxBytes:maxBytes];
        }
        else if ([toolName isEqualToString:@"fs_read_range"]) {
            NSString *fsPath = arguments[@"path"];
            NSNumber *startLine = arguments[@"start_line"];
            NSNumber *endLine = arguments[@"end_line"];
            if (!fsPath || !startLine || !endLine) {
                return @{@"error": @"path, start_line, and end_line are required"};
            }
            return [self.mcpServer.filesystemTools readFileRange:fsPath
                                                       startLine:[startLine integerValue]
                                                         endLine:[endLine integerValue]];
        }
        else if ([toolName isEqualToString:@"fs_write"]) {
            NSString *fsPath = arguments[@"path"];
            NSString *content = arguments[@"content"];
            if (!fsPath || !content) {
                return @{@"error": @"path and content are required"};
            }
            BOOL createDirs = arguments[@"create_dirs"] ? [arguments[@"create_dirs"] boolValue] : YES;
            NSString *mode = arguments[@"mode"] ?: @"overwrite";
            return [self.mcpServer.filesystemTools writeFile:fsPath content:content createDirs:createDirs mode:mode];
        }
        else if ([toolName isEqualToString:@"fs_delete"]) {
            NSString *fsPath = arguments[@"path"];
            if (!fsPath) {
                return @{@"error": @"path is required"};
            }
            BOOL recursive = [arguments[@"recursive"] boolValue];
            return [self.mcpServer.filesystemTools deletePath:fsPath recursive:recursive];
        }
        else if ([toolName isEqualToString:@"fs_move"]) {
            NSString *fromPath = arguments[@"from"];
            NSString *toPath = arguments[@"to"];
            if (!fromPath || !toPath) {
                return @{@"error": @"from and to are required"};
            }
            return [self.mcpServer.filesystemTools movePath:fromPath toPath:toPath];
        }
        else if ([toolName isEqualToString:@"fs_search"]) {
            NSString *basePath = arguments[@"base"];
            if (!basePath) {
                return @{@"error": @"base is required"};
            }
            NSString *glob = arguments[@"glob"] ?: @"**/*";
            NSInteger maxResults = [arguments[@"max_results"] integerValue] ?: 200;
            return [self.mcpServer.filesystemTools searchFiles:basePath glob:glob maxResults:maxResults];
        }
        else if ([toolName isEqualToString:@"fs_grep"]) {
            NSString *basePath = arguments[@"base"];
            NSString *pattern = arguments[@"pattern"];
            if (!basePath || !pattern) {
                return @{@"error": @"base and pattern are required"};
            }
            NSString *glob = arguments[@"glob"];
            NSInteger maxMatches = [arguments[@"max_matches"] integerValue] ?: 200;
            return [self.mcpServer.filesystemTools grepFiles:basePath pattern:pattern glob:glob maxMatches:maxMatches];
        }
        else if ([toolName isEqualToString:@"fs_patch"]) {
            NSString *fsPath = arguments[@"path"];
            NSArray *operations = arguments[@"operations"];
            if (!fsPath || !operations) {
                return @{@"error": @"path and operations are required"};
            }
            BOOL dryRun = [arguments[@"dry_run"] boolValue];
            return [self.mcpServer.filesystemTools patchFile:fsPath operations:operations dryRun:dryRun];
        }

        // ============= SHELL TOOLS =============

        else if ([toolName isEqualToString:@"shell_exec"]) {
            NSString *command = arguments[@"command"];
            if (!command) {
                return @{@"error": @"command is required"};
            }
            NSString *cwd = arguments[@"cwd"];
            NSTimeInterval timeout = [arguments[@"timeout_seconds"] doubleValue] ?: 600;
            BOOL captureStderr = arguments[@"capture_stderr"] ? [arguments[@"capture_stderr"] boolValue] : YES;
            return [self.mcpServer.shellTools executeCommand:command cwd:cwd timeoutSeconds:timeout captureStderr:captureStderr];
        }
        else if ([toolName isEqualToString:@"shell_start_session"]) {
            NSString *command = arguments[@"command"];
            if (!command) {
                return @{@"error": @"command is required"};
            }
            NSString *cwd = arguments[@"cwd"];
            NSDictionary *env = arguments[@"env"];
            BOOL captureStderr = arguments[@"capture_stderr"] ? [arguments[@"capture_stderr"] boolValue] : YES;
            return [self.mcpServer.shellTools startSession:command cwd:cwd env:env captureStderr:captureStderr];
        }
        else if ([toolName isEqualToString:@"shell_send_input"]) {
            NSString *sessionId = arguments[@"session_id"];
            NSString *input = arguments[@"input"];
            if (!sessionId || !input) {
                return @{@"error": @"session_id and input are required"};
            }
            return [self.mcpServer.shellTools sendInput:sessionId input:input];
        }
        else if ([toolName isEqualToString:@"shell_stop_session"]) {
            NSString *sessionId = arguments[@"session_id"];
            if (!sessionId) {
                return @{@"error": @"session_id is required"};
            }
            NSString *signal = arguments[@"signal"] ?: @"TERM";
            return [self.mcpServer.shellTools stopSession:sessionId signal:signal];
        }

        // ============= BROWSER TOOLS =============

        else if ([toolName hasPrefix:@"browser_"]) {
            // Note: Removed isRunning check - let HTTP request handle errors naturally
            // Browser bridge server should be available at localhost:3457

            // Extract browser preference from arguments (optional)
            NSString *browserName = arguments[@"browser"]; // "firefox", "chrome", "edge", "safari"

            // Remove "browser_" prefix to get the action name
            // e.g., "browser_navigate" -> "navigate"
            NSString *action = [toolName substringFromIndex:8];

            // Forward to browser bridge server with direct HTTP request
            __block NSDictionary *result = nil;
            __block BOOL completed = NO;

            // Build HTTP POST request to http://127.0.0.1:3457/command
            // Using explicit IPv4 address to avoid IPv6 resolution issues
            NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:3457/command"];
            NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
            request.HTTPMethod = @"POST";
            [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
            request.timeoutInterval = 30.0;

            // Build request body
            NSMutableDictionary *body = [NSMutableDictionary dictionaryWithDictionary:@{
                @"action": action,
                @"payload": arguments ?: @{}
            }];
            if (browserName) {
                body[@"browser"] = browserName;
            }

            NSError *serializeError = nil;
            request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:&serializeError];

            if (serializeError) {
                return @{@"error": [NSString stringWithFormat:@"Failed to serialize request: %@", serializeError.localizedDescription]};
            }

            // Send HTTP request
            [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                if (error) {
                    result = @{@"error": error.localizedDescription};
                    completed = YES;
                    return;
                }

                NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
                if (httpResponse.statusCode != 200) {
                    result = @{@"error": [NSString stringWithFormat:@"HTTP %ld", (long)httpResponse.statusCode]};
                    completed = YES;
                    return;
                }

                // Debug: log what we received
                NSLog(@"[Browser Tool] Received %lu bytes from BrowserWebSocketServer", (unsigned long)data.length);
                if (data.length > 0) {
                    NSString *preview = [[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(0, MIN(200, data.length))] encoding:NSUTF8StringEncoding];
                    NSLog(@"[Browser Tool] First 200 bytes: %@", preview ?: @"<not UTF-8>");
                }

                // Parse JSON response
                NSError *parseError = nil;
                NSDictionary *responseDict = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];

                if (parseError) {
                    // Debug: log raw response data
                    NSLog(@"[Browser Tool] Parse error: %@", parseError);
                    NSLog(@"[Browser Tool] Full data length: %lu bytes", (unsigned long)data.length);
                    // Log first 20 bytes as hex
                    NSMutableString *hexStr = [NSMutableString string];
                    const uint8_t *bytes = data.bytes;
                    for (NSUInteger i = 0; i < MIN(20, data.length); i++) {
                        [hexStr appendFormat:@"%02X ", bytes[i]];
                    }
                    NSLog(@"[Browser Tool] First 20 bytes (hex): %@", hexStr);
                    result = @{@"error": [NSString stringWithFormat:@"Failed to parse response: %@", parseError.localizedDescription]};
                } else if (responseDict[@"error"]) {
                    result = @{@"error": responseDict[@"error"]};
                } else {
                    result = responseDict ?: @{@"success": @YES};
                }
                completed = YES;
            }] resume];

            // Wait for response (with timeout)
            NSDate *timeout = [NSDate dateWithTimeIntervalSinceNow:30.0];
            while (!completed && [timeout timeIntervalSinceNow] > 0) {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
            }

            if (!completed) {
                return @{@"error": @"Browser command timed out after 30 seconds"};
            }

            return result;
        }

        else {
            return @{@"error": [NSString stringWithFormat:@"Unknown tool: %@", toolName]};
        }
    } @catch (NSException *exception) {
        return @{@"error": [NSString stringWithFormat:@"Tool execution failed: %@", exception.reason]};
    }
}

#pragma mark - TestServer Wrapper Methods

- (IBAction)debugConnectClicked:(id)sender {
    [self debugConnect:sender];
}

- (IBAction)debugDisconnectClicked:(id)sender {
    [self debugDisconnect:sender];
}

- (IBAction)debugSaveSettingsClicked:(id)sender {
    // Save debug-specific settings to UserDefaults
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:self.debugServerUrlField.stringValue forKey:@"debugServerUrl"];
    [defaults setObject:self.debugEndpointUuidField.stringValue forKey:@"debugEndpointUuid"];
    [defaults setObject:self.debugCustomerIdField.stringValue forKey:@"debugCustomerId"];
    if (self.debugConnectOnStartupCheckbox) {
        [defaults setBool:(self.debugConnectOnStartupCheckbox.state == NSControlStateValueOn) forKey:@"debugConnectOnStartup"];
    }
    // NOTE: Bypass mode checkbox removed - service now handles heartbeats
    [defaults synchronize];

    [self debugLog:@"Settings saved"];
}

- (IBAction)copyMcpUrl:(id)sender {
    // Get the endpoint UUID from the debug field
    NSString *endpointUuid = self.debugEndpointUuidField.stringValue;

    if (endpointUuid.length == 0) {
        [self debugLog:@"ERROR: No Endpoint UUID configured - cannot generate MCP URL"];
        return;
    }

    // Get the server URL and convert to HTTPS for MCP endpoint
    NSString *serverUrl = self.debugServerUrlField.stringValue;
    if (serverUrl.length == 0) {
        serverUrl = @"wss://screencontrol.knws.co.uk/ws";
    }

    // Convert WebSocket URL to HTTPS URL for MCP
    // wss://screencontrol.knws.co.uk/ws -> https://screencontrol.knws.co.uk
    // ws://localhost:3000/ws -> http://localhost:3000
    NSString *httpUrl = serverUrl;
    httpUrl = [httpUrl stringByReplacingOccurrencesOfString:@"wss://" withString:@"https://"];
    httpUrl = [httpUrl stringByReplacingOccurrencesOfString:@"ws://" withString:@"http://"];

    // Remove /ws suffix if present
    if ([httpUrl hasSuffix:@"/ws"]) {
        httpUrl = [httpUrl substringToIndex:httpUrl.length - 3];
    }

    // Construct the MCP URL
    NSString *mcpUrl = [NSString stringWithFormat:@"%@/mcp/%@", httpUrl, endpointUuid];

    // Copy to clipboard
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    [pasteboard clearContents];
    [pasteboard setString:mcpUrl forType:NSPasteboardTypeString];

    [self debugLog:[NSString stringWithFormat:@"MCP URL copied to clipboard: %@", mcpUrl]];
}

#pragma mark - Tool Advertisement (for Control Server)

- (NSArray *)getAvailableTools {
    NSMutableArray *tools = [NSMutableArray array];

    // Check if browser tools should be included (check both legacy and WebSocket servers)
    BOOL includeBrowserTools = (self.browserBridgeServer && self.browserBridgeServer.isRunning) ||
                               (self.browserWebSocketServer && self.browserWebSocketServer.isRunning);

    NSLog(@"[Agent] Building tool list - Browser bridge running: %@", includeBrowserTools ? @"YES" : @"NO");
    NSLog(@"[Agent]   browserBridgeServer: %@, isRunning: %@",
          self.browserBridgeServer ? @"EXISTS" : @"nil",
          self.browserBridgeServer ? (self.browserBridgeServer.isRunning ? @"YES" : @"NO") : @"N/A");
    NSLog(@"[Agent]   browserWebSocketServer: %@, isRunning: %@",
          self.browserWebSocketServer ? @"EXISTS" : @"nil",
          self.browserWebSocketServer ? (self.browserWebSocketServer.isRunning ? @"YES" : @"NO") : @"N/A");

    // Load tools config if not already loaded
    if (!self.toolsConfig) {
        [self loadToolsConfig];
    }

    if (!self.toolsConfig) {
        NSLog(@"[Agent] WARNING: toolsConfig not available, returning empty tool list");
        return [tools copy];
    }

    // toolsConfig structure: {categoryId: {enabled: YES, tools: {toolName: YES, ...}}, ...}
    // Note: categories are the direct keys of toolsConfig (not under a "categories" key)
    NSDictionary *categoriesDict = self.toolsConfig;

    // Iterate through categories
    for (NSString *categoryId in [categoriesDict allKeys]) {
        NSDictionary *category = categoriesDict[categoryId];
        NSArray *toolNames = category[@"tools"];

        // Skip browser category if bridge not running
        if ([categoryId isEqualToString:@"browser"] && !includeBrowserTools) {
            NSLog(@"[Agent] Skipping browser tools - bridge not available");
            continue;
        }

        // Add each tool in this category
        for (NSString *toolName in toolNames) {
            NSDictionary *toolDef = [self createToolDefinition:toolName category:categoryId];
            if (toolDef) {
                [tools addObject:toolDef];
            }
        }
    }

    // Add special test tool to verify cache freshness
    NSDate *now = [NSDate date];
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss";
    NSString *timestamp = [formatter stringFromDate:now];

    NSDictionary *testTool = @{
        @"name": @"test_cache_version",
        @"description": [NSString stringWithFormat:@"Test tool to verify MCP cache freshness. Returns: CACHE_TEST_VERSION_%@", timestamp],
        @"inputSchema": @{
            @"type": @"object",
            @"properties": @{
                @"agentId": @{
                    @"type": @"string",
                    @"description": @"Target agent ID (optional)"
                }
            }
        }
    };
    [tools addObject:testTool];

    NSLog(@"[Agent] Built %lu tool definitions (including test tool)", (unsigned long)tools.count);
    return [tools copy];
}

- (NSDictionary *)createToolDefinition:(NSString *)toolName category:(NSString *)categoryId {
    // Create MCP-format tool definition
    NSMutableDictionary *tool = [NSMutableDictionary dictionary];

    tool[@"name"] = toolName;
    tool[@"description"] = [self getToolDescription:toolName];

    // Build input schema
    NSMutableDictionary *inputSchema = [NSMutableDictionary dictionary];
    inputSchema[@"type"] = @"object";
    inputSchema[@"properties"] = [self getToolProperties:toolName];

    NSArray *required = [self getToolRequiredFields:toolName];
    if (required.count > 0) {
        inputSchema[@"required"] = required;
    }

    tool[@"inputSchema"] = inputSchema;

    return [tool copy];
}

- (NSString *)getToolDescription:(NSString *)toolName {
    // Map tool names to descriptions
    NSDictionary *descriptions = @{
        // Desktop tools
        @"desktop_screenshot": @"Take a screenshot of the entire desktop or a specific window",
        @"mouse_click": @"Click at specific screen coordinates",
        @"mouse_move": @"Move mouse to specific screen coordinates",
        @"mouse_drag": @"Drag mouse from one position to another",
        @"mouse_scroll": @"Scroll the mouse wheel",
        @"keyboard_type": @"Type text using the keyboard",
        @"keyboard_press": @"Press a specific key",
        @"keyboard_shortcut": @"Execute a keyboard shortcut (e.g., Cmd+C)",
        @"window_list": @"List all open windows",
        @"window_focus": @"Focus a specific window",
        @"window_move": @"Move a window to specific coordinates",
        @"window_resize": @"Resize a window",
        @"app_launch": @"Launch an application",
        @"app_quit": @"Quit an application",
        @"clipboard_read": @"Read text from clipboard",
        @"clipboard_write": @"Write text to clipboard",

        // Browser tools
        @"browser_navigate": @"Navigate browser to a URL",
        @"browser_click": @"Click an element in the browser by selector or text",
        @"browser_fill": @"Fill a form field in the browser",
        @"browser_screenshot": @"Take a screenshot of the browser viewport or full page",
        @"browser_get_text": @"Get visible text content from browser",
        @"browser_getVisibleText": @"Get visible text from any open tab by URL - DO NOT use browser_navigate first! Pass the 'url' parameter to read from a background tab without switching or navigating. This is the preferred method. Only falls back to active tab if no url is provided.",
        @"browser_searchVisibleText": @"Search for text in any open tab by URL. Pass 'url' parameter to search in a background tab without switching - no need to navigate first.",
        @"browser_getUIElements": @"Get interactive UI elements from any tab by URL. Use 'url' parameter to target a background tab without switching.",
        @"browser_clickElement": @"Click an element in any tab by URL. Use 'url' parameter to target a background tab without switching - no need to navigate first.",
        @"browser_fillElement": @"Fill a form field in any tab by URL. Use 'url' parameter to target a background tab without switching.",
        @"browser_get_elements": @"Get elements matching a selector",
        @"browser_select": @"Select an option from a dropdown",
        @"browser_wait": @"Wait for an element or condition",
        @"browser_back": @"Navigate back in browser history",
        @"browser_forward": @"Navigate forward in browser history",
        @"browser_refresh": @"Refresh the current page",
        @"browser_tabs": @"List or manage browser tabs",
        @"browser_evaluate": @"Execute JavaScript in the browser console",
        @"browser_getTabs": @"Get list of all open tabs",
        @"browser_getActiveTab": @"Get the currently active tab",
        @"browser_switchTab": @"Switch to a specific tab",
        @"browser_closeTab": @"Close a specific tab",
        @"browser_get_visible_html": @"Get the HTML content of the current page",
        @"browser_go_back": @"Navigate to previous page",
        @"browser_go_forward": @"Navigate to next page",
        @"browser_listConnected": @"List all connected browsers",
        @"browser_setDefaultBrowser": @"Set the default browser for commands"
    };

    NSString *description = descriptions[toolName];
    return description ?: [NSString stringWithFormat:@"Execute %@ tool", toolName];
}

- (NSDictionary *)getToolProperties:(NSString *)toolName {
    // Common properties that appear in most tools
    NSMutableDictionary *properties = [NSMutableDictionary dictionary];

    // Add agentId for all tools
    properties[@"agentId"] = @{
        @"type": @"string",
        @"description": @"Target agent ID (optional)"
    };

    // Tool-specific properties
    if ([toolName isEqualToString:@"desktop_screenshot"]) {
        properties[@"format"] = @{@"type": @"string", @"enum": @[@"png", @"jpeg"]};
        properties[@"quality"] = @{@"type": @"number", @"description": @"JPEG quality (0-100)"};
    }
    else if ([toolName isEqualToString:@"mouse_click"]) {
        properties[@"x"] = @{@"type": @"number"};
        properties[@"y"] = @{@"type": @"number"};
        properties[@"button"] = @{@"type": @"string", @"enum": @[@"left", @"right", @"middle"]};
        properties[@"clickCount"] = @{@"type": @"number", @"description": @"1 for single, 2 for double"};
    }
    else if ([toolName isEqualToString:@"mouse_move"]) {
        properties[@"x"] = @{@"type": @"number"};
        properties[@"y"] = @{@"type": @"number"};
    }
    else if ([toolName isEqualToString:@"mouse_drag"]) {
        properties[@"x1"] = @{@"type": @"number"};
        properties[@"y1"] = @{@"type": @"number"};
        properties[@"x2"] = @{@"type": @"number"};
        properties[@"y2"] = @{@"type": @"number"};
    }
    else if ([toolName isEqualToString:@"mouse_scroll"]) {
        properties[@"deltaX"] = @{@"type": @"number"};
        properties[@"deltaY"] = @{@"type": @"number"};
    }
    else if ([toolName isEqualToString:@"keyboard_type"]) {
        properties[@"text"] = @{@"type": @"string"};
    }
    else if ([toolName isEqualToString:@"keyboard_press"]) {
        properties[@"key"] = @{@"type": @"string"};
    }
    else if ([toolName isEqualToString:@"keyboard_shortcut"]) {
        properties[@"keys"] = @{@"type": @"string", @"description": @"e.g., 'Cmd+C' or 'Ctrl+Alt+Delete'"};
    }
    else if ([toolName isEqualToString:@"window_focus"]) {
        properties[@"windowId"] = @{@"type": @"string"};
    }
    else if ([toolName isEqualToString:@"app_launch"]) {
        properties[@"bundleId"] = @{@"type": @"string", @"description": @"e.g., 'com.apple.Safari'"};
    }
    else if ([toolName isEqualToString:@"clipboard_write"]) {
        properties[@"text"] = @{@"type": @"string"};
    }
    else if ([toolName hasPrefix:@"browser_"]) {
        // Browser tool properties
        properties[@"browser"] = @{@"type": @"string", @"description": @"Target browser (firefox, chrome, edge, safari)"};

        if ([toolName isEqualToString:@"browser_navigate"]) {
            properties[@"url"] = @{@"type": @"string"};
        }
        else if ([toolName isEqualToString:@"browser_click"]) {
            properties[@"selector"] = @{@"type": @"string"};
            properties[@"text"] = @{@"type": @"string"};
            properties[@"index"] = @{@"type": @"number"};
        }
        else if ([toolName isEqualToString:@"browser_fill"]) {
            properties[@"selector"] = @{@"type": @"string"};
            properties[@"value"] = @{@"type": @"string"};
        }
        else if ([toolName isEqualToString:@"browser_screenshot"]) {
            properties[@"fullPage"] = @{@"type": @"boolean"};
            properties[@"selector"] = @{@"type": @"string"};
        }
        else if ([toolName isEqualToString:@"browser_get_text"]) {
            properties[@"selector"] = @{@"type": @"string"};
        }
        else if ([toolName isEqualToString:@"browser_getVisibleText"]) {
            properties[@"url"] = @{@"type": @"string", @"description": @"URL of the tab to get text from (without switching tabs). Preferred method - no need to navigate or switch tabs first."};
            properties[@"selector"] = @{@"type": @"string", @"description": @"CSS selector to limit text extraction (optional)"};
            properties[@"tabId"] = @{@"type": @"number", @"description": @"Tab ID (optional, url is preferred)"};
        }
        else if ([toolName isEqualToString:@"browser_searchVisibleText"]) {
            properties[@"url"] = @{@"type": @"string", @"description": @"URL of the tab to search in (without switching). No need to navigate first."};
            properties[@"query"] = @{@"type": @"string", @"description": @"Text to search for"};
            properties[@"tabId"] = @{@"type": @"number", @"description": @"Tab ID (optional, url is preferred)"};
        }
        else if ([toolName isEqualToString:@"browser_getUIElements"]) {
            properties[@"url"] = @{@"type": @"string", @"description": @"URL of the tab to get elements from (without switching). No need to navigate first."};
            properties[@"tabId"] = @{@"type": @"number", @"description": @"Tab ID (optional, url is preferred)"};
        }
        else if ([toolName isEqualToString:@"browser_clickElement"]) {
            properties[@"url"] = @{@"type": @"string", @"description": @"URL of the tab to click in (without switching). No need to navigate first."};
            properties[@"selector"] = @{@"type": @"string", @"description": @"CSS selector of element to click"};
            properties[@"text"] = @{@"type": @"string", @"description": @"Text content to find and click"};
            properties[@"tabId"] = @{@"type": @"number", @"description": @"Tab ID (optional, url is preferred)"};
        }
        else if ([toolName isEqualToString:@"browser_fillElement"]) {
            properties[@"url"] = @{@"type": @"string", @"description": @"URL of the tab to fill in (without switching). No need to navigate first."};
            properties[@"selector"] = @{@"type": @"string", @"description": @"CSS selector of input to fill"};
            properties[@"value"] = @{@"type": @"string", @"description": @"Value to fill in"};
            properties[@"tabId"] = @{@"type": @"number", @"description": @"Tab ID (optional, url is preferred)"};
        }
        else if ([toolName isEqualToString:@"browser_evaluate"]) {
            properties[@"script"] = @{@"type": @"string", @"description": @"JavaScript code to execute"};
        }
        else if ([toolName isEqualToString:@"browser_switchTab"]) {
            properties[@"tabId"] = @{@"type": @"number"};
        }
        else if ([toolName isEqualToString:@"browser_closeTab"]) {
            properties[@"tabId"] = @{@"type": @"number"};
        }
    }

    return [properties copy];
}

- (NSArray *)getToolRequiredFields:(NSString *)toolName {
    // Define required fields for each tool
    if ([toolName isEqualToString:@"mouse_click"]) {
        return @[@"x", @"y"];
    }
    else if ([toolName isEqualToString:@"mouse_move"]) {
        return @[@"x", @"y"];
    }
    else if ([toolName isEqualToString:@"mouse_drag"]) {
        return @[@"x1", @"y1", @"x2", @"y2"];
    }
    else if ([toolName isEqualToString:@"keyboard_type"]) {
        return @[@"text"];
    }
    else if ([toolName isEqualToString:@"keyboard_press"]) {
        return @[@"key"];
    }
    else if ([toolName isEqualToString:@"keyboard_shortcut"]) {
        return @[@"keys"];
    }
    else if ([toolName isEqualToString:@"clipboard_write"]) {
        return @[@"text"];
    }
    else if ([toolName isEqualToString:@"browser_navigate"]) {
        return @[@"url"];
    }
    else if ([toolName isEqualToString:@"browser_fill"]) {
        return @[@"selector", @"value"];
    }
    else if ([toolName isEqualToString:@"browser_evaluate"]) {
        return @[@"script"];
    }

    return @[];
}

#pragma mark - Bundled Service Management

- (void)ensureBundledServiceRunning {
    // Check if service is already running on port 3459
    int servicePort = 3459;

    // Quick TCP check to see if something is listening
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        NSLog(@"[Service] Failed to create socket for port check");
        return;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(servicePort);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    int result = connect(sock, (struct sockaddr *)&addr, sizeof(addr));
    close(sock);

    if (result == 0) {
        NSLog(@"[Service] Service already running on port %d", servicePort);
        return;
    }

    // Service not running - start the bundled service
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    NSString *servicePath = [bundlePath stringByAppendingPathComponent:@"Contents/MacOS/ScreenControlService"];

    // Check if bundled service exists
    if (![[NSFileManager defaultManager] fileExistsAtPath:servicePath]) {
        NSLog(@"[Service] WARNING: Bundled ScreenControlService not found at %@", servicePath);
        // Try fallback location (for development)
        servicePath = @"/usr/local/bin/ScreenControlService";
        if (![[NSFileManager defaultManager] fileExistsAtPath:servicePath]) {
            NSLog(@"[Service] WARNING: ScreenControlService not found at fallback location either");
            return;
        }
    }

    NSLog(@"[Service] Starting bundled service from %@", servicePath);

    self.serviceTask = [[NSTask alloc] init];
    self.serviceTask.executableURL = [NSURL fileURLWithPath:servicePath];
    self.serviceTask.arguments = @[@"--port", [NSString stringWithFormat:@"%d", servicePort]];

    // Set up environment
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    self.serviceTask.environment = env;

    // Redirect output to log
    NSPipe *outputPipe = [NSPipe pipe];
    self.serviceTask.standardOutput = outputPipe;
    self.serviceTask.standardError = outputPipe;

    // Handle output asynchronously
    outputPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = [handle availableData];
        if (data.length > 0) {
            NSString *output = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            NSLog(@"[Service Output] %@", output);
        }
    };

    // Handle termination
    __weak typeof(self) weakSelf = self;
    self.serviceTask.terminationHandler = ^(NSTask *task) {
        NSLog(@"[Service] Service terminated with status %d", task.terminationStatus);
        dispatch_async(dispatch_get_main_queue(), ^{
            weakSelf.serviceTask = nil;
            // Restart if not intentionally stopped and app is still running
            if (!weakSelf.isAppTerminating) {
                NSLog(@"[Service] Restarting service in 2 seconds...");
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                    [weakSelf ensureBundledServiceRunning];
                });
            }
        });
    };

    NSError *error = nil;
    [self.serviceTask launchAndReturnError:&error];

    if (error) {
        NSLog(@"[Service] Failed to launch service: %@", error.localizedDescription);
        self.serviceTask = nil;
    } else {
        NSLog(@"[Service] Service launched with PID %d", self.serviceTask.processIdentifier);
    }
}

- (void)stopBundledService {
    if (self.serviceTask && self.serviceTask.isRunning) {
        NSLog(@"[Service] Stopping bundled service (PID %d)", self.serviceTask.processIdentifier);
        [self.serviceTask terminate];
        self.serviceTask = nil;
    }
}

#pragma mark - Login Item Management

static NSString *const kLaunchAgentLabel = @"com.knws.screencontrol.agent";
static NSString *const kRunAtLoginKey = @"runAtLogin";

- (NSString *)launchAgentPath {
    NSString *launchAgentsDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents"];
    return [launchAgentsDir stringByAppendingPathComponent:@"com.knws.screencontrol.agent.plist"];
}

- (BOOL)isRunAtLoginEnabled {
    // Check both user default and actual LaunchAgent existence
    BOOL defaultEnabled = [[NSUserDefaults standardUserDefaults] boolForKey:kRunAtLoginKey];
    BOOL agentExists = [[NSFileManager defaultManager] fileExistsAtPath:[self launchAgentPath]];
    return defaultEnabled && agentExists;
}

- (void)setRunAtLoginEnabled:(BOOL)enabled {
    [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:kRunAtLoginKey];
    [[NSUserDefaults standardUserDefaults] synchronize];

    NSString *launchAgentPath = [self launchAgentPath];
    NSFileManager *fm = [NSFileManager defaultManager];

    if (enabled) {
        // Create LaunchAgents directory if needed
        NSString *launchAgentsDir = [launchAgentPath stringByDeletingLastPathComponent];
        if (![fm fileExistsAtPath:launchAgentsDir]) {
            [fm createDirectoryAtPath:launchAgentsDir withIntermediateDirectories:YES attributes:nil error:nil];
        }

        // Create the plist
        NSString *appPath = [[NSBundle mainBundle] bundlePath];
        NSDictionary *plist = @{
            @"Label": kLaunchAgentLabel,
            @"ProgramArguments": @[
                [appPath stringByAppendingPathComponent:@"Contents/MacOS/ScreenControl"]
            ],
            @"RunAtLoad": @YES,
            @"KeepAlive": @{
                @"SuccessfulExit": @NO
            },
            @"ProcessType": @"Interactive",
            @"ThrottleInterval": @5
        };

        NSError *error = nil;
        NSData *plistData = [NSPropertyListSerialization dataWithPropertyList:plist
                                                                       format:NSPropertyListXMLFormat_v1_0
                                                                      options:0
                                                                        error:&error];
        if (error) {
            NSLog(@"[Login Item] Failed to serialize plist: %@", error);
            return;
        }

        if ([plistData writeToFile:launchAgentPath atomically:YES]) {
            NSLog(@"[Login Item] Created LaunchAgent at %@", launchAgentPath);

            // Load the LaunchAgent
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
            task.arguments = @[@"load", launchAgentPath];
            [task launchAndReturnError:nil];
            [task waitUntilExit];
            NSLog(@"[Login Item] LaunchAgent loaded");
        } else {
            NSLog(@"[Login Item] Failed to write LaunchAgent plist");
        }
    } else {
        // Unload and remove the LaunchAgent
        if ([fm fileExistsAtPath:launchAgentPath]) {
            // Unload first
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
            task.arguments = @[@"unload", launchAgentPath];
            [task launchAndReturnError:nil];
            [task waitUntilExit];

            // Remove the file
            NSError *error = nil;
            [fm removeItemAtPath:launchAgentPath error:&error];
            if (error) {
                NSLog(@"[Login Item] Failed to remove LaunchAgent: %@", error);
            } else {
                NSLog(@"[Login Item] Removed LaunchAgent");
            }
        }
    }
}

- (IBAction)runAtLoginCheckboxChanged:(id)sender {
    BOOL enabled = (self.runAtLoginCheckbox.state == NSControlStateValueOn);
    [self setRunAtLoginEnabled:enabled];
    NSLog(@"[Login Item] Run at login %@", enabled ? @"enabled" : @"disabled");
}

@end
