/**
 * ServiceClient
 *
 * HTTP client for communicating with the ScreenControl Service.
 * The service runs as a LaunchDaemon on port 3459 and handles:
 * - Control server WebSocket connection
 * - Shell/filesystem commands
 * - Machine lock/unlock
 *
 * This client is used by the tray app to:
 * - Check service status
 * - Get control server connection status
 * - Send commands that need to go through the service
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Service connection state
typedef NS_ENUM(NSInteger, ServiceConnectionState) {
    ServiceConnectionStateDisconnected,
    ServiceConnectionStateConnecting,
    ServiceConnectionStateConnected,
    ServiceConnectionStateError
};

@protocol ServiceClientDelegate <NSObject>
@optional
/// Called when service connection state changes
- (void)serviceClient:(id)client didChangeConnectionState:(ServiceConnectionState)state;
/// Called when control server connection state changes (via service)
- (void)serviceClient:(id)client controlServerDidConnect:(BOOL)connected agentId:(nullable NSString *)agentId licenseStatus:(nullable NSString *)status;
/// Called when server-controlled permissions change
- (void)serviceClient:(id)client permissionsDidChange:(BOOL)masterModeEnabled fileTransferEnabled:(BOOL)fileTransferEnabled localSettingsLocked:(BOOL)localSettingsLocked;
/// Called for logging
- (void)serviceClient:(id)client logMessage:(NSString *)message;
@end

@interface ServiceClient : NSObject

/// Service HTTP port (default: 3459)
@property (nonatomic, assign) int servicePort;

/// Current connection state
@property (nonatomic, readonly) ServiceConnectionState connectionState;

/// Whether the service is reachable
@property (nonatomic, readonly) BOOL isServiceAvailable;

/// Control server connection status (from service)
@property (nonatomic, readonly) BOOL isControlServerConnected;
@property (nonatomic, readonly, nullable) NSString *agentId;
@property (nonatomic, readonly, nullable) NSString *licenseStatus;

/// Server-controlled permissions (from heartbeat_ack)
@property (nonatomic, readonly) BOOL masterModeEnabled;
@property (nonatomic, readonly) BOOL fileTransferEnabled;
@property (nonatomic, readonly) BOOL localSettingsLocked;

/// Delegate
@property (nonatomic, weak, nullable) id<ServiceClientDelegate> delegate;

/// Shared instance
+ (instancetype)sharedInstance;

/// Initialize with specific port
- (instancetype)initWithPort:(int)port;

/// Start monitoring service status
- (void)startMonitoring;

/// Stop monitoring
- (void)stopMonitoring;

/// Check service health (async)
- (void)checkHealthWithCompletion:(void(^)(BOOL available, NSDictionary * _Nullable info, NSError * _Nullable error))completion;

/// Get control server status
- (void)getControlServerStatusWithCompletion:(void(^)(NSDictionary * _Nullable status, NSError * _Nullable error))completion;

/// Execute a tool via the service (for shell/fs commands)
- (void)executeToolWithName:(NSString *)name
                  arguments:(NSDictionary *)arguments
                 completion:(void(^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion;

/// Connect to control server (tells service to connect)
- (void)connectToControlServerWithConfig:(NSDictionary *)config
                              completion:(void(^)(BOOL success, NSError * _Nullable error))completion;

/// Disconnect from control server
- (void)disconnectFromControlServerWithCompletion:(void(^)(BOOL success, NSError * _Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
