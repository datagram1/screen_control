/**
 * Shell Tools Implementation
 *
 * Cross-platform command execution with security hardening.
 */

#include "shell_tools.h"
#include "../core/logger.h"
#include "security.h"
#include <map>
#include <mutex>
#include <random>
#include <algorithm>
#include <regex>

#if PLATFORM_WINDOWS
    #include <windows.h>
    #include <process.h>
#else
    #include <unistd.h>
    #include <sys/wait.h>
    #include <sys/select.h>
    #include <sys/ioctl.h>
    #include <signal.h>
    #include <fcntl.h>
    #include <cstring>
    #include <cerrno>
    #include <termios.h>
    #if defined(__APPLE__)
        #include <util.h>
    #else
        #include <pty.h>
    #endif
#endif

using json = nlohmann::json;

namespace ScreenControl
{

// Use centralized security module for command filtering
namespace CommandSecurity
{
    bool isBlocked(const std::string& command)
    {
        auto& filter = security::CommandFilter::getInstance();
        auto result = filter.checkCommand(command);
        if (!result.allowed)
        {
            security::SecurityLogger::getInstance().logBlockedCommand(command, result.reason);
            return true;
        }
        return false;
    }

    bool detectsExfiltration(const std::string& command)
    {
        // This is now handled by checkCommand() which includes exfiltration detection
        // Keep this function for API compatibility but it's redundant
        return false;
    }
}

// Session management
#if PLATFORM_WINDOWS
struct ShellSession
{
    HANDLE processHandle;
    HANDLE stdinWrite;
    HANDLE stdoutRead;
    HANDLE stderrRead;
    DWORD pid;
};
#else
struct ShellSession
{
    pid_t pid;
    int stdinFd;
    int stdoutFd;
    int stderrFd;
    int ptyMasterFd;  // PTY master fd (if using PTY)
    bool isPty;       // true if this is a PTY session
};
#endif

static std::map<std::string, ShellSession> g_sessions;
static std::mutex g_sessionMutex;

static std::string generateSessionId()
{
    static std::random_device rd;
    static std::mt19937 gen(rd());
    static std::uniform_int_distribution<> dis(0, 15);

    const char* hex = "0123456789abcdef";
    std::string id = "session_";
    for (int i = 0; i < 16; ++i)
    {
        id += hex[dis(gen)];
    }
    return id;
}

#if !PLATFORM_WINDOWS
static void setNonBlocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
#endif

json ShellTools::exec(const std::string& command, const std::string& cwd, int timeout)
{
    // Security check
    if (CommandSecurity::isBlocked(command))
    {
        return {{"success", false}, {"error", "Command blocked by security policy"}};
    }
    if (CommandSecurity::detectsExfiltration(command))
    {
        return {{"success", false}, {"error", "Command blocked: potential data exfiltration"}};
    }

#if PLATFORM_WINDOWS
    // Windows implementation using CreateProcess
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = NULL;

    HANDLE stdoutRead, stdoutWrite;
    HANDLE stderrRead, stderrWrite;

    if (!CreatePipe(&stdoutRead, &stdoutWrite, &sa, 0) ||
        !CreatePipe(&stderrRead, &stderrWrite, &sa, 0))
    {
        return {{"success", false}, {"error", "Failed to create pipes"}};
    }

    SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.hStdError = stderrWrite;
    si.hStdOutput = stdoutWrite;
    si.hStdInput = NULL;
    si.dwFlags |= STARTF_USESTDHANDLES;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    std::string cmdLine = "cmd.exe /c " + command;
    const char* cwdPtr = cwd.empty() ? nullptr : cwd.c_str();

    if (!CreateProcessA(NULL, const_cast<char*>(cmdLine.c_str()),
                        NULL, NULL, TRUE, 0, NULL, cwdPtr, &si, &pi))
    {
        CloseHandle(stdoutRead);
        CloseHandle(stdoutWrite);
        CloseHandle(stderrRead);
        CloseHandle(stderrWrite);
        return {{"success", false}, {"error", "Failed to create process"}};
    }

    CloseHandle(stdoutWrite);
    CloseHandle(stderrWrite);

    std::string stdoutStr, stderrStr;
    char buffer[4096];
    DWORD bytesRead;

    // Wait with timeout
    DWORD waitResult = WaitForSingleObject(pi.hProcess, timeout * 1000);

    if (waitResult == WAIT_TIMEOUT)
    {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        CloseHandle(stdoutRead);
        CloseHandle(stderrRead);
        return {
            {"success", false},
            {"error", "Command timed out"},
            {"timeout", timeout}
        };
    }

    // Read output
    while (ReadFile(stdoutRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL) && bytesRead > 0)
    {
        buffer[bytesRead] = '\0';
        stdoutStr += buffer;
    }
    while (ReadFile(stderrRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL) && bytesRead > 0)
    {
        buffer[bytesRead] = '\0';
        stderrStr += buffer;
    }

    DWORD exitCode;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(stdoutRead);
    CloseHandle(stderrRead);

    return {
        {"success", true},
        {"stdout", stdoutStr},
        {"stderr", stderrStr},
        {"exit_code", static_cast<int>(exitCode)},
        {"command", command}
    };

#else
    // POSIX implementation using fork/exec
    int stdoutPipe[2];
    int stderrPipe[2];

    if (pipe(stdoutPipe) < 0 || pipe(stderrPipe) < 0)
    {
        return {{"success", false}, {"error", "Failed to create pipes"}};
    }

    pid_t pid = fork();

    if (pid < 0)
    {
        close(stdoutPipe[0]); close(stdoutPipe[1]);
        close(stderrPipe[0]); close(stderrPipe[1]);
        return {{"success", false}, {"error", "Failed to fork"}};
    }

    if (pid == 0)
    {
        // Child process
        close(stdoutPipe[0]);
        close(stderrPipe[0]);

        dup2(stdoutPipe[1], STDOUT_FILENO);
        dup2(stderrPipe[1], STDERR_FILENO);

        close(stdoutPipe[1]);
        close(stderrPipe[1]);

        if (!cwd.empty())
        {
            if (chdir(cwd.c_str()) != 0)
            {
                _exit(1);
            }
        }

        execl("/bin/sh", "sh", "-c", command.c_str(), nullptr);
        _exit(127);
    }

    // Parent process
    close(stdoutPipe[1]);
    close(stderrPipe[1]);

    setNonBlocking(stdoutPipe[0]);
    setNonBlocking(stderrPipe[0]);

    std::string stdoutStr;
    std::string stderrStr;
    char buffer[4096];

    int elapsed = 0;
    int status = 0;
    bool timedOut = false;

    while (elapsed < timeout * 1000)
    {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(stdoutPipe[0], &readfds);
        FD_SET(stderrPipe[0], &readfds);

        int maxfd = std::max(stdoutPipe[0], stderrPipe[0]) + 1;

        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 100000;  // 100ms

        int ready = select(maxfd, &readfds, nullptr, nullptr, &tv);

        if (ready > 0)
        {
            if (FD_ISSET(stdoutPipe[0], &readfds))
            {
                ssize_t n = read(stdoutPipe[0], buffer, sizeof(buffer) - 1);
                if (n > 0)
                {
                    buffer[n] = '\0';
                    stdoutStr += buffer;
                }
            }
            if (FD_ISSET(stderrPipe[0], &readfds))
            {
                ssize_t n = read(stderrPipe[0], buffer, sizeof(buffer) - 1);
                if (n > 0)
                {
                    buffer[n] = '\0';
                    stderrStr += buffer;
                }
            }
        }

        // Check if process has exited
        int waitResult = waitpid(pid, &status, WNOHANG);
        if (waitResult == pid)
        {
            // Read remaining output
            while (true)
            {
                ssize_t n = read(stdoutPipe[0], buffer, sizeof(buffer) - 1);
                if (n <= 0) break;
                buffer[n] = '\0';
                stdoutStr += buffer;
            }
            while (true)
            {
                ssize_t n = read(stderrPipe[0], buffer, sizeof(buffer) - 1);
                if (n <= 0) break;
                buffer[n] = '\0';
                stderrStr += buffer;
            }
            break;
        }

        elapsed += 100;
    }

    if (elapsed >= timeout * 1000)
    {
        timedOut = true;
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
    }

    close(stdoutPipe[0]);
    close(stderrPipe[0]);

    if (timedOut)
    {
        return {
            {"success", false},
            {"error", "Command timed out"},
            {"timeout", timeout},
            {"stdout", stdoutStr},
            {"stderr", stderrStr}
        };
    }

    int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    return {
        {"success", true},
        {"stdout", stdoutStr},
        {"stderr", stderrStr},
        {"exit_code", exitCode},
        {"command", command}
    };
#endif
}

json ShellTools::startSession(const std::string& command, const std::string& cwd)
{
#if PLATFORM_WINDOWS
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = NULL;

    HANDLE stdinRead, stdinWrite;
    HANDLE stdoutRead, stdoutWrite;
    HANDLE stderrRead, stderrWrite;

    if (!CreatePipe(&stdinRead, &stdinWrite, &sa, 0) ||
        !CreatePipe(&stdoutRead, &stdoutWrite, &sa, 0) ||
        !CreatePipe(&stderrRead, &stderrWrite, &sa, 0))
    {
        return {{"success", false}, {"error", "Failed to create pipes"}};
    }

    SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.hStdError = stderrWrite;
    si.hStdOutput = stdoutWrite;
    si.hStdInput = stdinRead;
    si.dwFlags |= STARTF_USESTDHANDLES;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    std::string shell = command.empty() ? "cmd.exe" : command;
    const char* cwdPtr = cwd.empty() ? nullptr : cwd.c_str();

    if (!CreateProcessA(NULL, const_cast<char*>(shell.c_str()),
                        NULL, NULL, TRUE, 0, NULL, cwdPtr, &si, &pi))
    {
        CloseHandle(stdinRead);
        CloseHandle(stdinWrite);
        CloseHandle(stdoutRead);
        CloseHandle(stdoutWrite);
        CloseHandle(stderrRead);
        CloseHandle(stderrWrite);
        return {{"success", false}, {"error", "Failed to create process"}};
    }

    CloseHandle(stdinRead);
    CloseHandle(stdoutWrite);
    CloseHandle(stderrWrite);
    CloseHandle(pi.hThread);

    std::string sessionId = generateSessionId();

    {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        g_sessions[sessionId] = {
            pi.hProcess,
            stdinWrite,
            stdoutRead,
            stderrRead,
            pi.dwProcessId
        };
    }

    return {
        {"success", true},
        {"session_id", sessionId},
        {"pid", static_cast<int>(pi.dwProcessId)}
    };

#else
    // Use PTY for interactive shell sessions
    int masterFd;
    struct winsize ws = {24, 80, 0, 0};  // Default 80x24 terminal

    pid_t pid = forkpty(&masterFd, nullptr, nullptr, &ws);

    if (pid < 0)
    {
        return {{"success", false}, {"error", "Failed to create PTY: " + std::string(strerror(errno))}};
    }

    if (pid == 0)
    {
        // Child process - we're in a new PTY
        if (!cwd.empty())
        {
            if (chdir(cwd.c_str()) != 0)
            {
                // Ignore chdir errors, just stay in current directory
            }
        }

        // Set up environment for interactive shell
        setenv("TERM", "xterm-256color", 1);
        setenv("COLORTERM", "truecolor", 1);

        // Get shell to run - try multiple paths for portability
        std::string shell = command.empty() ? "bash" : command;

        // Helper function to find an executable shell
        auto findShell = [](const std::vector<std::string>& paths) -> const char* {
            for (const auto& path : paths)
            {
                if (access(path.c_str(), X_OK) == 0)
                {
                    return strdup(path.c_str());  // Return accessible path
                }
            }
            return nullptr;
        };

        const char* shellPath = nullptr;

        if (shell == "/bin/bash" || shell == "bash")
        {
            // Try multiple bash locations (ARM Linux often has bash in /usr/bin)
            shellPath = findShell({"/bin/bash", "/usr/bin/bash"});
            if (!shellPath) shellPath = "/bin/bash";  // Fallback for error message
        }
        else if (shell == "/bin/sh" || shell == "sh")
        {
            shellPath = findShell({"/bin/sh", "/usr/bin/sh"});
            if (!shellPath) shellPath = "/bin/sh";
        }
        else if (shell == "/bin/zsh" || shell == "zsh")
        {
            shellPath = findShell({"/bin/zsh", "/usr/bin/zsh"});
            if (!shellPath) shellPath = "/bin/zsh";
        }
        else
        {
            // Use provided path directly
            shellPath = shell.c_str();
        }

        // Run interactive shell (no --norc so we get proper PS1 prompt)
        execl(shellPath, shellPath, "-i", nullptr);

        // If execl fails, try with -l for login shell
        execl(shellPath, shellPath, "-l", nullptr);

        // If both fail, try /bin/sh as last resort
        execl("/bin/sh", "sh", "-i", nullptr);

        _exit(127);
    }

    // Parent process
    setNonBlocking(masterFd);

    std::string sessionId = generateSessionId();

    {
        std::lock_guard<std::mutex> lock(g_sessionMutex);
        g_sessions[sessionId] = {
            pid,
            -1,  // stdinFd not used for PTY
            -1,  // stdoutFd not used for PTY
            -1,  // stderrFd not used for PTY
            masterFd,
            true  // isPty
        };
    }

    return {
        {"success", true},
        {"session_id", sessionId},
        {"pid", static_cast<int>(pid)}
    };
#endif
}

json ShellTools::sendInput(const std::string& sessionId, const std::string& input)
{
    std::lock_guard<std::mutex> lock(g_sessionMutex);

    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end())
    {
        return {{"success", false}, {"error", "Session not found: " + sessionId}};
    }

#if PLATFORM_WINDOWS
    DWORD written;
    if (!WriteFile(it->second.stdinWrite, input.c_str(),
                   static_cast<DWORD>(input.size()), &written, NULL))
    {
        return {{"success", false}, {"error", "Failed to write to session"}};
    }
    return {{"success", true}, {"session_id", sessionId}, {"bytes_written", static_cast<int>(written)}};
#else
    int fd = it->second.isPty ? it->second.ptyMasterFd : it->second.stdinFd;
    ssize_t written = write(fd, input.c_str(), input.size());
    if (written < 0)
    {
        return {{"success", false}, {"error", "Failed to write to session: " + std::string(strerror(errno))}};
    }
    return {{"success", true}, {"session_id", sessionId}, {"bytes_written", static_cast<int>(written)}};
#endif
}

