# ScreenControl Windows Build & Debug Setup

**Current Version**: 2.0.4

## Building the Windows MSI Installer

The build uses a hybrid approach:
- **C++ Service**: Cross-compiled on Mac with mingw-w64
- **Tray App**: Cross-compiled on Mac with .NET SDK
- **MSI Packaging**: Built on remote x86 Docker server (wixl/msitools)

### Prerequisites
- mingw-w64 (`brew install mingw-w64`)
- .NET SDK 8.0+ (`brew install dotnet`)
- SSH access to x86 Docker host (`richardbrown@192.168.10.31`)
- `wixl-builder:latest` Docker image on x86 host

### One-Command Build

```bash
cd /Users/richardbrown/dev/screen_control/windows-build-package
./build-windows.sh 2.0.4
```

This script:
1. Compiles C++ service with mingw-w64
2. Compiles .NET tray app
3. Syncs files to x86 server
4. Builds MSI with wixl on x86 Docker
5. Copies MSI back to local machine

### Manual Build Commands

```bash
# 1. Build the Windows service (from Mac using MinGW cross-compiler)
cd /Users/richardbrown/dev/screen_control/service
mkdir -p build-windows && cd build-windows
cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/mingw-w64.cmake
make -j4

# 2. Build the tray app (from Mac using .NET)
cd /Users/richardbrown/dev/screen_control/windows/ScreenControlTray
dotnet publish -c Release -r win-x64 --self-contained true

# 3. Copy binaries to dist
cd /Users/richardbrown/dev/screen_control/windows-build-package
mkdir -p dist
cp ../service/build-windows/bin/ScreenControlService.exe dist/
cp ../windows/ScreenControlTray/bin/Release/net8.0-windows/win-x64/publish/ScreenControlTray.exe dist/

# 4. Sync to x86 server and build MSI
rsync -az windows-build-package/ richardbrown@192.168.10.31:/tmp/screencontrol-build/
ssh richardbrown@192.168.10.31 "cd /tmp/screencontrol-build && docker run --rm \
  -v /tmp/screencontrol-build:/build -w /build/installer \
  wixl-builder:latest wixl -v -D DistDir=/build/dist \
  -o /build/installer/output/ScreenControl-2.0.4-x64.msi Product-wixl.wxs"
scp richardbrown@192.168.10.31:/tmp/screencontrol-build/installer/output/*.msi installer/output/
```

### wixl vs WiX Feature Comparison

The wixl build (msitools) supports core MSI features but lacks some WiX-specific features:

| Feature | wixl | Full WiX |
|---------|------|----------|
| Service install/control | ✅ | ✅ |
| Registry entries | ✅ | ✅ |
| Shortcuts (Start Menu, Startup) | ✅ | ✅ |
| Directory creation | ✅ | ✅ |
| Major upgrade handling | ✅ | ✅ |
| Custom actions | ❌ | ✅ |
| Conditions (admin, OS version) | ❌ | ✅ |
| WixUI dialogs | ❌ | ✅ |
| Credential provider registration | ❌ | ✅ |

For full WiX support, use a Windows CI runner (GitHub Actions, Azure DevOps).

### Version Updates

When releasing a new version, update ALL these files:
- `version.json` - Central version info
- `service/CMakeLists.txt` - Line 2: `VERSION 2.0.4`
- `windows-build-package/installer/Product.wxs` - Line 24: `Version="2.0.4.0"`
- `windows/ScreenControlTray/ScreenControlTray.csproj` - Line 12: `<Version>2.0.4</Version>`

### What Gets Installed

| Component | Location |
|-----------|----------|
| ScreenControlService.exe | C:\Program Files\ScreenControl\ |
| ScreenControlTray.exe | C:\Program Files\ScreenControl\ |
| ScreenControlCP.dll | C:\Program Files\ScreenControl\ |
| Config folder | C:\ProgramData\ScreenControl\ |
| Logs folder | C:\ProgramData\ScreenControl\Logs\ |
| Start Menu shortcut | Start Menu\Programs\ScreenControl\ |
| Auto-start shortcut | Startup folder |

### Service Details
- Service Name: `ScreenControlService`
- Runs as: LocalSystem
- Starts: Automatically

---

## Debug Account Information

### Production Server
- **Web Dashboard**: https://screencontrol.knws.co.uk
- **Web Server SSH**: ssh richardbrown@192.168.10.10
- **Web Port**: 3001 (PM2)
- **Database Server**: 192.168.10.15 (PostgreSQL)

