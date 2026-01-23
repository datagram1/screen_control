/**
 * macOS Update Installer
 *
 * Handles update installation on macOS:
 * - Stops launchd service
 * - Backs up config
 * - Extracts and replaces binaries
 * - Restores config
 * - Restarts service
 */

#include "update_manager.h"
#include "../core/logger.h"

#if PLATFORM_MACOS

#include <fstream>
#include <filesystem>
#include <cstdlib>
#include <unistd.h>
#include <sys/stat.h>

namespace fs = std::filesystem;

namespace ScreenControl
{

bool UpdateManager::applyUpdateMacOS()
{
    log("Starting macOS update installation...");

    const std::string serviceName = "com.screencontrol.service";
    const std::string servicePlist = "/Library/LaunchDaemons/" + serviceName + ".plist";
    const std::string helperPath = "/Library/PrivilegedHelperTools/" + serviceName;
    const std::string configDir = "/Library/Application Support/ScreenControl";
    const std::string backupDir = getBackupDir();
    const std::string downloadDir = getDownloadDir();

    try
    {
        // 1. Create backup directory
        log("Creating backup directory...");
        fs::create_directories(backupDir);

        // 2. Backup current binary
        if (fs::exists(helperPath))
        {
            log("Backing up current binary...");
            fs::copy_file(helperPath, backupDir + "/" + serviceName,
                         fs::copy_options::overwrite_existing);
        }

        // 3. Backup config
        if (fs::exists(configDir))
        {
            log("Backing up configuration...");
            fs::copy(configDir, backupDir + "/config",
                    fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        }

        // 4. Create update script
        // We use a shell script because we can't replace ourselves while running
        std::string updateScript = downloadDir + "/update.sh";

        std::ofstream script(updateScript);
        if (!script.is_open())
        {
            log("Failed to create update script");
            return false;
        }

        script << "#!/bin/bash\n";
        script << "# ScreenControl Update Script\n";
        script << "# Generated: " << std::time(nullptr) << "\n\n";

        script << "set -e\n\n";

        script << "LOG_FILE=\"/tmp/screencontrol_update.log\"\n";
        script << "exec >> \"$LOG_FILE\" 2>&1\n\n";

        script << "echo \"$(date): Starting update to v" << m_updateInfo.version << "\"\n\n";

        // Stop service
        script << "echo \"Stopping service...\"\n";
        script << "launchctl unload \"" << servicePlist << "\" 2>/dev/null || true\n";
        script << "sleep 2\n\n";

        // Extract update (assuming tar.gz)
        script << "echo \"Extracting update...\"\n";
        script << "cd \"" << downloadDir << "\"\n";
        script << "tar -xzf \"" << m_downloadPath << "\" 2>/dev/null || unzip -o \"" << m_downloadPath << "\"\n\n";

        // Install new binary
        // Tarball extracts to screencontrol/ subdirectory with ScreenControlService binary
        script << "echo \"Installing new binary...\"\n";
        script << "EXTRACT_DIR=\"" << downloadDir << "/screencontrol\"\n";
        script << "if [ -f \"$EXTRACT_DIR/ScreenControlService\" ]; then\n";
        script << "    cp -f \"$EXTRACT_DIR/ScreenControlService\" \"" << helperPath << "\"\n";
        script << "    chmod 755 \"" << helperPath << "\"\n";
        script << "    chown root:wheel \"" << helperPath << "\"\n";
        script << "    echo \"Installed ScreenControlService as " << serviceName << "\"\n";
        script << "elif [ -f \"" << downloadDir << "/ScreenControlService\" ]; then\n";
        script << "    # Fallback: binary directly in download dir\n";
        script << "    cp -f \"" << downloadDir << "/ScreenControlService\" \"" << helperPath << "\"\n";
        script << "    chmod 755 \"" << helperPath << "\"\n";
        script << "    chown root:wheel \"" << helperPath << "\"\n";
        script << "    echo \"Installed ScreenControlService (flat) as " << serviceName << "\"\n";
        script << "else\n";
        script << "    echo \"ERROR: ScreenControlService not found in update package!\"\n";
        script << "    echo \"Contents of download dir:\"\n";
        script << "    ls -la \"" << downloadDir << "\"\n";
        script << "    ls -la \"$EXTRACT_DIR\" 2>/dev/null || true\n";
        script << "    exit 1\n";
        script << "fi\n\n";

        // Start service
        script << "echo \"Starting service...\"\n";
        script << "launchctl load \"" << servicePlist << "\"\n\n";

        // Cleanup
        script << "echo \"Cleaning up...\"\n";
        script << "rm -rf \"" << downloadDir << "\"\n\n";

        script << "echo \"$(date): Update complete!\"\n";

        script.close();

        // Make script executable
        chmod(updateScript.c_str(), 0755);

        // 5. Execute update script with root privileges
        log("Executing update script...");

        // Use AuthorizationExecuteWithPrivileges or launchctl to run as root
        // For service mode (already running as root), we can use system()
        // For GUI mode, would need to use Authorization Services

        uid_t uid = getuid();
        if (uid == 0)
        {
            // Running as root - execute directly
            std::string cmd = "/bin/bash \"" + updateScript + "\" &";
            system(cmd.c_str());

            // Give the script time to start before we exit
            sleep(1);

            log("Update script launched. Service will restart.");

            // Exit so the script can replace us
            exit(0);
        }
        else
        {
            // Not running as root - need elevation
            // Create an AppleScript to run with admin privileges
            std::string appleScript =
                "do shell script \"/bin/bash '" + updateScript + "'\" with administrator privileges";

            std::string cmd = "osascript -e '" + appleScript + "' &";
            system(cmd.c_str());

            sleep(1);
            exit(0);
        }

        return true;
    }
    catch (const std::exception& e)
    {
        log("Update failed: " + std::string(e.what()));

        // Attempt rollback
        log("Attempting rollback...");
        try
        {
            if (fs::exists(backupDir + "/" + serviceName))
            {
                fs::copy_file(backupDir + "/" + serviceName, helperPath,
                             fs::copy_options::overwrite_existing);
                log("Rollback successful");
            }
        }
        catch (...)
        {
            log("Rollback failed!");
        }

        return false;
    }
}

} // namespace ScreenControl

#endif // PLATFORM_MACOS
