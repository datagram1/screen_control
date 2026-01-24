# ScreenControl - Project Context for Claude

## What is ScreenControl?

ScreenControl is a remote desktop management system with:
- **C++ Service** (`service/`) - Cross-platform agent that runs on managed machines
- **C# Tray App** (`windows/ScreenControlTray/`) - Windows system tray UI
- **macOS App** (`macos/`) - Native macOS menu bar app
- **Web Dashboard** (`web/`) - Next.js admin interface
- **Chrome Extension** (`extension/`) - Browser integration

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Web Dashboard                            │
│                 (Next.js @ 192.168.10.10)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Managed Machines                          │
│                                                             │
│  Windows:              macOS:              Linux:           │
│  ├── ScreenControl     └── ScreenControl   └── ScreenControl│
│  │   Service.exe          .app (menu bar)     Service       │
│  └── ScreenControl                            (headless)    │
│      Tray.exe                                               │
└─────────────────────────────────────────────────────────────┘
```

## Key Directories

| Directory | Contents |
|-----------|----------|
| `service/` | C++ cross-platform agent (CMake) |
| `service/src/control_server/` | WebSocket client, command handling |
| `service/src/update/` | Auto-update system |
| `service/src/platform/windows/` | Windows-specific code |
| `service/src/platform/macos/` | macOS-specific code |
| `service/src/platform/linux/` | Linux-specific code |
| `libscreencontrol/` | Shared C library for screen capture/input |
| `windows/ScreenControlTray/` | C# Windows tray app (.NET 8) |
| `windows-build-package/` | Windows MSI build scripts |
| `macos/` | Xcode project for macOS app |
| `web/` | Next.js dashboard |

## Building & Deploying

See `setup.md` for detailed build instructions.

### Full Automated Deployment

```bash
# Full deploy with all platforms + upload to server
./deploy.sh --all-platforms --upload

# Build macOS only + upload
./deploy.sh --upload

# Build Windows only (from Mac via Docker)
./deploy.sh --builds-only --windows

# Build Linux only (via Docker Desktop)
./deploy.sh --builds-only --linux --upload

# Build macOS + Linux (skip Windows)
./deploy.sh --linux --upload

# Upload existing builds without rebuilding
./deploy.sh --upload-only

# Bump version and deploy
./deploy.sh bump 2.0.5
./deploy.sh --all-platforms --upload
```

### Manual Build Commands

```bash
# Windows MSI (from Mac via Docker)
cd windows-build-package && ./build-windows.sh 2.0.5
# Output: installer/output/ScreenControl-2.0.5-x64.msi

# macOS
cd macos && xcodebuild -scheme ScreenControl -configuration Release

# Linux service (via Docker - builds x64 and arm64)
./build-linux.sh both
# Output: dist/ScreenControl-2.0.5-linux-x64.tar.gz
#         dist/ScreenControl-2.0.5-linux-arm64.tar.gz

# Linux service (native build - current architecture only)
cd service && mkdir build && cd build && cmake .. && make -j$(nproc)
```

## Version Management

**Source of truth:** `version.json`

**Files to update when releasing** (use `./deploy.sh bump X.Y.Z`):
- `version.json`
- `service/CMakeLists.txt` (line 2)
- `windows/ScreenControlTray/ScreenControlTray.csproj` (line 12)
- `macos/ScreenControl/Info.plist` (CFBundleShortVersionString, CFBundleVersion)

WXS files use `$(var.Version)` - version passed at build time.

## Windows Build Pipeline

The Windows build uses a hybrid approach from Mac:
1. **C++ Service** - Cross-compiled with mingw-w64 (Homebrew)
2. **.NET Tray App** - Cross-compiled with `dotnet publish -r win-x64`
3. **MSI Packaging** - Built on remote x86 Docker host (192.168.10.31) using wixl/msitools

See `setup.md` for full pipeline documentation.

## Linux Build Pipeline

Linux builds use Docker Desktop on Mac to cross-compile for both x64 and arm64:

1. **Docker multi-platform** - Uses `--platform linux/amd64` and `linux/arm64`
2. **Debian bookworm** - Base image with build-essential, cmake, libcurl, libssl
3. **libscreencontrol** - Built first (with `-DSC_BUILD_TESTS=OFF` for headless)
4. **Service binary** - Extracted and packaged as tar.gz

```bash
# Build both architectures
./build-linux.sh both

# Build single architecture
./build-linux.sh x64
./build-linux.sh arm64
```

**Requirements:** Docker Desktop running with multi-platform support enabled.

## Infrastructure

| Server | IP | Purpose |
|--------|-----|---------|
| Web Dashboard | 192.168.10.10 | Next.js (PM2) |
| Database | 192.168.10.15 | PostgreSQL |
| x86 Docker Host | 192.168.10.31 | Windows MSI builds |

## Configuration Files

- **Agent config:** `C:\ProgramData\ScreenControl\config.json` (Windows)
- **Agent logs:** `C:\ProgramData\ScreenControl\Logs\` (Windows)
- **Web config:** `web/.env`

## Key Technical Details

### MSI Upgrade Behavior
- `UpgradeCode`: Fixed - identifies product line
- `ProductCode`: Generated fresh each build (`Id="*"`)
- Major upgrade semantics (new version removes old)
- Component GUIDs are stable

### Auto-Update System
- Heartbeat-based checking (~5 minute intervals)
- Downloads to temp folder
- SHA256 verification
- Batch script for service restart

**Update API Endpoints:**
- `POST /api/updates/upload` - Upload new builds (via deploy.sh --upload)
- `GET /api/updates/check?platform=&arch=&currentVersion=` - Check for updates
- `GET /api/updates/download/:platform/:arch/:version` - Download build
- `GET /api/updates/versions` - List available versions

**Downloads Dashboard:**
- URL: https://screencontrol.knws.co.uk/dashboard/downloads
- Shows all available platforms (Windows, macOS, Linux)
- Version history with release notes

### Cross-Compilation Notes
- mingw-w64 WinHTTP API uses wide strings only (wchar_t)
- Use `std::min` not `min` (no Windows.h macros)
- Add `#include <algorithm>` for STL algorithms

## Common Tasks

### Build Windows MSI
```bash
cd windows-build-package
./build-windows.sh 2.0.5
# Output: installer/output/ScreenControl-2.0.5-x64.msi
```

### Build Linux (Docker)
```bash
# Requires Docker Desktop running
./build-linux.sh both
# Output: dist/ScreenControl-2.0.5-linux-x64.tar.gz
#         dist/ScreenControl-2.0.5-linux-arm64.tar.gz
```

### Bump Version
```bash
./deploy.sh bump 2.0.5
```

### Check MSI Contents
```bash
ssh richardbrown@192.168.10.31 "docker run --rm -v /tmp/screencontrol-build:/build \
  wixl-builder:latest msiinfo export '/build/installer/output/ScreenControl-2.0.4-x64.msi' Property"
```

### Deploy Web Changes
```bash
git push
ssh richardbrown@192.168.10.10 "cd /var/www/html/screencontrol/web && git pull && npm run build && pm2 restart screencontrol-web"
```

## Testing

- **Test User:** richard.brown@knws.co.uk
- **Debug API:** https://screencontrol.knws.co.uk/api/debug/tools
- See `docs/windows-setup.md` for test machine details

## Code Style

- C++: Modern C++ (C++17), no raw pointers where avoidable
- C#: Standard .NET conventions
- TypeScript: Next.js App Router patterns
