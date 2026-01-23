#ifndef SCREENCONTROL_PLATFORM_H
#define SCREENCONTROL_PLATFORM_H

// Platform detection (can be overridden by CMake)
#if !defined(PLATFORM_MACOS) && !defined(PLATFORM_WINDOWS) && !defined(PLATFORM_LINUX)
    #if defined(__APPLE__) && defined(__MACH__)
        #define PLATFORM_MACOS 1
    #elif defined(_WIN32) || defined(_WIN64)
        #define PLATFORM_WINDOWS 1
    #elif defined(__linux__)
        #define PLATFORM_LINUX 1
    #else
        #error "Unsupported platform"
    #endif
#endif

// Platform name strings
#if PLATFORM_MACOS
    #define PLATFORM_NAME "macOS"
    #define PLATFORM_ID "macos"
#elif PLATFORM_WINDOWS
    #define PLATFORM_NAME "Windows"
    #define PLATFORM_ID "windows"
#elif PLATFORM_LINUX
    #define PLATFORM_NAME "Linux"
    #define PLATFORM_ID "linux"
#endif

// Path separators
#if PLATFORM_WINDOWS
    #define PATH_SEPARATOR "\\"
    #define PATH_SEPARATOR_CHAR '\\'
#else
    #define PATH_SEPARATOR "/"
    #define PATH_SEPARATOR_CHAR '/'
#endif

// Line endings
#if PLATFORM_WINDOWS
    #define LINE_ENDING "\r\n"
#else
    #define LINE_ENDING "\n"
#endif

// Service configuration paths
#if PLATFORM_MACOS
    #define SERVICE_CONFIG_DIR "/Library/Application Support/ScreenControl"
    #define SERVICE_LOG_DIR "/Library/Logs/ScreenControl"
    #define SERVICE_BINARY_PATH "/Library/PrivilegedHelperTools/com.screencontrol.service"
    #define SERVICE_PLIST_PATH "/Library/LaunchDaemons/com.screencontrol.service.plist"
    #define USER_CONFIG_DIR_TEMPLATE "/Users/%s/Library/Application Support/ScreenControl"
#elif PLATFORM_WINDOWS
    #define SERVICE_CONFIG_DIR "C:\\ProgramData\\ScreenControl"
    #define SERVICE_LOG_DIR "C:\\ProgramData\\ScreenControl\\Logs"
    #define SERVICE_BINARY_PATH "C:\\Program Files\\ScreenControl\\ScreenControlService.exe"
    #define USER_CONFIG_DIR_TEMPLATE "C:\\Users\\%s\\AppData\\Local\\ScreenControl"
#elif PLATFORM_LINUX
    #define SERVICE_CONFIG_DIR "/etc/screencontrol"
    #define SERVICE_LOG_DIR "/var/log/screencontrol"
    #define SERVICE_BINARY_PATH "/opt/screencontrol/screencontrol-service"
    #define SERVICE_SYSTEMD_PATH "/etc/systemd/system/screencontrol.service"
    #define USER_CONFIG_DIR_TEMPLATE "/home/%s/.config/screencontrol"
#endif

// HTTP server ports
#define HTTP_SERVER_PORT 3456     // Main service HTTP API (tray app connects here)
#define GUI_BRIDGE_PORT 3460      // GUI operations forwarded from service to tray app
#define WEBSOCKET_SERVER_PORT 3458
#define BROWSER_BRIDGE_PORT 3457  // Browser extension WebSocket (used by tray app only)

// Credential storage paths (PROTECTED - must be blocked from file tools)
#if PLATFORM_MACOS
    #define CREDENTIAL_FILE_PATH SERVICE_CONFIG_DIR "/credentials.enc"
    #define CREDENTIAL_KEY_PATH SERVICE_CONFIG_DIR "/k1.key"
#elif PLATFORM_WINDOWS
    #define CREDENTIAL_FILE_PATH SERVICE_CONFIG_DIR "\\credentials.enc"
    #define CREDENTIAL_KEY_PATH SERVICE_CONFIG_DIR "\\k1.key"
#elif PLATFORM_LINUX
    #define CREDENTIAL_FILE_PATH SERVICE_CONFIG_DIR "/credentials.enc"
    #define CREDENTIAL_KEY_PATH SERVICE_CONFIG_DIR "/k1.key"
#endif

// Platform-specific includes
#if PLATFORM_MACOS
    #include <unistd.h>
    #include <sys/types.h>
    #include <pwd.h>
#elif PLATFORM_WINDOWS
    #ifndef WIN32_LEAN_AND_MEAN
        #define WIN32_LEAN_AND_MEAN
    #endif
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif
    #include <windows.h>
    #include <winsock2.h>
