/**
 * ServiceClient Implementation
 *
 * HTTP client for communicating with the ScreenControl Service.
 */

#import "ServiceClient.h"

@interface ServiceClient ()
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSTimer *monitorTimer;
@property (nonatomic, assign) ServiceConnectionState state;
@property (nonatomic, assign) BOOL serviceAvailable;
@property (nonatomic, assign) BOOL controlServerConnected;
@property (nonatomic, strong) NSString *currentAgentId;
@property (nonatomic, strong) NSString *currentLicenseStatus;
// Server-controlled permissions
@property (nonatomic, assign) BOOL currentMasterModeEnabled;
@property (nonatomic, assign) BOOL currentFileTransferEnabled;
@property (nonatomic, assign) BOOL currentLocalSettingsLocked;
@end

@implementation ServiceClient

+ (instancetype)sharedInstance {
    static ServiceClient *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[ServiceClient alloc] initWithPort:3459];
    });
    return instance;
}

- (instancetype)initWithPort:(int)port {
    self = [super init];
    if (self) {
        _servicePort = port;
        _state = ServiceConnectionStateDisconnected;
        _serviceAvailable = NO;
        _controlServerConnected = NO;

        NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
        config.timeoutIntervalForRequest = 5.0;
        config.timeoutIntervalForResource = 10.0;
        _session = [NSURLSession sessionWithConfiguration:config];
    }
    return self;
}

- (ServiceConnectionState)connectionState {
    return _state;
}

- (BOOL)isServiceAvailable {
    return _serviceAvailable;
}

- (BOOL)isControlServerConnected {
    return _controlServerConnected;
}

- (NSString *)agentId {
    return _currentAgentId;
}

- (NSString *)licenseStatus {
    return _currentLicenseStatus;
}

- (BOOL)masterModeEnabled {
    return _currentMasterModeEnabled;
}

- (BOOL)fileTransferEnabled {
    return _currentFileTransferEnabled;
}

- (BOOL)localSettingsLocked {
    return _currentLocalSettingsLocked;
}

- (void)log:(NSString *)message {
    NSLog(@"[ServiceClient] %@", message);
    if ([self.delegate respondsToSelector:@selector(serviceClient:logMessage:)]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.delegate serviceClient:self logMessage:message];
        });
    }
}

- (NSString *)baseURL {
    return [NSString stringWithFormat:@"http://127.0.0.1:%d", self.servicePort];
}

#pragma mark - Monitoring

- (void)startMonitoring {
    [self stopMonitoring];

    // Check immediately
    [self checkServiceStatus];

    // Then check every 5 seconds
    self.monitorTimer = [NSTimer scheduledTimerWithTimeInterval:5.0
                                                         target:self
                                                       selector:@selector(checkServiceStatus)
                                                       userInfo:nil
                                                        repeats:YES];
    [self log:@"Started monitoring service"];
}

- (void)stopMonitoring {
    if (self.monitorTimer) {
        [self.monitorTimer invalidate];
        self.monitorTimer = nil;
        [self log:@"Stopped monitoring service"];
    }
}

