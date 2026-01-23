/**
 * Screen Streaming Implementation
 *
 * Uses libscreencontrol for efficient screen capture and encoding.
 */

#include "screen_stream.h"
#include "../core/logger.h"
#include <chrono>
#include <sstream>
#include <iomanip>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <algorithm>  // For std::find_if

#ifdef PLATFORM_MACOS
// Use libscreencontrol on macOS
extern "C" {
#include <screencontrol/capture/capture.h>
#include <screencontrol/input/inject.h>
#include <screencontrol/frame/encoder.h>
#include <screencontrol/frame/frame.h>
#include <screencontrol/protocol/protocol.h>
}
#define HAS_LIBSCREENCONTROL 1
#else
#define HAS_LIBSCREENCONTROL 0
#endif

namespace ScreenControl
{

// Stream session state
struct ScreenStream::StreamSession
{
    std::string id;
    StreamConfig config;
    FrameCallback callback;
    std::atomic<bool> running{false};
    std::thread captureThread;
    std::atomic<bool> refreshRequested{false};

#if HAS_LIBSCREENCONTROL
    SCCapture* capture = nullptr;
    SCEncoder* encoder = nullptr;
    SCFrame* prevFrame = nullptr;
#endif

    // Statistics
    std::atomic<uint64_t> framesEncoded{0};
    std::atomic<uint64_t> bytesEncoded{0};
    std::atomic<uint32_t> currentFps{0};
    std::chrono::steady_clock::time_point lastFpsUpdate;
    uint32_t framesSinceLastFps{0};

