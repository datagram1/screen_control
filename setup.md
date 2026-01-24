# ScreenControl Build Setup

**Current Version**: 2.0.5

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
| `--windows` | Include Windows MSI build (requires mingw-w64 + remote Docker) |
| `--linux` | Include Linux builds (requires Docker Desktop) |
| `--all-platforms` | Build all platforms (macOS + Windows + Linux) |
| `--upload` | Upload builds to server via API |
| `--upload-only` | Only upload existing builds (skip build) |
| `--skip-tests` | Skip running tests |
| `--dry-run` | Show what would be done |
| `bump <version>` | Bump all version files |

### Example Workflows

```bash
# 1. Release new version (all platforms)
./deploy.sh bump 2.0.5
./deploy.sh --all-platforms --upload

# 2. Hotfix web only
./deploy.sh --web-only

# 3. Rebuild Windows and re-upload
./deploy.sh --builds-only --windows --upload

# 4. Rebuild Linux only (x64 + arm64)
./deploy.sh --builds-only --linux --upload

# 5. Build macOS + Linux (skip Windows)
./deploy.sh --linux --upload

# 6. Test build without deploying
./deploy.sh --builds-only --all-platforms --dry-run
```

---

## Manual Build Commands

### macOS
```bash
cd macos
xcodebuild -scheme ScreenControl -configuration Release
```

### Linux (via Docker - recommended)
```bash
# Build both x64 and arm64
./build-linux.sh both

# Build specific architecture
./build-linux.sh x64
./build-linux.sh arm64

# Output: dist/ScreenControl-2.0.5-linux-{arch}.tar.gz
```

### Linux (native build)
```bash
# Only builds for current architecture
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

## Linux Build Pipeline

Linux builds use Docker Desktop on Mac to cross-compile for both x64 and arm64 architectures.

```
┌─────────────────────────────────────────────────────────────┐
│                     Mac (local)                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Docker Desktop                                         ││
│  │  (multi-platform: linux/amd64, linux/arm64)             ││
│  │                                                         ││
│  │  ┌─────────────────────────────────────────────────┐    ││
│  │  │  Debian bookworm-slim container                 │    ││
│  │  │  + build-essential, cmake, libcurl, libssl      │    ││
│  │  │                                                 │    ││
│  │  │  1. Build libscreencontrol (SC_BUILD_TESTS=OFF) │    ││
│  │  │  2. Build ScreenControlService                  │    ││
│  │  │  3. Extract binary to /output                   │    ││
│  │  └─────────────────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────────────────┘│
│                              │                               │
│                              ▼                               │
│            ┌───────────────────────────────┐                 │
│            │ dist/ScreenControl-2.0.5-     │                 │
│            │   linux-x64.tar.gz  (728K)    │                 │
│            │   linux-arm64.tar.gz (666K)   │                 │
│            └───────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### Prerequisites

**Docker Desktop** must be running with multi-platform support:
```bash
# Verify Docker is running
docker info

# Verify multi-platform support
docker buildx ls
```

### Build Commands

```bash
# Build both architectures (recommended)
./build-linux.sh both

# Build specific architecture
./build-linux.sh x64
./build-linux.sh arm64
```

### What the Build Script Does

1. Creates a temporary build context (excludes existing build directories)
2. Copies `service/` and `libscreencontrol/` source code
3. Creates a Dockerfile inline with all build dependencies
4. Builds Docker image for target platform (`linux/amd64` or `linux/arm64`)
5. Runs container to extract the binary to `dist/linux-{arch}/`
6. Packages as `ScreenControl-VERSION-linux-{arch}.tar.gz` with correct structure

### Package Structure

The tar.gz must have this structure for the auto-update system:
```
ScreenControl-2.0.5-linux-x64.tar.gz
└── screencontrol/
    └── ScreenControlService
```

The update system extracts to a temp directory and copies from `screencontrol/ScreenControlService`.

---

## Version Management

### Version Files

When releasing, update ALL these files (or use `./deploy.sh bump X.Y.Z`):

| File | Line | Format |
|------|------|--------|
| `version.json` | 2 | `"version": "X.Y.Z"` |
| `service/CMakeLists.txt` | 2 | `VERSION X.Y.Z` |
| `windows/ScreenControlTray/ScreenControlTray.csproj` | 12 | `<Version>X.Y.Z</Version>` |
| `macos/ScreenControl/Info.plist` | ~17,19 | `<string>X.Y.Z</string>` (CFBundleShortVersionString, CFBundleVersion) |

**Note:** WXS files use `$(var.Version)` - version is passed at build time via `-D Version=X.Y.Z.0`

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
| `screencontrol-linux-builder-x64` | Local (Docker Desktop) | Debian + build tools for Linux x64 |
| `screencontrol-linux-builder-arm64` | Local (Docker Desktop) | Debian + build tools for Linux arm64 |

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

### Docker not running (Linux builds)
```bash
# Start Docker Desktop (macOS)
open -a Docker

# Wait for Docker to start
docker info
```

### Linux build fails with CMakeCache error
```bash
# This happens when build directories are copied with stale cache
# The build script should exclude build dirs, but if needed:
rm -rf libscreencontrol/build* service/build*
./build-linux.sh both
```

