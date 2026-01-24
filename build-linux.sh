#!/bin/bash
#
# Build ScreenControl Service for Linux using Docker
#
# Usage: ./build-linux.sh [x64|arm64|both]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(cat "$SCRIPT_DIR/version.json" 2>/dev/null | jq -r '.version' || echo "2.0.5")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse args
ARCH="${1:-both}"

# Create Dockerfile inline
create_dockerfile() {
    cat << 'EOF'
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    git \
    libcurl4-openssl-dev \
    libssl-dev \
    pkg-config \
    libzstd-dev \
    libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
EOF
}

build_for_arch() {
    local arch=$1
    local platform=""

    if [ "$arch" = "x64" ]; then
        platform="linux/amd64"
    elif [ "$arch" = "arm64" ]; then
        platform="linux/arm64"
    else
        log_error "Unknown arch: $arch"
        return 1
    fi

    log_info "Building for Linux $arch (platform: $platform)..."

    # Create temp build context
    local BUILD_DIR=$(mktemp -d)
    trap "rm -rf $BUILD_DIR" EXIT

    # Copy source files (excluding build directories)
    log_info "Preparing build context..."
    rsync -a --exclude='build*' --exclude='.git' "$SCRIPT_DIR/service/" "$BUILD_DIR/service/"
    rsync -a --exclude='build*' --exclude='.git' "$SCRIPT_DIR/libscreencontrol/" "$BUILD_DIR/libscreencontrol/"

    # Create Dockerfile
    cat > "$BUILD_DIR/Dockerfile" << 'DOCKERFILE'
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    git \
    libcurl4-openssl-dev \
    libssl-dev \
    pkg-config \
    libzstd-dev \
    libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy source
COPY service /build/service
COPY libscreencontrol /build/libscreencontrol

# Build libscreencontrol first (without tests - no X11/Pipewire available)
WORKDIR /build/libscreencontrol
RUN mkdir -p build && cd build && \
    cmake .. -DCMAKE_BUILD_TYPE=Release -DSC_BUILD_TESTS=OFF && \
    make -j$(nproc)

# Build service
WORKDIR /build/service
RUN mkdir -p build && cd build && \
    cmake .. -DCMAKE_BUILD_TYPE=Release && \
    make -j$(nproc)

# Output
CMD ["cp", "/build/service/build/bin/ScreenControlService", "/output/"]
DOCKERFILE

    # Build image
    local IMAGE_NAME="screencontrol-linux-builder-$arch"
    log_info "Building Docker image for $arch..."

    docker build --platform "$platform" -t "$IMAGE_NAME" "$BUILD_DIR"

    # Extract binary
    local OUTPUT_DIR="$SCRIPT_DIR/dist/linux-$arch"
    mkdir -p "$OUTPUT_DIR"

    log_info "Extracting binary..."
    docker run --rm --platform "$platform" \
        -v "$OUTPUT_DIR:/output" \
        "$IMAGE_NAME"

    # Verify
    if [ -f "$OUTPUT_DIR/ScreenControlService" ]; then
        local SIZE=$(ls -lh "$OUTPUT_DIR/ScreenControlService" | awk '{print $5}')
        log_success "Built: $OUTPUT_DIR/ScreenControlService ($SIZE)"

        # Package
        log_info "Packaging..."
        mkdir -p "$SCRIPT_DIR/dist/screencontrol"
        cp "$OUTPUT_DIR/ScreenControlService" "$SCRIPT_DIR/dist/screencontrol/"
        cd "$SCRIPT_DIR/dist"
        tar -czvf "ScreenControl-$VERSION-linux-$arch.tar.gz" screencontrol/ScreenControlService
        rm -rf screencontrol

        local PKG_SIZE=$(ls -lh "ScreenControl-$VERSION-linux-$arch.tar.gz" | awk '{print $5}')
        log_success "Package: ScreenControl-$VERSION-linux-$arch.tar.gz ($PKG_SIZE)"
    else
        log_error "Build failed - binary not found"
        return 1
    fi
}

# Main
echo -e "\n${BLUE}ScreenControl Linux Build v${VERSION}${NC}\n"

case "$ARCH" in
    x64)
        build_for_arch x64
        ;;
    arm64)
        build_for_arch arm64
        ;;
    both)
        build_for_arch x64
        build_for_arch arm64
        ;;
    *)
        echo "Usage: $0 [x64|arm64|both]"
        exit 1
        ;;
esac

log_success "Linux build complete!"