json ShellTools::stopSession(const std::string& sessionId, const std::string& signal)
{
    std::lock_guard<std::mutex> lock(g_sessionMutex);

    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end())
    {
        return {{"success", false}, {"error", "Session not found: " + sessionId}};
    }

#if PLATFORM_WINDOWS
    TerminateProcess(it->second.processHandle, 0);
    WaitForSingleObject(it->second.processHandle, 1000);

    CloseHandle(it->second.processHandle);
    CloseHandle(it->second.stdinWrite);
    CloseHandle(it->second.stdoutRead);
    CloseHandle(it->second.stderrRead);
#else
    int sig = SIGTERM;
    if (signal == "KILL" || signal == "9")
    {
        sig = SIGKILL;
    }
    else if (signal == "INT" || signal == "2")
    {
        sig = SIGINT;
    }
    else if (signal == "HUP" || signal == "1")
    {
        sig = SIGHUP;
    }

    kill(it->second.pid, sig);

    int status;
    waitpid(it->second.pid, &status, WNOHANG);

    if (it->second.isPty)
    {
        close(it->second.ptyMasterFd);
    }
    else
    {
        close(it->second.stdinFd);
        close(it->second.stdoutFd);
        close(it->second.stderrFd);
    }
#endif

    g_sessions.erase(it);

    return {{"success", true}, {"session_id", sessionId}, {"signal", signal}};
}

