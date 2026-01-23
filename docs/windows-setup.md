# ScreenControl Windows Build & Debug Setup

## Building the Windows MSI Installer

The MSI is built using Docker with Fedora and msitools (wixl). This works on ARM Mac.

### Prerequisites
- Docker installed and running
- Built Windows binaries in `dist/` directory:
  - `ScreenControlService.exe`
  - `ScreenControlTray.exe`
  - `ScreenControlCP.dll` (Credential Provider - optional)

### Build Commands

```bash
# Navigate to the installer directory
cd /Users/richardbrown/dev/screen_control/windows-build-package/installer

# Build the MSI using Docker
docker run --rm -v "$(pwd):/build" -w /build fedora:39 bash -c "
  dnf install -y msitools &&
  wixl -v -D DistDir=../dist -o ScreenControl-x64.msi Product.wxs
"
```

### Version Updates

Edit `Product.wxs` line 24 to update version:
```xml
Version="1.2.2.0"
```

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

The service checks for updates and uses `update_windows.cpp` to:
1. Download update package
2. Create backup of current installation
3. Generate update.bat script
4. Stop service and tray app
5. Extract and replace binaries
6. Restart service and tray app

Update logs are written to: `%TEMP%\screencontrol_update.log`