    ~StreamSession()
    {
        running = false;
        if (captureThread.joinable()) {
            captureThread.join();
        }
#if HAS_LIBSCREENCONTROL
        if (encoder) sc_encoder_free(encoder);
        if (capture) sc_capture_free(capture);
        if (prevFrame) sc_frame_free(prevFrame);
#endif
    }
};

// Platform-specific implementation
class ScreenStream::Impl
{
public:
#if HAS_LIBSCREENCONTROL
    bool available = true;
#else
    bool available = false;
#endif
};

ScreenStream& ScreenStream::getInstance()
{
    static ScreenStream instance;
    return instance;
}

ScreenStream::ScreenStream()
    : m_impl(std::make_unique<Impl>())
{
    Logger::info("ScreenStream initialized");
}

ScreenStream::~ScreenStream()
{
    stopAllStreams();
}

bool ScreenStream::isAvailable() const
{
    return m_impl->available;
}

bool ScreenStream::hasPermission() const
{
#if HAS_LIBSCREENCONTROL
    return sc_capture_has_permission();
#else
    return false;
#endif
}

void ScreenStream::requestPermission()
{
#if HAS_LIBSCREENCONTROL
    sc_capture_request_permission();
#endif
}

std::vector<DisplayInfo> ScreenStream::getDisplays() const
{
    std::vector<DisplayInfo> displays;

#if HAS_LIBSCREENCONTROL
    int count = sc_capture_get_display_count();
    for (int i = 0; i < count; i++) {
        SCDisplayInfo info;
        if (sc_capture_get_display_info(i, &info) == 0) {
            DisplayInfo di;
            di.id = info.display_id;
            di.name = info.name;
            di.width = info.width;
            di.height = info.height;
            di.x = info.x;
            di.y = info.y;
            di.scale = info.scale;
            di.isPrimary = info.is_primary;
            di.isBuiltin = info.is_builtin;
            displays.push_back(di);
        }
    }
#elif defined(PLATFORM_LINUX)
    // Linux: Detect if a graphical session is available
    // Check multiple methods since the service runs as systemd unit without user env vars
    bool hasGraphicalSession = false;
    std::string displayType = "Unknown";

    // Method 1: Check for running display server processes
    FILE* pipe = popen("pgrep -x 'Xorg|Xwayland|gnome-shell|plasmashell|sway|kwin_wayland' 2>/dev/null", "r");
    if (pipe) {
        char buffer[128];
        if (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            hasGraphicalSession = true;
            displayType = "GUI";
        }
        pclose(pipe);
    }

    // Method 2: Check loginctl for graphical sessions
    if (!hasGraphicalSession) {
        pipe = popen("loginctl list-sessions --no-legend 2>/dev/null | head -1", "r");
        if (pipe) {
            char sessionId[64];
            if (fgets(sessionId, sizeof(sessionId), pipe) != nullptr) {
                pclose(pipe);
                // Get session type
                char cmd[256];
                sscanf(sessionId, "%63s", sessionId); // Get first field (session ID)
                snprintf(cmd, sizeof(cmd), "loginctl show-session %s -p Type --value 2>/dev/null", sessionId);
                FILE* typePipe = popen(cmd, "r");
                if (typePipe) {
                    char type[32];
                    if (fgets(type, sizeof(type), typePipe) != nullptr) {
                        // Trim newline
                        type[strcspn(type, "\n")] = 0;
                        if (strcmp(type, "x11") == 0 || strcmp(type, "wayland") == 0) {
                            hasGraphicalSession = true;
                            displayType = type;
                        }
                    }
                    pclose(typePipe);
                }
            } else {
                pclose(pipe);
            }
        }
    }

    if (hasGraphicalSession) {
        DisplayInfo di;
        di.id = 1;
        di.name = displayType;
        di.width = 1920;
        di.height = 1080;
        di.x = 0;
        di.y = 0;
        di.scale = 1.0;
        di.isPrimary = true;
        di.isBuiltin = false;
        displays.push_back(di);
    }
    // If no graphical session detected, return empty (headless system)
#endif

    return displays;
}

std::string ScreenStream::startStream(const StreamConfig& config, FrameCallback callback)
{
#if HAS_LIBSCREENCONTROL
    if (!hasPermission()) {
        Logger::error("Screen capture permission not granted");
        return "";
    }

    std::lock_guard<std::mutex> lock(m_mutex);

    // Generate stream ID
    std::stringstream ss;
    ss << "stream_" << std::hex << std::setfill('0') << std::setw(8)
       << m_nextStreamId.fetch_add(1);
    std::string streamId = ss.str();

    // Create session
    auto session = std::make_unique<StreamSession>();
    session->id = streamId;
    session->config = config;
    session->callback = callback;

    // Create capture configuration
    SCCaptureConfig captureConfig = {};
    captureConfig.display_id = config.displayId;
    captureConfig.max_fps = config.maxFps;
    captureConfig.quality = config.quality;
    captureConfig.capture_cursor = config.captureCursor;
    captureConfig.show_clicks = false;
    captureConfig.region = {0, 0, 0, 0};  // Full screen

    session->capture = sc_capture_create(&captureConfig);
    if (!session->capture) {
        Logger::error("Failed to create capture instance");
        return "";
    }

    // Create encoder configuration
    SCEncoderConfig encoderConfig = {};
    encoderConfig.quality = config.quality;
    encoderConfig.max_fps = config.maxFps;
    encoderConfig.use_zstd = config.useZstd;
    encoderConfig.use_jpeg = config.useJpeg;
    encoderConfig.detect_motion = true;
    encoderConfig.zstd_level = 3;
    encoderConfig.jpeg_quality = config.quality;
    encoderConfig.tile_size = 64;

    session->encoder = sc_encoder_create(&encoderConfig);
    if (!session->encoder) {
        Logger::error("Failed to create encoder instance");
        return "";
    }

    session->running = true;
    session->lastFpsUpdate = std::chrono::steady_clock::now();

    // Start capture thread
    StreamSession* sessionPtr = session.get();
    session->captureThread = std::thread(&ScreenStream::runCaptureLoop, this, sessionPtr);

    m_sessions.push_back(std::move(session));

    Logger::info("Started stream: " + streamId);
    return streamId;
#else
    Logger::error("Screen streaming not available on this platform");
    return "";
#endif
}

#if HAS_LIBSCREENCONTROL
// Process a captured frame - member function to access private types
void ScreenStream::processFrame(StreamSession* session, const void* framePtr)
{
    const SCFrame* frame = static_cast<const SCFrame*>(framePtr);
    if (!session || !session->running || !frame) return;

    // Check if refresh requested (send full frame)
    bool fullFrame = session->refreshRequested.exchange(false);

    // Encode frame
    SCEncodedFrame* encoded = nullptr;
    if (fullFrame || !session->prevFrame) {
        encoded = sc_encoder_encode_full(session->encoder, frame,
                                         static_cast<uint32_t>(session->framesEncoded.load()), 0);
    } else {
        encoded = sc_encoder_encode(session->encoder, frame, session->prevFrame,
                                    static_cast<uint32_t>(session->framesEncoded.load()), 0);
    }

    if (encoded && encoded->num_rects > 0) {
        // Serialize encoded frame to binary format
        // Format: sequence(4) + timestamp(4) + num_rects(2) + [rect data...]
        EncodedFrameData frameData;
        frameData.sequence = encoded->sequence;
        frameData.timestamp = encoded->timestamp;
        frameData.numRects = encoded->num_rects;

        // Calculate total size
        size_t totalSize = 10;  // Header
        for (uint16_t i = 0; i < encoded->num_rects; i++) {
            totalSize += 14 + encoded->rects[i].data_len;  // Rect header + data
        }

        frameData.data.resize(totalSize);
        uint8_t* ptr = frameData.data.data();

        // Write header
        *ptr++ = encoded->sequence & 0xFF;
        *ptr++ = (encoded->sequence >> 8) & 0xFF;
        *ptr++ = (encoded->sequence >> 16) & 0xFF;
        *ptr++ = (encoded->sequence >> 24) & 0xFF;
        *ptr++ = encoded->timestamp & 0xFF;
        *ptr++ = (encoded->timestamp >> 8) & 0xFF;
        *ptr++ = (encoded->timestamp >> 16) & 0xFF;
        *ptr++ = (encoded->timestamp >> 24) & 0xFF;
        *ptr++ = encoded->num_rects & 0xFF;
        *ptr++ = (encoded->num_rects >> 8) & 0xFF;

        // Write rectangles
        for (uint16_t i = 0; i < encoded->num_rects; i++) {
            const SCEncodedRect* rect = &encoded->rects[i];

            *ptr++ = rect->rect.x & 0xFF;
            *ptr++ = (rect->rect.x >> 8) & 0xFF;
            *ptr++ = rect->rect.y & 0xFF;
            *ptr++ = (rect->rect.y >> 8) & 0xFF;
            *ptr++ = rect->rect.width & 0xFF;
            *ptr++ = (rect->rect.width >> 8) & 0xFF;
            *ptr++ = rect->rect.height & 0xFF;
            *ptr++ = (rect->rect.height >> 8) & 0xFF;
            *ptr++ = rect->encoding;
            *ptr++ = 0;  // flags
            *ptr++ = rect->data_len & 0xFF;
            *ptr++ = (rect->data_len >> 8) & 0xFF;
            *ptr++ = (rect->data_len >> 16) & 0xFF;
            *ptr++ = (rect->data_len >> 24) & 0xFF;

            memcpy(ptr, rect->data, rect->data_len);
            ptr += rect->data_len;
        }

        // Update statistics
        session->framesEncoded++;
        session->bytesEncoded += frameData.data.size();
        session->framesSinceLastFps++;

        // Calculate FPS
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - session->lastFpsUpdate).count();
        if (elapsed >= 1000) {
            session->currentFps = static_cast<uint32_t>((session->framesSinceLastFps * 1000) / elapsed);
            session->framesSinceLastFps = 0;
            session->lastFpsUpdate = now;
        }

        // Invoke callback
        if (session->callback) {
            session->callback(frameData);
        }
    }

