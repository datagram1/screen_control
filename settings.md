# ScreenControl Version Management

## Current Version: 2.0.5

## Version Files

When releasing a new version, update ALL these files:

| File | Line | Format | Example |
|------|------|--------|---------|
| `version.json` | 2 | `"version": "X.Y.Z"` | `"version": "2.0.4"` |
| `service/CMakeLists.txt` | 2 | `VERSION X.Y.Z` | `VERSION 2.0.4` |
| `windows-build-package/installer/Product.wxs` | 24 | `Version="X.Y.Z.0"` | `Version="2.0.4.0"` |
| `windows/ScreenControlTray/ScreenControlTray.csproj` | 12 | `<Version>X.Y.Z</Version>` | `<Version>2.0.4</Version>` |

## How Version Flows

```
version.json (source of truth)
    ↓
CMakeLists.txt (PROJECT_VERSION)
    ↓
SERVICE_VERSION compile definition
    ↓
All C++ code references
```

## Automated Version Update

Use the deploy script to update all version files at once:

```bash
./deploy.sh 2.0.5
```

This will:
1. Update all 4 version files
2. Show git diff for review
3. Optionally commit and push

## Manual Version Update Checklist

- [ ] `version.json` - Update version, patch number, and build date
- [ ] `service/CMakeLists.txt` - Update PROJECT VERSION
- [ ] `windows-build-package/installer/Product.wxs` - Update Product Version (4-part: X.Y.Z.0)
- [ ] `windows/ScreenControlTray/ScreenControlTray.csproj` - Update Version element

## Version in Code

All version references in the service code use `SERVICE_VERSION` macro:

```cpp
// Automatically set from CMakeLists.txt
message["agentVersion"] = SERVICE_VERSION;
info["serviceVersion"] = SERVICE_VERSION;
response["version"] = SERVICE_VERSION;
```

Never hardcode version strings in C++ code - always use `SERVICE_VERSION`.

## Build After Version Update

After updating versions, rebuild:

```bash
# macOS service
cd service && mkdir -p build && cd build
cmake .. && make -j4

# Windows service (cross-compile)
cd service && mkdir -p build-windows && cd build-windows
cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/windows-x64-toolchain.cmake
make -j4

# Windows tray app
cd windows/ScreenControlTray
dotnet publish -c Release -r win-x64

# Windows MSI
cd windows-build-package/installer
docker run --rm -v "$(pwd):/build" -w /build fedora:39 bash -c "
  dnf install -y msitools &&
  wixl -v -D DistDir=../dist -o ScreenControl-x64.msi Product.wxs
"
```
