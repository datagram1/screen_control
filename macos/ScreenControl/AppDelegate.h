/**
 * ScreenControl App Delegate
 * Menu bar app with status icon, native settings window, and MCP server
 */

#import <Cocoa/Cocoa.h>
#import "MCPServer.h"
#import "BrowserBridgeServer.h"
#import "BrowserWebSocketServer.h"
#import "GUIBridgeServer.h"
#import "ServiceClient.h"

#ifdef DEBUG
@class TestServer;
#endif

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate, MCPServerDelegate, BrowserBridgeServerDelegate, BrowserWebSocketServerDelegate, GUIBridgeServerDelegate, ServiceClientDelegate>

// Status bar
@property (strong, nonatomic) NSStatusItem *statusItem;
@property (strong, nonatomic) NSMenu *statusMenu;

// Settings window
@property (strong, nonatomic) NSWindow *settingsWindow;
@property (strong, nonatomic) NSTabView *settingsTabView;

// Tools configuration
@property (strong, nonatomic) NSMutableDictionary *toolsConfig;
@property (strong, nonatomic) NSScrollView *toolsScrollView;
@property (strong, nonatomic) NSMutableDictionary *categoryToggles;
@property (strong, nonatomic) NSMutableDictionary *toolToggles;

// Settings controls
@property (strong, nonatomic) NSTextField *agentNameField;
@property (strong, nonatomic) NSPopUpButton *networkModePopup;
@property (strong, nonatomic) NSTextField *portField;
@property (strong, nonatomic) NSTextField *apiKeyField;
@property (strong, nonatomic) NSButton *regenerateKeyButton;
@property (strong, nonatomic) NSButton *duplicateKeyButton;

// Control server settings
@property (strong, nonatomic) NSTextField *controlServerAddressField;
@property (strong, nonatomic) NSButton *connectButton;
@property (strong, nonatomic) NSTextField *connectionStatusLabel;
@property (strong, nonatomic) NSTextField *healthStatusLabel;

// Permission indicators
@property (strong, nonatomic) NSImageView *accessibilityIndicator;
@property (strong, nonatomic) NSImageView *screenRecordingIndicator;
@property (strong, nonatomic) NSTextField *accessibilityLabel;
@property (strong, nonatomic) NSTextField *screenRecordingLabel;

// Status display
@property (strong, nonatomic) NSTextField *statusLabel;
@property (strong, nonatomic) NSTextField *uptimeLabel;

// Current application tracking
@property (nonatomic, strong) NSString *currentAppBundleId;
@property (nonatomic, strong) NSDictionary *currentAppBounds;

// Browser bridge server (Node.js - deprecated, use WebSocket server instead)
@property (strong, nonatomic) BrowserBridgeServer *browserBridgeServer;

// Browser WebSocket server (Native replacement for Node.js bridge)
@property (strong, nonatomic) BrowserWebSocketServer *browserWebSocketServer;

// GUI Bridge server (receives commands from service)
@property (strong, nonatomic) GUIBridgeServer *guiBridgeServer;

// Service client (monitors and controls the background service)
@property (strong, nonatomic) ServiceClient *serviceClient;

// Bundled service process (launched by tray app)
@property (strong, nonatomic) NSTask *serviceTask;

// Service status UI
@property (strong, nonatomic) NSTextField *serviceStatusLabel;
@property (strong, nonatomic) NSImageView *serviceStatusIndicator;

// Run at Login checkbox
@property (strong, nonatomic) NSButton *runAtLoginCheckbox;

// Legacy browser bridge process properties (deprecated - using Native Messaging now)
@property (strong, nonatomic) NSTask *browserBridgeTask;
@property (strong, nonatomic) NSPipe *browserBridgePipe;