#elif PLATFORM_LINUX
    #include <unistd.h>
    #include <sys/types.h>
    #include <pwd.h>
#endif

// Common standard library includes
#include <string>
#include <vector>
#include <functional>
#include <memory>
#include <cstdint>

namespace platform {

// Get current username
std::string getCurrentUsername();

// Get home directory for a user
std::string getUserHomeDir(const std::string& username = "");

// Get user-specific config directory
std::string getUserConfigDir(const std::string& username = "");

// Check if running as root/admin
bool isRunningAsRoot();

// Get process ID
int getProcessId();

// Sleep for milliseconds
void sleepMs(int milliseconds);

// Execute shell command and capture output
struct CommandResult {
    int exitCode;
    std::string stdoutData;
    std::string stderrData;
};

CommandResult executeCommand(const std::string& command, int timeoutMs = 120000);

// Service lifecycle (platform-specific implementation required)
namespace service {
    bool install();
    bool uninstall();
    bool start();
    bool stop();
    bool isRunning();
}

// Secure credential storage (platform-specific implementation required)
namespace secure_storage {
    // Store a key securely (Keychain on macOS, DPAPI on Windows, libsecret on Linux)
    bool storeKey(const std::string& keyId, const std::vector<uint8_t>& keyData);

    // Retrieve a key (returns empty on failure)
    std::vector<uint8_t> retrieveKey(const std::string& keyId);

    // Delete a stored key
    bool deleteKey(const std::string& keyId);

    // Check if a key exists
    bool keyExists(const std::string& keyId);
}

// Machine unlock (platform-specific implementation required)
namespace unlock {
    // Check if machine is locked
    bool isLocked();

    // Unlock machine with credentials (uses stored credentials)
    bool unlockWithStoredCredentials();

    // Store unlock credentials (write-only - NO retrieval API)
    bool storeUnlockCredentials(const std::string& username, const std::string& password);

    // Clear stored credentials
    bool clearStoredCredentials();

    // Check if credentials are stored
    bool hasStoredCredentials();

    // VNC password management (for login window unlock on macOS)
    // VNC provides RFB-level keyboard access that bypasses Secure Input
    bool storeVncPassword(const std::string& vncPassword);
    bool clearVncPassword();
    bool hasVncPassword();

    // Credential Provider support (Windows only)
    // These functions support the Windows Credential Provider for automatic unlock

    // Set unlock pending flag (called when remote unlock command received)
    void setUnlockPending(bool pending);

    // Check if unlock is pending
    bool isUnlockPending();

    // Get credentials for credential provider (internal use only - not exposed via HTTP)
    // Returns false if no credentials stored or if caller is not authorized
    bool getCredentialsForProvider(std::string& username, std::string& password, std::string& domain);

    // Report unlock result from credential provider
    void reportUnlockResult(bool success, const std::string& errorMessage);

    // Get last unlock error message
    std::string getLastUnlockError();
}

// GUI operations (Linux shell-based, Windows via tray app proxy)
namespace gui {
    // Take screenshot with grid overlay
    // Returns path to saved image, or empty string on failure
    std::string screenshotWithGrid(int cols, int rows, std::string& errorMsg);

    // Click at grid cell (e.g., "E7" or col=5, row=7) with optional offset
    bool clickGrid(const std::string& cell, int col, int row, int cols, int rows, bool rightButton = false,
                   int offsetX = 0, int offsetY = 0);

    // Click at coordinates relative to a window
    bool clickRelative(const std::string& identifier, int relX, int relY, bool rightButton = false, bool focus = true);

    // Click at absolute screen coordinates
    bool clickAt(int x, int y, bool rightButton = false);

    // Type text
    bool typeText(const std::string& text);

    // Get display server type (X11, Wayland/GNOME, etc.)
    std::string getDisplayServer();
}

// Dependency management (Linux runtime dependency detection/installation)
namespace deps {
    // Status of grid tool dependencies
    struct DependencyStatus {
        bool screenshotTool = false;
        bool inputTool = false;
        bool imageMagick = false;
        std::string screenshotToolName;
        std::string inputToolName;
        std::string missingPackages;
        std::string installCommand;
        std::string displayServer;
        std::string packageManager;
    };

    // Check if all dependencies are available
    DependencyStatus checkDependencies();

    // Attempt to install missing dependencies (requires root)
    bool installDependencies(bool interactive = true);

    // Get a shell script that installs dependencies
    std::string getInstallScript();
}

} // namespace platform

#endif // SCREENCONTROL_PLATFORM_H