json ShellTools::readOutput(const std::string& sessionId)
{
    std::lock_guard<std::mutex> lock(g_sessionMutex);

    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end())
    {
        return {{"success", false}, {"error", "Session not found: " + sessionId}};
    }

    std::string stdoutStr, stderrStr;
    char buffer[4096];

#if PLATFORM_WINDOWS
    DWORD available;
    DWORD bytesRead;

    if (PeekNamedPipe(it->second.stdoutRead, NULL, 0, NULL, &available, NULL) && available > 0)
    {
        if (ReadFile(it->second.stdoutRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL))
        {
            buffer[bytesRead] = '\0';
            stdoutStr = buffer;
        }
    }

    if (PeekNamedPipe(it->second.stderrRead, NULL, 0, NULL, &available, NULL) && available > 0)
    {
        if (ReadFile(it->second.stderrRead, buffer, sizeof(buffer) - 1, &bytesRead, NULL))
        {
            buffer[bytesRead] = '\0';
            stderrStr = buffer;
        }
    }
#else
    ssize_t n;
    if (it->second.isPty)
    {
        // PTY combines stdout and stderr into one stream
        while ((n = read(it->second.ptyMasterFd, buffer, sizeof(buffer) - 1)) > 0)
        {
            buffer[n] = '\0';
            stdoutStr += buffer;
        }
    }
    else
    {
        while ((n = read(it->second.stdoutFd, buffer, sizeof(buffer) - 1)) > 0)
        {
            buffer[n] = '\0';
            stdoutStr += buffer;
        }
        while ((n = read(it->second.stderrFd, buffer, sizeof(buffer) - 1)) > 0)
        {
            buffer[n] = '\0';
            stderrStr += buffer;
        }
    }
#endif

    return {
        {"success", true},
        {"session_id", sessionId},
        {"stdout", stdoutStr},
        {"stderr", stderrStr}
    };
}

json ShellTools::listSessions()
{
    std::lock_guard<std::mutex> lock(g_sessionMutex);

    json sessions = json::array();
    for (const auto& pair : g_sessions)
    {
#if PLATFORM_WINDOWS
        sessions.push_back({
            {"session_id", pair.first},
            {"pid", static_cast<int>(pair.second.pid)}
        });
#else
        sessions.push_back({
            {"session_id", pair.first},
            {"pid", static_cast<int>(pair.second.pid)}
        });
#endif
    }

    return {{"success", true}, {"sessions", sessions}, {"count", sessions.size()}};
}

} // namespace ScreenControl
