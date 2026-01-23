/**
 * Update Manager for ScreenControl Service
 *
 * Handles checking for updates, downloading, verifying, and applying updates.
 * Cross-platform support for Windows, macOS, and Linux.
 */

#pragma once

#include "../libs/json.hpp"
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <mutex>
#include <memory>

namespace ScreenControl
{

// Update configuration
struct UpdateConfig
{
    std::string serverUrl = "https://screencontrol.knws.co.uk";
    std::string machineId;
    std::string fingerprint;
    std::string currentVersion;
    std::string platform;    // "windows", "macos", "linux"
    std::string arch;        // "x64", "arm64"
    std::string channel = "STABLE";  // "STABLE", "BETA", "DEV"

    // Update behavior
    bool autoDownload = true;
    bool autoInstall = false;
    int checkIntervalHeartbeats = 60;  // Check every N heartbeats (60 * 5s = ~5 mins)
    int failedRetryTimeoutSeconds = 600;  // Retry after 10 minutes if in FAILED state
};

// Update status
enum class UpdateStatus
{
    IDLE,           // No update activity
    CHECKING,       // Checking for updates
    AVAILABLE,      // Update available, not downloaded
    DOWNLOADING,    // Downloading update
    DOWNLOADED,     // Downloaded and verified
    INSTALLING,     // Installing update
    FAILED,         // Update failed
    UP_TO_DATE      // No update needed
};

// Update information
struct UpdateInfo
{
    std::string version;
    std::string channel;
    uint64_t size = 0;
    std::string sha256;
    std::string filename;
    std::string releaseNotes;
    std::string downloadUrl;
    bool isForced = false;
};

class UpdateManager
{
public:
    // Callback types
    using StatusCallback = std::function<void(UpdateStatus status, const std::string& message)>;
    using ProgressCallback = std::function<void(uint64_t downloaded, uint64_t total)>;

    UpdateManager();
    ~UpdateManager();

    // Singleton access
    static UpdateManager& getInstance();

    // Configuration
    void configure(const UpdateConfig& config);

    // Called on heartbeat_ack with update flag
    // flag: 0 = no update, 1 = update available, 2 = forced update
    void onHeartbeat(int updateFlag);

    // Manual operations
    void checkForUpdate();
    void downloadUpdate();
    void applyUpdate();
    void cancelDownload();

    // Status
    UpdateStatus getStatus() const { return m_status; }
    UpdateInfo getUpdateInfo() const;
    int getDownloadProgress() const;  // 0-100

    // Callbacks
    void setStatusCallback(StatusCallback cb) { m_statusCallback = cb; }
    void setProgressCallback(ProgressCallback cb) { m_progressCallback = cb; }

private:
    void log(const std::string& message);

    // HTTP operations
    bool httpGet(const std::string& url, std::string& response);
    bool httpDownload(const std::string& url, const std::string& destPath,
                      std::function<void(uint64_t, uint64_t)> progressCallback);

    // Verification
    bool verifyChecksum(const std::string& filepath, const std::string& expectedSha256);

    // Platform-specific installers
    bool applyUpdateWindows();
    bool applyUpdateMacOS();
    bool applyUpdateLinux();

    // Paths
    std::string getDownloadDir();
    std::string getBackupDir();
    std::string getInstallDir();

    // Configuration
    UpdateConfig m_config;
    int m_heartbeatCount = 0;

    // State
    std::atomic<UpdateStatus> m_status{UpdateStatus::IDLE};
    std::chrono::steady_clock::time_point m_failedTimestamp;
    UpdateInfo m_updateInfo;
    std::string m_downloadPath;
    std::atomic<uint64_t> m_downloaded{0};
    std::atomic<uint64_t> m_totalSize{0};

    // Threading
    std::thread m_workerThread;
    std::atomic<bool> m_cancelDownload{false};
    std::mutex m_mutex;

    // Callbacks
    StatusCallback m_statusCallback;
    ProgressCallback m_progressCallback;
};

} // namespace ScreenControl
