# ScreenControl Build Setup

**Current Version**: 2.0.4

This document describes the build infrastructure for ScreenControl across all platforms.

## Quick Start - Full Deployment

The recommended way to build and deploy is using `deploy.sh`:

```bash
# Full deployment: build all platforms + upload to server
./deploy.sh --all-platforms --upload

# Build and deploy web changes only
./deploy.sh --web-only

# Build and upload macOS + Windows (without rebuilding web)
./deploy.sh --builds-only --all-platforms --upload

# Upload existing builds without rebuilding
./deploy.sh --upload-only
```

### deploy.sh Options

| Option | Description |
|--------|-------------|
| `--web-only` | Only build and deploy web application |
| `--builds-only` | Only build agents (skip web) |
| `--windows` | Include Windows MSI build |
| `--all-platforms` | Build all platforms (macOS + Windows) |
| `--upload` | Upload builds to server via API |
| `--upload-only` | Only upload existing builds (skip build) |
| `--skip-tests` | Skip running tests |
| `--dry-run` | Show what would be done |
| `bump <version>` | Bump all version files |

### Example Workflows

```bash
# 1. Release new version
./deploy.sh bump 2.0.5
./deploy.sh --all-platforms --upload

# 2. Hotfix web only
./deploy.sh --web-only

# 3. Rebuild Windows and re-upload
./deploy.sh --builds-only --windows --upload

# 4. Test build without deploying
./deploy.sh --builds-only --all-platforms --dry-run
```

---

## Manual Build Commands

### macOS
```bash
cd macos
xcodebuild -scheme ScreenControl -configuration Release
```

### Linux
```bash
cd service && mkdir -p build && cd build
cmake .. && make -j$(nproc)
```

### Windows (from Mac)
```bash
cd windows-build-package
./build-windows.sh          # Uses version from version.json
./build-windows.sh 2.0.5    # Or specify version explicitly
```

---

## Windows Build Pipeline

The Windows build uses a hybrid approach optimized for building from an Apple Silicon Mac:

```
┌─────────────────────────────────────────────────────────────┐
│                     Mac M2 (local)                          │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ mingw-w64       │    │ .NET SDK 8                      │ │
│  │ (Homebrew)      │    │ (cross-compile to win-x64)      │ │
│  │                 │    │                                 │ │
│  │ C++ Service     │    │ C# Tray App                     │ │
│  │ → 18 MB .exe    │    │ → 155 MB .exe                   │ │
│  └────────┬────────┘    └───────────────┬─────────────────┘ │
│           │                              │                   │
│           └──────────┬──────────────────┘                   │
│                      ▼                                       │
│              ┌───────────────┐                               │
│              │    dist/      │                               │
│              │ Service.exe   │                               │
│              │ Tray.exe      │                               │
│              └───────┬───────┘                               │
└──────────────────────┼──────────────────────────────────────┘
                       │ rsync over SSH
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              x86 Docker Host (192.168.10.31)                │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  wixl-builder container                                 ││
│  │  (Fedora 39 + msitools)                                 ││
│  │                                                         ││
│  │  wixl Product-wixl.wxs → MSI                            ││
│  │  → 72 MB installer                                      ││
│  │                                                         ││
│  │  msiinfo → smoke tests (verify version, files)          ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                       │ scp
                       ▼
              ┌───────────────┐
              │ ScreenControl │
              │ -2.0.4-x64.msi│
              └───────────────┘
```

### Why This Architecture?

1. **C++ cross-compilation works natively** - mingw-w64 on Mac produces Windows binaries without emulation
2. **\.NET cross-compilation works natively** - `dotnet publish -r win-x64` works on any platform
3. **MSI packaging needs x86** - wixl/msitools works best on native x86 Linux, avoiding ARM emulation overhead
4. **Avoids Wine complexity** - Real WiX under Wine has file access and .NET runtime issues

### Prerequisites

**On Mac:**
```bash
# Install mingw-w64 for C++ cross-compilation
brew install mingw-w64

# Install .NET SDK (8.0+)
brew install dotnet

# Verify
x86_64-w64-mingw32-gcc --version
dotnet --version
```

**On x86 Docker Host (192.168.10.31):**
```bash
# Build the wixl-builder image (one-time setup)
docker build -t wixl-builder:latest -f - . << 'EOF'
FROM fedora:39
RUN dnf install -y msitools && dnf clean all
WORKDIR /build
EOF
```

### Build Script Features

The `build-windows.sh` script:
1. Reads version from `version.json` (or accepts as argument)
2. Compiles C++ service with mingw-w64
3. Compiles .NET tray app with full version metadata (FileVersion, AssemblyVersion)
4. Syncs files to x86 server via rsync
5. Builds MSI with wixl (version passed as `-D Version=X.Y.Z.0`)
6. Runs smoke tests (size check, msiinfo property/file verification)
7. Logs everything to `installer/output/build-X.Y.Z.log`

