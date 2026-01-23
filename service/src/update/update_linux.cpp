/**
 * Linux Update Installer
 *
 * Handles update installation on Linux:
 * - Stops systemd service
 * - Backs up config from /etc
 * - Extracts and replaces binaries
 * - Restores config
 * - Restarts service
 */

#include "update_manager.h"
#include "../core/logger.h"

#if PLATFORM_LINUX

#include <fstream>
#include <filesystem>
#include <cstdlib>
#include <unistd.h>
#include <sys/stat.h>
#include <pwd.h>

namespace fs = std::filesystem;

namespace ScreenControl
{

bool UpdateManager::applyUpdateLinux()
{
    log("Starting Linux update installation...");

    const std::string serviceName = "screencontrol";
    const std::string installDir = "/opt/screencontrol";
    const std::string configDir = "/etc/screencontrol";
    const std::string backupDir = getBackupDir();
    const std::string downloadDir = getDownloadDir();

    try
    {
        // 1. Create backup directory
        log("Creating backup directory...");
        fs::create_directories(backupDir);

        // 2. Backup current binaries
        if (fs::exists(installDir))
        {
            log("Backing up current installation...");
            fs::copy(installDir, backupDir + "/install",
                    fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        }

        // 3. Backup config
        if (fs::exists(configDir))
        {
            log("Backing up configuration...");
            fs::copy(configDir, backupDir + "/config",
                    fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        }

        // 4. Create update script
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
        script << "if command -v systemctl &> /dev/null; then\n";
        script << "    systemctl stop " << serviceName << " 2>/dev/null || true\n";
        script << "elif command -v service &> /dev/null; then\n";
        script << "    service " << serviceName << " stop 2>/dev/null || true\n";
        script << "fi\n";
        script << "sleep 2\n\n";

        // Extract update
        script << "echo \"Extracting update...\"\n";
        script << "cd \"" << downloadDir << "\"\n";
        script << "tar -xzf \"" << m_downloadPath << "\"\n\n";

        // Install new binary
        // Tarball extracts to screencontrol/ subdirectory with ScreenControlService binary
        script << "echo \"Installing new binary...\"\n";
        script << "EXTRACT_DIR=\"" << downloadDir << "/screencontrol\"\n";
        script << "if [ -f \"$EXTRACT_DIR/ScreenControlService\" ]; then\n";
        script << "    cp -f \"$EXTRACT_DIR/ScreenControlService\" \"" << installDir << "/ScreenControlService\"\n";
        script << "    chmod 755 \"" << installDir << "/ScreenControlService\"\n";
        script << "    echo \"Installed ScreenControlService\"\n";
        script << "elif [ -f \"" << downloadDir << "/ScreenControlService\" ]; then\n";
        script << "    # Fallback: binary directly in download dir\n";
        script << "    cp -f \"" << downloadDir << "/ScreenControlService\" \"" << installDir << "/ScreenControlService\"\n";
        script << "    chmod 755 \"" << installDir << "/ScreenControlService\"\n";
        script << "    echo \"Installed ScreenControlService (flat)\"\n";
        script << "else\n";
        script << "    echo \"ERROR: ScreenControlService not found in update package!\"\n";
        script << "    echo \"Contents of download dir:\"\n";
        script << "    ls -la \"" << downloadDir << "\"\n";
        script << "    ls -la \"$EXTRACT_DIR\" 2>/dev/null || true\n";
        script << "    exit 1\n";
        script << "fi\n\n";

        // Start service
        script << "echo \"Starting service...\"\n";
        script << "if command -v systemctl &> /dev/null; then\n";
        script << "    systemctl start " << serviceName << "\n";
        script << "elif command -v service &> /dev/null; then\n";
        script << "    service " << serviceName << " start\n";
        script << "fi\n\n";

        // Cleanup
        script << "echo \"Cleaning up...\"\n";
        script << "rm -rf \"" << downloadDir << "\"\n\n";

        script << "echo \"$(date): Update complete!\"\n";

        script.close();

        // Make script executable
        chmod(updateScript.c_str(), 0755);

        // 5. Execute update script with root privileges
        log("Executing update script...");

        uid_t uid = getuid();
        std::string cmd;

        if (uid == 0)
        {
            // Running as root - execute directly
            cmd = "/bin/bash \"" + updateScript + "\" &";
        }
        else
        {
            // Need elevation - try pkexec first, fall back to sudo
            cmd = "pkexec /bin/bash \"" + updateScript + "\" &";

            // Check if pkexec is available
            if (system("command -v pkexec &>/dev/null") != 0)
            {
                // Fall back to sudo with a terminal
                const char* terminal = nullptr;

                if (system("command -v gnome-terminal &>/dev/null") == 0)
                {
                    terminal = "gnome-terminal -- ";
                }
                else if (system("command -v xterm &>/dev/null") == 0)
                {
                    terminal = "xterm -e ";
                }
                else if (system("command -v konsole &>/dev/null") == 0)
                {
                    terminal = "konsole -e ";
                }

                if (terminal)
                {
                    cmd = std::string(terminal) + "sudo /bin/bash \"" + updateScript + "\" &";
                }
                else
                {
                    // No graphical terminal - try sudo directly (may fail without TTY)
                    cmd = "sudo /bin/bash \"" + updateScript + "\" &";
                }
            }
        }

        system(cmd.c_str());

        // Give the script time to start before we exit
        sleep(1);

        log("Update script launched. Service will restart.");

        // Exit so the script can replace us
        exit(0);

        return true;
    }
    catch (const std::exception& e)
    {
        log("Update failed: " + std::string(e.what()));

        // Attempt rollback
        log("Attempting rollback...");
        try
        {
            if (fs::exists(backupDir + "/install"))
            {
                fs::copy(backupDir + "/install", installDir,
                        fs::copy_options::recursive | fs::copy_options::overwrite_existing);
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

#endif // PLATFORM_LINUX