    if (encoded) {
        sc_encoded_frame_free(encoded);
    }

    // Store previous frame for delta encoding
    if (session->prevFrame) {
        sc_frame_free(session->prevFrame);
    }
    session->prevFrame = sc_frame_copy(frame);
}

// Callback data structure - pairs session with ScreenStream instance
struct CaptureCallbackContext {
    ScreenStream* stream;
    ScreenStream::StreamSession* session;
};

// Static C callback that forwards to member function
static void staticFrameCallback(SCCapture* capture, const SCFrame* frame, void* userData)
{
    (void)capture;
    auto* ctx = static_cast<CaptureCallbackContext*>(userData);
    if (ctx && ctx->stream && ctx->session) {
        ctx->stream->processFrame(ctx->session, frame);
    }
}

void ScreenStream::runCaptureLoop(StreamSession* session)
{
    // Create callback context
    CaptureCallbackContext ctx{this, session};

    // Start capture with callback
    int result = sc_capture_start(session->capture,
                                  staticFrameCallback,
                                  nullptr,  // Error callback
                                  &ctx);

    if (result != 0) {
        Logger::error("Failed to start capture");
        session->running = false;
        return;
    }

    // Wait until stopped
    while (session->running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    sc_capture_stop(session->capture);
}
#else
// Stubs for non-macOS platforms
void ScreenStream::processFrame(StreamSession*, const void*)
{
    // Not available
}

void ScreenStream::runCaptureLoop(StreamSession* session)
{
    (void)session;
    // Not available
}
#endif

void ScreenStream::stopStream(const std::string& streamId)
{
    std::lock_guard<std::mutex> lock(m_mutex);

    auto it = std::find_if(m_sessions.begin(), m_sessions.end(),
        [&streamId](const std::unique_ptr<StreamSession>& s) {
            return s->id == streamId;
        });

    if (it != m_sessions.end()) {
        (*it)->running = false;
        if ((*it)->captureThread.joinable()) {
            (*it)->captureThread.join();
        }
        m_sessions.erase(it);
        Logger::info("Stopped stream: " + streamId);
    }
}

void ScreenStream::stopAllStreams()
{
    std::lock_guard<std::mutex> lock(m_mutex);

    for (auto& session : m_sessions) {
        session->running = false;
    }

    for (auto& session : m_sessions) {
        if (session->captureThread.joinable()) {
            session->captureThread.join();
        }
    }

    m_sessions.clear();
    Logger::info("Stopped all streams");
}

bool ScreenStream::isStreamActive(const std::string& streamId) const
{
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(m_mutex));

    auto it = std::find_if(m_sessions.begin(), m_sessions.end(),
        [&streamId](const std::unique_ptr<StreamSession>& s) {
            return s->id == streamId;
        });

    return it != m_sessions.end() && (*it)->running;
}