### Manual Build Commands

```bash
# 1. Build C++ service
cd service
rm -rf build-windows && mkdir build-windows && cd build-windows
cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/mingw-w64.cmake -DCMAKE_BUILD_TYPE=Release
make -j$(sysctl -n hw.ncpu)

# 2. Build .NET tray app (with version metadata)
cd windows/ScreenControlTray
dotnet publish -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true \
  -p:Version=2.0.4 \
  -p:AssemblyVersion=2.0.4.0 \
  -p:FileVersion=2.0.4.0 \
  -p:InformationalVersion=2.0.4

# 3. Collect binaries
cd windows-build-package
mkdir -p dist
cp ../service/build-windows/bin/ScreenControlService.exe dist/
cp ../windows/ScreenControlTray/bin/Release/net8.0-windows/win-x64/publish/ScreenControlTray.exe dist/

# 4. Sync to x86 server
rsync -az . richardbrown@192.168.10.31:/tmp/screencontrol-build/

# 5. Build MSI on x86 (with parameterized version)
ssh richardbrown@192.168.10.31 "cd /tmp/screencontrol-build && \
  docker run --rm -v /tmp/screencontrol-build:/build -w /build/installer \
  wixl-builder:latest wixl -v -D DistDir=/build/dist -D Version=2.0.4.0 \
  -o /build/installer/output/ScreenControl-2.0.4-x64.msi Product-wixl.wxs"

# 6. Copy MSI back
scp richardbrown@192.168.10.31:/tmp/screencontrol-build/installer/output/*.msi installer/output/
```

### MSI Contents

The generated MSI installs:

| Component | Location |
|-----------|----------|
| ScreenControlService.exe | C:\Program Files\ScreenControl\ |
| ScreenControlTray.exe | C:\Program Files\ScreenControl\ |
| Config folder | C:\ProgramData\ScreenControl\ |
| Logs folder | C:\ProgramData\ScreenControl\Logs\ |
| Start Menu shortcut | Start Menu\Programs\ScreenControl\ |
| Auto-start shortcut | Startup folder |

**Service behavior:**
- Name: `ScreenControlService`
- Account: LocalSystem
- Start: Automatic

### MSI Upgrade Behavior

The installer uses **major upgrade** semantics:
- `UpgradeCode`: Fixed (never changes) - identifies the product line
- `ProductCode` (`Product/@Id="*"`): Generated fresh each build
- `Version`: Bumped each release (passed via `-D Version=X.Y.Z.0`)

This ensures:
- Installing 2.0.5 over 2.0.4 cleanly removes the old version first
- Downgrades are blocked with a user-friendly error
- No side-by-side installs (only one version at a time)

**Component GUIDs are stable** - they only change if the component's identity changes.

### wixl Limitations

The wixl build (msitools) supports core MSI features but lacks some WiX-specific features:

| Feature | wixl | Full WiX |
|---------|------|----------|
| Service install/control | ✅ | ✅ |
| Registry entries | ✅ | ✅ |
| Shortcuts | ✅ | ✅ |
| Directory creation | ✅ | ✅ |
| Major upgrade handling | ✅ | ✅ |
| Custom actions | ❌ | ✅ |
| Conditions | ❌ | ✅ |
| WixUI dialogs | ❌ | ✅ |

**Impact:** Users may need to manually restart the tray app after an upgrade (the service restarts automatically).

For full WiX support, use a Windows CI runner (GitHub Actions windows-latest).

---

## Version Management

### Version Files

When releasing, update ALL these files:

| File | Line | Format |
|------|------|--------|
| `version.json` | 2 | `"version": "X.Y.Z"` |
| `service/CMakeLists.txt` | 2 | `VERSION X.Y.Z` |
| `windows/ScreenControlTray/ScreenControlTray.csproj` | 12 | `<Version>X.Y.Z</Version>` |

**Note:** WXS files now use `$(var.Version)` - version is passed at build time via `-D Version=X.Y.Z.0`

### Automated Version Update

```bash
./deploy.sh bump 2.0.5
```

This updates all version files, shows a diff, and optionally commits.

### Version Flow

```
version.json (source of truth)
    ↓
build-windows.sh reads version
    ↓
├── CMakeLists.txt (PROJECT_VERSION) → C++ SERVICE_VERSION
├── dotnet publish -p:Version=... → Tray FileVersion/AssemblyVersion
└── wixl -D Version=... → MSI ProductVersion
```

---

## Infrastructure

### Servers