- (void)checkServiceStatus {
    [self checkHealthWithCompletion:^(BOOL available, NSDictionary *info, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            BOOL wasAvailable = self.serviceAvailable;
            self.serviceAvailable = available;

            if (available != wasAvailable) {
                self.state = available ? ServiceConnectionStateConnected : ServiceConnectionStateDisconnected;
                [self log:[NSString stringWithFormat:@"Service %@", available ? @"connected" : @"disconnected"]];

                if ([self.delegate respondsToSelector:@selector(serviceClient:didChangeConnectionState:)]) {
                    [self.delegate serviceClient:self didChangeConnectionState:self.state];
                }
            }

            if (available) {
                // Also get control server status
                [self getControlServerStatusWithCompletion:^(NSDictionary *status, NSError *statusError) {
                    if (status) {
                        BOOL wasConnected = self.controlServerConnected;
                        self.controlServerConnected = [status[@"connected"] boolValue];
                        self.currentAgentId = status[@"agentId"];
                        self.currentLicenseStatus = status[@"licenseStatus"];

                        if (self.controlServerConnected != wasConnected) {
                            if ([self.delegate respondsToSelector:@selector(serviceClient:controlServerDidConnect:agentId:licenseStatus:)]) {
                                dispatch_async(dispatch_get_main_queue(), ^{
                                    [self.delegate serviceClient:self
                                      controlServerDidConnect:self.controlServerConnected
                                                      agentId:self.currentAgentId
                                                licenseStatus:self.currentLicenseStatus];
                                });
                            }
                        }

                        // Handle server-controlled permissions
                        NSDictionary *permissions = status[@"permissions"];
                        if (permissions) {
                            BOOL masterMode = [permissions[@"masterMode"] boolValue];
                            BOOL fileTransfer = [permissions[@"fileTransfer"] boolValue];
                            BOOL localSettingsLocked = [permissions[@"localSettingsLocked"] boolValue];

                            // Check if any permission changed
                            if (masterMode != self.currentMasterModeEnabled ||
                                fileTransfer != self.currentFileTransferEnabled ||
                                localSettingsLocked != self.currentLocalSettingsLocked) {

                                self.currentMasterModeEnabled = masterMode;
                                self.currentFileTransferEnabled = fileTransfer;
                                self.currentLocalSettingsLocked = localSettingsLocked;

                                if ([self.delegate respondsToSelector:@selector(serviceClient:permissionsDidChange:fileTransferEnabled:localSettingsLocked:)]) {
                                    dispatch_async(dispatch_get_main_queue(), ^{
                                        [self.delegate serviceClient:self
                                                permissionsDidChange:masterMode
                                               fileTransferEnabled:fileTransfer
                                              localSettingsLocked:localSettingsLocked];
                                    });
                                }
                            }
                        }
                    }
                }];
            }
        });
    }];
}

#pragma mark - API Methods

- (void)checkHealthWithCompletion:(void(^)(BOOL available, NSDictionary *info, NSError *error))completion {
    NSString *urlString = [NSString stringWithFormat:@"%@/health", [self baseURL]];
    NSURL *url = [NSURL URLWithString:urlString];

    NSURLSessionDataTask *task = [self.session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            completion(NO, nil, error);
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        if (httpResponse.statusCode != 200) {
            completion(NO, nil, nil);
            return;
        }

        NSDictionary *json = nil;
        if (data) {
            json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        }

        completion(YES, json, nil);
    }];
    [task resume];
}

- (void)getControlServerStatusWithCompletion:(void(^)(NSDictionary *status, NSError *error))completion {
    NSString *urlString = [NSString stringWithFormat:@"%@/control-server/status", [self baseURL]];
    NSURL *url = [NSURL URLWithString:urlString];

    NSURLSessionDataTask *task = [self.session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            completion(nil, error);
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        if (httpResponse.statusCode != 200) {
            completion(nil, [NSError errorWithDomain:@"ServiceClient" code:httpResponse.statusCode userInfo:nil]);
            return;
        }

        NSDictionary *json = nil;
        if (data) {
            json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        }

        completion(json, nil);
    }];
    [task resume];
}

- (void)executeToolWithName:(NSString *)name
                  arguments:(NSDictionary *)arguments
                 completion:(void(^)(NSDictionary *result, NSError *error))completion {

    NSString *urlString = [NSString stringWithFormat:@"%@/tool", [self baseURL]];
    NSURL *url = [NSURL URLWithString:urlString];

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

    NSDictionary *body = @{
        @"method": name,
        @"params": arguments ?: @{}
    };

    NSError *jsonError = nil;
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:&jsonError];
    if (jsonError) {
        completion(nil, jsonError);
        return;
    }

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            completion(nil, error);
            return;
        }

        NSDictionary *json = nil;
        if (data) {
            json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        }

        completion(json, nil);
    }];
    [task resume];
}

- (void)connectToControlServerWithConfig:(NSDictionary *)config
                              completion:(void(^)(BOOL success, NSError *error))completion {

    NSString *urlString = [NSString stringWithFormat:@"%@/control-server/connect", [self baseURL]];
    NSURL *url = [NSURL URLWithString:urlString];

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

    NSError *jsonError = nil;
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:config options:0 error:&jsonError];
    if (jsonError) {
        completion(NO, jsonError);
        return;
    }

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            completion(NO, error);
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        completion(httpResponse.statusCode == 200, nil);
    }];
    [task resume];
}

- (void)disconnectFromControlServerWithCompletion:(void(^)(BOOL success, NSError *error))completion {
    NSString *urlString = [NSString stringWithFormat:@"%@/control-server/disconnect", [self baseURL]];
    NSURL *url = [NSURL URLWithString:urlString];

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
            completion(NO, error);
            return;
        }

        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        completion(httpResponse.statusCode == 200, nil);
    }];
    [task resume];
}

@end