### Test Account
- **Email**: richard.brown@knws.co.uk
- **User ID**: `cmivqj7nk000054pkib1rkjdb`
- **License**: Enterprise (1000 max concurrent agents)

### Debug API
- **Endpoint**: https://screencontrol.knws.co.uk/api/debug/tools
- **API Key**: `EG+zTIorIcpcW3PT6TnsnLWQPdkiD6sIGWkUPBcTOqU=`

Example curl:
```bash
curl -X POST https://screencontrol.knws.co.uk/api/debug/tools \
  -H "Authorization: Bearer EG+zTIorIcpcW3PT6TnsnLWQPdkiD6sIGWkUPBcTOqU=" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "AGENT_ID_HERE", "tool": "system_info", "params": {}}'
```

### Test Machines

| Name | IP | UUID | Agent ID |
|------|-----|------|----------|
| CAS | 192.168.10.1 | 785336D5-D667-426B-B48D-B6F53A8C4031 | cmkqp6dja006rwokd31if2rxu |

---

## Database Access

```bash
# SSH to database server
ssh richardbrown@192.168.10.15

# Connect to PostgreSQL
psql -U screencontrol -d screencontrol

# Useful queries
# Check user account:
SELECT id, email, name FROM "User" WHERE email = 'richard.brown@knws.co.uk';

# Check license:
SELECT * FROM licenses WHERE "userId" = 'cmivqj7nk000054pkib1rkjdb';

# Check agents:
SELECT id, name, status, "isScreenLocked", "lastHeartbeat"
FROM "Agent" WHERE "userId" = 'cmivqj7nk000054pkib1rkjdb';

# Upgrade license:
UPDATE licenses SET "maxConcurrentAgents" = 1000 WHERE "userId" = 'cmivqj7nk000054pkib1rkjdb';
```

---

## Deploying Web Changes

```bash
# On dev machine - commit and push
git add -A && git commit -m "description" && git push

# SSH to web server
ssh richardbrown@192.168.10.10

# Pull and restart
cd /var/www/html/screencontrol/web
git pull
npm run build
pm2 restart screencontrol-web
```

---

## Credential Provider (ScreenControlCP.dll)

The Credential Provider allows ScreenControl to:
- Store Windows credentials securely
- Unlock the screen remotely via the screencontrol.knws.co.uk dashboard
- Integrate with the Windows lock screen

The MSI installs it to `C:\Program Files\ScreenControl\ScreenControlCP.dll` and registers it in:
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{GUID}`
- `HKCR\CLSID\{GUID}\InprocServer32`

---

## Self-Update Mechanism

The service automatically checks for updates and can self-update without manual intervention.

### How It Works

1. **Heartbeat-Based Checking**: Every ~5 minutes (60 heartbeats × 5s interval), the service checks for updates
2. **Server API**: Uses `GET /api/updates/check?platform=windows&arch=x64&currentVersion=X.X.X`
3. **Automatic Download**: If update available, downloads to temp folder using WinHTTP
4. **Checksum Verification**: Verifies SHA256 using BCrypt API
5. **Installation**: Uses `update_windows.cpp` to:
   - Create backup of current installation
   - Generate update.bat script
   - Stop service and tray app
   - Extract and replace binaries
   - Restart service and tray app

### Update Logs
- Service logs: `C:\ProgramData\ScreenControl\Logs\service.log`
- Update script logs: `%TEMP%\screencontrol_update.log`

### Server-Side Update Management

To deploy a new version:

1. **Upload update package** to server via `/api/updates/upload`
2. **Create version record** in database:
```sql
INSERT INTO "AgentVersion" (id, version, channel, "isActive", "releaseDate", "releaseNotes")
VALUES (gen_random_uuid(), '2.0.4', 'STABLE', true, NOW(), 'Auto-update support');

INSERT INTO "AgentVersionBuild" (id, "versionId", platform, arch, filename, sha256, "fileSize")
VALUES (gen_random_uuid(), '<version_id>', 'WINDOWS', 'x64', 'ScreenControl-2.0.4-windows-x64.zip', '<sha256>', <size>);
```

3. **Gradual Rollout**: Set `rolloutPercent` (0-100) for staged deployment
4. **Force Update**: Set `minVersion` to force agents below that version to update

### Configuration

Update settings in `main_windows.cpp`:
```cpp
updateConfig.autoDownload = true;   // Automatically download updates
updateConfig.autoInstall = true;    // Automatically install updates
updateConfig.checkIntervalHeartbeats = 60;  // Check every ~5 minutes
```