| Server | IP | Purpose |
|--------|-----|---------|
| Web Dashboard | 192.168.10.10 | Next.js app (PM2) |
| Database | 192.168.10.15 | PostgreSQL |
| x86 Docker Host | 192.168.10.31 | Windows MSI builds |

### Docker Images

| Image | Host | Purpose |
|-------|------|---------|
| `wixl-builder:latest` | 192.168.10.31 | Fedora + msitools for MSI packaging |

---

## Troubleshooting

### mingw-w64 build fails
```bash
# Check compiler is installed
brew reinstall mingw-w64
which x86_64-w64-mingw32-gcc
```

### .NET publish fails
```bash
# Update .NET SDK
brew upgrade dotnet
dotnet --list-sdks
```

### SSH to x86 host fails
```bash
# Test connection
ssh richardbrown@192.168.10.31 "docker --version"
```

### wixl-builder image missing
```bash
# Rebuild on x86 host
ssh richardbrown@192.168.10.31 "docker build -t wixl-builder:latest -f - . << 'EOF'
FROM fedora:39
RUN dnf install -y msitools && dnf clean all
WORKDIR /build
EOF"
```

### Version mismatch in MSI
```bash
# Verify version in built MSI
ssh richardbrown@192.168.10.31 "docker run --rm -v /tmp/screencontrol-build:/build \
  wixl-builder:latest msiinfo export '/build/installer/output/ScreenControl-2.0.4-x64.msi' Property \
  | grep ProductVersion"
```

### Build log location
```bash
cat windows-build-package/installer/output/build-2.0.4.log
```

---

## Update System & Downloads

### Update API Endpoints

The web dashboard provides an update API for agents:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/updates/upload` | POST | Upload new builds (multipart form) |
| `/api/updates/check` | GET | Check for available updates |
| `/api/updates/download/:platform/:arch/:version` | GET | Download build |
| `/api/updates/versions` | GET | List available versions |

### Upload Builds via API

The `deploy.sh --upload` command uses the upload API:

```bash
# Manual upload example
curl -X POST \
  -F "version=2.0.4" \
  -F "platform=windows" \
  -F "arch=x64" \
  -F "channel=STABLE" \
  -F "releaseNotes=v2.0.4: Bug fixes" \
  -F "file=@dist/ScreenControl-2.0.4-windows-x64.msi" \
  https://screencontrol.knws.co.uk/api/updates/upload
```

### Downloads Dashboard

Users can download agents from: https://screencontrol.knws.co.uk/dashboard/downloads

This page shows:
- Latest version for each platform (Windows, macOS, Linux)
- Version history with release notes
- Direct download links
- File sizes and SHA256 checksums

### Build Storage

Builds are stored on the web server at:
```
/var/www/html/screencontrol/builds/
├── windows-x64/
│   └── ScreenControl-2.0.4-windows-x64.msi
├── macos-arm64/
│   └── ScreenControl-2.0.4-macos-arm64.tar.gz
└── linux-x64/
    └── ScreenControl-2.0.4-linux-x64.tar.gz
```

### Agent Auto-Update Flow

1. Agent sends heartbeat with current version
2. Server checks for newer version in database
3. If update available, returns download URL
4. Agent downloads to temp folder
5. Agent verifies SHA256 checksum
6. Agent extracts and installs update
7. Service restarts with new version

---

## Code Signing (Windows)

Windows MSI installers are code signed to avoid SmartScreen warnings.

### Certificate Configuration

The build script looks for certificates in this order:
1. `CODESIGN_PFX` environment variable (for production)
2. `windows-build-package/certs/screencontrol-test.pfx` (self-signed, for testing)

### Using a Production Certificate

```bash
# Set environment variables for your purchased certificate
export CODESIGN_PFX="/path/to/your/certificate.pfx"
export CODESIGN_PASS="your-certificate-password"

# Build with signing
./windows-build-package/build-windows.sh
```

### Self-Signed Certificate (Testing)

A self-signed certificate is included for testing. It will sign the MSI but **will not** prevent SmartScreen warnings (Windows doesn't trust self-signed certs).

To regenerate the test certificate:
```bash
cd windows-build-package/certs
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=ScreenControl Test/O=Key Network Services Ltd/C=GB"
openssl pkcs12 -export -out screencontrol-test.pfx -inkey key.pem -in cert.pem -passout pass:testpass123
```

### Recommended Certificate Providers

| Provider | Type | Price | SmartScreen |
|----------|------|-------|-------------|
| Sectigo/Comodo | Standard | ~$100/year | Builds reputation |
| SSL.com | Standard | ~$140/year | Builds reputation |
| DigiCert | EV | ~$500/year | Immediate trust |

### Disabling Code Signing

```bash
CODESIGN_ENABLED=false ./windows-build-package/build-windows.sh
```