### Linux build fails with test linking errors
```bash
# Tests require X11/Pipewire which aren't available in headless container
# The build script should use -DSC_BUILD_TESTS=OFF
# If manually building, add this flag:
cmake .. -DCMAKE_BUILD_TYPE=Release -DSC_BUILD_TESTS=OFF
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

---

## MCP Integration (AI/LLM Access)

ScreenControl provides MCP (Model Context Protocol) integration allowing AI assistants like Claude Code to control machines remotely.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Claude Code (enterprise.local)                       │
│                                                                             │
│  .mcp.json config:                                                          │
│  ┌───────────────────────┐    ┌───────────────────────────────────────────┐│
│  │ Local stdio MCP       │    │ Remote SSE MCP                            ││
│  │ (screen_control)      │    │ (screencontrol.knws.co.uk)                ││
│  │                       │    │                                           ││
│  │ Controls THIS machine │    │ Proxies to connected agents:              ││
│  │ - screenshot          │    │ - mail__screenshot                        ││
│  │ - click               │    │ - ubuntu__shell_exec                      ││
│  │ - typeText            │    │ - webserver__fs_read                      ││
│  └───────────────────────┘    └───────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ SSE + JSON-RPC
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ScreenControl Web (192.168.10.10)                        │
│                                                                             │
│  /api/mcp/sse - SSE endpoint (connection + events)                          │
│  /api/mcp/messages - JSON-RPC message handler                               │
│                                                                             │
│  AgentRegistry:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Aggregates tools from all connected agents with prefixes:               ││
│  │ - mail__* (39 tools) → Agent: mail.local                                ││
│  │ - ubuntu__* (39 tools) → Agent: ubuntu-server                           ││
│  │ - webserver__* (30 tools) → Agent: web.knws.co.uk                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ WebSocket
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Connected Agents                                    │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                         │
│  │ mail        │  │ ubuntu      │  │ webserver   │                         │
│  │ (macOS)     │  │ (Linux)     │  │ (Linux)     │                         │
│  │ 39 tools    │  │ 39 tools    │  │ 30 tools    │                         │
│  └─────────────┘  └─────────────┘  └─────────────┘                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### MCP Server Types

#### 1. Local stdio MCP Server

The local MCP server runs as a subprocess and controls the machine where Claude Code is running.

**Installation:** The `screen_control` MCP server is built into the ScreenControl macOS app.

**Configuration** (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "screen_control": {
      "command": "/path/to/ScreenControl.app/Contents/MacOS/mcp-server",
      "args": []
    }
  }
}
```

**Available tools:** `screenshot`, `click`, `typeText`, `pressKey`, `listApplications`, `focusApplication`, `shell_exec`, `fs_read`, `fs_write`, etc.

#### 2. Remote SSE MCP Server

The remote SSE MCP server connects to the ScreenControl web dashboard and provides access to all connected agents.

**Configuration** (`.mcp.json` or `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "screencontrol": {
      "url": "https://screencontrol.knws.co.uk/mcp/<connection-id>",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer <access-token>"
      }
    }
  }
}
```

**How to get credentials:**
1. Log in to https://screencontrol.knws.co.uk/dashboard
2. Go to Connections → Create AI Connection
3. Copy the MCP URL and access token

### MCP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/sse` | GET | SSE connection for events (agents list, status) |
| `/api/mcp/messages` | POST | JSON-RPC message handler for tool calls |
| `/mcp/<connection-id>` | GET/POST | Combined endpoint for Claude Code SSE transport |

### Tool Naming Convention

When multiple agents are connected, tools are prefixed with the agent's machine name:

```
<agent-name>__<tool-name>
```

Examples:
- `mail__screenshot` - Take screenshot on mail server
- `ubuntu__shell_exec` - Execute shell command on ubuntu server
- `webserver__fs_read` - Read file on webserver

### Querying Connected Agents

**Via curl:**
```bash
curl -s -X POST "https://screencontrol.knws.co.uk/api/mcp/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  jq '.result.tools | group_by(.agentName) | map({agent: .[0].agentName, tools: length})'
```

**Response:**
```json
[
  {"agent": "mail", "tools": 39},
  {"agent": "ubuntu", "tools": 39},
  {"agent": "webserver", "tools": 30}
]
```

### Multi-Agent Usage in Claude Code

Once configured, Claude Code can access remote agents through the SSE MCP server:

```
User: Take a screenshot of the mail server

Claude: [Calls mail__screenshot tool via screencontrol MCP]
```

The tool call is:
1. Received by the web dashboard MCP endpoint
2. Routed to the correct agent based on the tool prefix
3. Forwarded to the agent via WebSocket
4. Result returned through the same chain

### Current Limitations

1. **Agent must be online** - Tools only appear when agents are connected
2. **Tool discovery** - Claude Code discovers tools at startup; restart needed if agents connect later
3. **No resource aggregation yet** - MCP resources from agents aren't aggregated
4. **SSE transport** - Some MCP clients may not support SSE transport

### Troubleshooting MCP

**Check if MCP server is responding:**
```bash
curl -s -X POST "https://screencontrol.knws.co.uk/api/mcp/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'
```

**List available tools:**
```bash
curl -s -X POST "https://screencontrol.knws.co.uk/api/mcp/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
```

**Check Claude Code MCP status:**
```
/mcp
```

**Restart Claude Code** after changing `.mcp.json` - MCP servers are loaded at startup.