bool ScreenStream::getStreamStats(const std::string& streamId, StreamStats& stats) const
{
    std::lock_guard<std::mutex> lock(const_cast<std::mutex&>(m_mutex));

    auto it = std::find_if(m_sessions.begin(), m_sessions.end(),
        [&streamId](const std::unique_ptr<StreamSession>& s) {
            return s->id == streamId;
        });

    if (it == m_sessions.end()) {
        return false;
    }

    const auto& session = *it;
    stats.framesEncoded = session->framesEncoded;
    stats.bytesEncoded = session->bytesEncoded;
    stats.currentFps = session->currentFps;

#if HAS_LIBSCREENCONTROL
    if (session->encoder) {
        SCEncoderStats encStats;
        if (sc_encoder_get_stats(session->encoder, &encStats) == 0) {
            stats.compressionRatio = encStats.compression_ratio;
            stats.avgEncodeTimeUs = encStats.avg_encode_time_us;
        }
    }
#endif

    return true;
}

void ScreenStream::requestRefresh(const std::string& streamId)
{
    std::lock_guard<std::mutex> lock(m_mutex);

    auto it = std::find_if(m_sessions.begin(), m_sessions.end(),
        [&streamId](const std::unique_ptr<StreamSession>& s) {
            return s->id == streamId;
        });

    if (it != m_sessions.end()) {
        (*it)->refreshRequested = true;
    }
}

bool ScreenStream::updateConfig(const std::string& streamId, const StreamConfig& config)
{
    std::lock_guard<std::mutex> lock(m_mutex);

    auto it = std::find_if(m_sessions.begin(), m_sessions.end(),
        [&streamId](const std::unique_ptr<StreamSession>& s) {
            return s->id == streamId;
        });

    if (it == m_sessions.end()) {
        return false;
    }

    (*it)->config = config;

#if HAS_LIBSCREENCONTROL
    // Update encoder config
    if ((*it)->encoder) {
        SCEncoderConfig encoderConfig = {};
        encoderConfig.quality = config.quality;
        encoderConfig.max_fps = config.maxFps;
        encoderConfig.use_zstd = config.useZstd;
        encoderConfig.use_jpeg = config.useJpeg;
        encoderConfig.detect_motion = true;
        encoderConfig.zstd_level = 3;
        encoderConfig.jpeg_quality = config.quality;
        encoderConfig.tile_size = 64;

        sc_encoder_configure((*it)->encoder, &encoderConfig);
    }
#endif

    return true;
}

bool ScreenStream::captureScreenshot(uint32_t displayId, uint8_t quality,
                                     std::vector<uint8_t>& outData)
{
#if HAS_LIBSCREENCONTROL
    if (!hasPermission()) {
        Logger::error("Screen capture permission not granted");
        return false;
    }

    // Create temporary capture
    SCCaptureConfig config = {};
    config.display_id = displayId;
    config.max_fps = 1;
    config.quality = quality;
    config.capture_cursor = true;

    SCCapture* capture = sc_capture_create(&config);
    if (!capture) {
        return false;
    }

    // Capture single frame
    std::atomic<bool> gotFrame{false};
    std::vector<uint8_t> jpegData;

    auto frameCallback = [](SCCapture* cap, const SCFrame* frame, void* userData) {
        auto* data = static_cast<std::pair<std::atomic<bool>*, std::vector<uint8_t>*>*>(userData);
        if (!data->first->exchange(true)) {
            // Encode frame as JPEG
            // For now, just copy raw BGRA (actual JPEG encoding would need libjpeg)
            size_t size = frame->width * frame->height * 4;
            data->second->resize(size);
            memcpy(data->second->data(), frame->pixels, size);
        }
    };

    std::pair<std::atomic<bool>*, std::vector<uint8_t>*> callbackData(&gotFrame, &jpegData);

    sc_capture_start(capture, frameCallback, nullptr, &callbackData);

    // Wait for frame (up to 1 second)
    for (int i = 0; i < 100 && !gotFrame; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    sc_capture_stop(capture);
    sc_capture_free(capture);

    if (gotFrame) {
        outData = std::move(jpegData);
        return true;
    }

    return false;
#else
    (void)displayId;
    (void)quality;
    (void)outData;
    return false;
#endif
}

} // namespace ScreenControl