// Debug/ScreenControl WebSocket connection (via Service)
// Note: The actual WebSocket connection is managed by the service (port 3459)
// The app UI is used to configure and monitor the connection via ServiceClient
@property (strong, nonatomic) NSTextField *debugServerUrlField;
@property (strong, nonatomic) NSTextField *debugEndpointUuidField;
@property (strong, nonatomic) NSTextField *debugCustomerIdField;
@property (strong, nonatomic) NSButton *debugConnectButton;
@property (strong, nonatomic) NSButton *debugDisconnectButton;
@property (strong, nonatomic) NSTextField *debugConnectionStatusLabel;
@property (strong, nonatomic) NSTextField *debugLicenseStatusLabel;
@property (strong, nonatomic) NSTextField *debugAgentIdLabel;
@property (strong, nonatomic) NSTextView *debugLogView;
@property (strong, nonatomic) NSTextView *debugLogTextView;  // Alias for test server
@property (strong, nonatomic) NSButton *debugConnectOnStartupCheckbox;

// Connection state (from service via ServiceClient)
@property (assign, nonatomic) BOOL debugIsConnected;

// Reconnect UI (service handles actual reconnection)
@property (strong, nonatomic) NSButton *debugReconnectButton;

// OAuth-based connection (MCP URL discovery)
@property (strong, nonatomic) NSTextField *debugMcpUrlField;
@property (strong, nonatomic) NSButton *debugDiscoverButton;
@property (strong, nonatomic) NSTextField *debugOAuthStatusLabel;

// OAuth discovery results
@property (strong, nonatomic) NSString *oauthIssuer;
@property (strong, nonatomic) NSString *oauthAuthorizationEndpoint;
@property (strong, nonatomic) NSString *oauthTokenEndpoint;
@property (strong, nonatomic) NSString *oauthRegistrationEndpoint;

// OAuth client credentials (stored in Keychain after registration)
@property (strong, nonatomic) NSString *oauthClientId;
@property (strong, nonatomic) NSString *oauthClientSecret;
@property (strong, nonatomic) NSString *oauthAccessToken;
@property (strong, nonatomic) NSDate *oauthTokenExpiry;
@property (strong, nonatomic) NSTimer *oauthRefreshTimer;

// Discovered MCP endpoint info
@property (strong, nonatomic) NSString *mcpEndpointUuid;
@property (strong, nonatomic) NSString *mcpBaseUrl;

#ifdef DEBUG
// Test server for automated testing (DEBUG builds only)
@property (strong, nonatomic) TestServer *testServer;
#endif

// Debug action methods (exposed for TestServer)
- (IBAction)debugConnectClicked:(id)sender;
- (IBAction)debugDisconnectClicked:(id)sender;
- (IBAction)debugSaveSettingsClicked:(id)sender;
- (IBAction)debugReconnectClicked:(id)sender;
// NOTE: debugScheduleReconnect and debugCancelReconnect removed - service handles reconnection
- (void)discoverAndJoinClicked:(id)sender;

// Control Server methods (General tab)
- (void)connectControlServer:(id)sender;

// Browser Bridge methods
- (void)startBrowserBridge;
- (void)stopBrowserBridge;

// OAuth methods
- (void)discoverOAuthFromMcpUrl:(NSString *)mcpUrl;
- (void)registerOAuthClient;
- (void)requestOAuthToken;
- (void)connectWithOAuthToken;

// Keychain helpers
- (void)saveOAuthCredentialsToKeychain;
- (void)loadOAuthCredentialsFromKeychain;
- (void)clearOAuthCredentials;

// Tool execution (exposed for MCPServer HTTP endpoint)
- (NSDictionary *)executeToolFromWebSocket:(NSDictionary *)params;

// Tool advertisement (for dynamic capability discovery)
- (NSArray *)getAvailableTools;

// Service management (bundled ScreenControlService)
- (void)ensureBundledServiceRunning;
- (void)stopBundledService;

// Login item management
- (BOOL)isRunAtLoginEnabled;
- (void)setRunAtLoginEnabled:(BOOL)enabled;

@end
