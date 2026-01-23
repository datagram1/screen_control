/**
 * Windows Update Installer
 *
 * Handles update installation on Windows:
 * - Stops Windows service and tray application
 * - Backs up config from ProgramData
 * - Extracts and replaces binaries
 * - Restores config
 * - Restarts service and tray
 */

#include "update_manager.h"
#include "../core/logger.h"

#if PLATFORM_WINDOWS

#include <windows.h>
#include <fstream>
#include <filesystem>
#include <shellapi.h>
#include <shlobj.h>

namespace fs = std::filesystem;

namespace ScreenControl
{

bool UpdateManager::applyUpdateWindows()
{
    log("Starting Windows update installation...");

    const std::wstring serviceName = L"ScreenControlService";
    const std::string installDir = "C:\\Program Files\\ScreenControl";
    const std::string configDir = "C:\\ProgramData\\ScreenControl";
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
            fs::copy(installDir, backupDir + "\\install",
                    fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        }

        // 3. Backup config
        if (fs::exists(configDir))
        {
            log("Backing up configuration...");
            fs::copy(configDir, backupDir + "\\config",
                    fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        }

        // 4. Create update batch script
        std::string updateScript = downloadDir + "\\update.bat";

        std::ofstream script(updateScript);
        if (!script.is_open())
        {
            log("Failed to create update script");
            return false;
        }

        script << "@echo off\r\n";
        script << "REM ScreenControl Update Script\r\n";
        script << "REM Generated: " << std::time(nullptr) << "\r\n\r\n";

        script << "setlocal enabledelayedexpansion\r\n\r\n";

        script << "set LOG_FILE=%TEMP%\\screencontrol_update.log\r\n";
        script << "echo %date% %time%: Starting update to v" << m_updateInfo.version << " >> \"%LOG_FILE%\"\r\n\r\n";

        // Stop tray application
        script << "echo Stopping tray application... >> \"%LOG_FILE%\"\r\n";
        script << "taskkill /F /IM ScreenControlTray.exe 2>nul\r\n";
        script << "timeout /t 2 /nobreak >nul\r\n\r\n";

        // Stop service
        script << "echo Stopping service... >> \"%LOG_FILE%\"\r\n";
        script << "net stop ScreenControlService 2>nul\r\n";
        script << "sc stop ScreenControlService 2>nul\r\n";
        script << "timeout /t 3 /nobreak >nul\r\n\r\n";

        // Extract update
        script << "echo Extracting update... >> \"%LOG_FILE%\"\r\n";
        script << "cd /d \"" << downloadDir << "\"\r\n";
        script << "powershell -Command \"Expand-Archive -Path '" << m_downloadPath << "' -DestinationPath '.' -Force\" >> \"%LOG_FILE%\" 2>&1\r\n\r\n";

        // Install new files
        // Archive extracts to screencontrol/ subdirectory
        script << "echo Installing new files... >> \"%LOG_FILE%\"\r\n";
        script << "set EXTRACT_DIR=" << downloadDir << "\\screencontrol\r\n";
        script << "if exist \"%EXTRACT_DIR%\\ScreenControlService.exe\" (\r\n";
        script << "    copy /Y \"%EXTRACT_DIR%\\ScreenControlService.exe\" \"" << installDir << "\\\" >> \"%LOG_FILE%\"\r\n";
        script << "    echo Installed ScreenControlService.exe from subdirectory >> \"%LOG_FILE%\"\r\n";
        script << ") else if exist \"" << downloadDir << "\\ScreenControlService.exe\" (\r\n";
        script << "    copy /Y \"" << downloadDir << "\\ScreenControlService.exe\" \"" << installDir << "\\\" >> \"%LOG_FILE%\"\r\n";
        script << "    echo Installed ScreenControlService.exe from flat >> \"%LOG_FILE%\"\r\n";
        script << ") else (\r\n";
        script << "    echo ERROR: ScreenControlService.exe not found! >> \"%LOG_FILE%\"\r\n";
        script << "    dir \"" << downloadDir << "\" >> \"%LOG_FILE%\"\r\n";
        script << "    dir \"%EXTRACT_DIR%\" 2>nul >> \"%LOG_FILE%\"\r\n";
        script << "    exit /b 1\r\n";
        script << ")\r\n";
        script << "if exist \"%EXTRACT_DIR%\\ScreenControlTray.exe\" (\r\n";
        script << "    copy /Y \"%EXTRACT_DIR%\\ScreenControlTray.exe\" \"" << installDir << "\\\" >> \"%LOG_FILE%\"\r\n";
        script << ") else if exist \"" << downloadDir << "\\ScreenControlTray.exe\" (\r\n";
        script << "    copy /Y \"" << downloadDir << "\\ScreenControlTray.exe\" \"" << installDir << "\\\" >> \"%LOG_FILE%\"\r\n";
        script << ")\r\n\r\n";

        // Start service
        script << "echo Starting service... >> \"%LOG_FILE%\"\r\n";
        script << "net start ScreenControlService >> \"%LOG_FILE%\" 2>&1\r\n\r\n";

        // Start tray application (for logged-in user)
        script << "echo Starting tray application... >> \"%LOG_FILE%\"\r\n";
        script << "start \"\" \"" << installDir << "\\ScreenControlTray.exe\"\r\n\r\n";

        // Cleanup
        script << "echo Cleaning up... >> \"%LOG_FILE%\"\r\n";
        script << "timeout /t 5 /nobreak >nul\r\n";
        script << "rd /s /q \"" << downloadDir << "\" 2>nul\r\n\r\n";

        script << "echo %date% %time%: Update complete! >> \"%LOG_FILE%\"\r\n";

        script.close();

        // 5. Execute update script with elevation
        log("Executing update script...");

        SHELLEXECUTEINFOA sei = {0};
        sei.cbSize = sizeof(sei);
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = "runas";  // Run as administrator
        sei.lpFile = "cmd.exe";
        std::string cmdArgs = "/c \"" + updateScript + "\"";
        sei.lpParameters = cmdArgs.c_str();
        sei.nShow = SW_HIDE;

        if (!ShellExecuteExA(&sei))
        {
            DWORD error = GetLastError();
            if (error == ERROR_CANCELLED)
            {
                log("User cancelled UAC elevation");
            }
            else
            {
                log("Failed to execute update script, error: " + std::to_string(error));
            }
            return false;
        }

        log("Update script launched. Service will restart.");

        // Give the script time to start
        Sleep(2000);

        // Exit so the script can replace us
        ExitProcess(0);

        return true;
    }
    catch (const std::exception& e)
    {
        log("Update failed: " + std::string(e.what()));

        // Attempt rollback
        log("Attempting rollback...");
        try
        {
            if (fs::exists(backupDir + "\\install"))
            {
                fs::copy(backupDir + "\\install", installDir,
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

#endif // PLATFORM_WINDOWS
