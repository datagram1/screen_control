# ScreenControl

## What This Is
Cross-platform AI desktop automation platform enabling Claude and other LLMs to control computers via MCP (Model Context Protocol). Supports local (Claude Code/Desktop via stdio) and remote (Claude Web via control server) access for screenshots, mouse/keyboard control, browser automation, filesystem, and shell commands.

## Tech Stack
- **Native Apps**: Objective-C (macOS), C++ cross-platform service (Linux/Windows/macOS)
- **Control Server**: Next.js 16, React 19, TypeScript, Prisma, PostgreSQL
- **Browser Extensions**: Firefox, Chrome, Safari (JavaScript)
- **Build Tools**: Xcode (macOS), CMake (cross-platform service), npm/TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **Desktop Automation**: nut-js, screenshot-desktop, tesseract.js (OCR)
- **Auth**: NextAuth, OAuth 2.0 with PKCE, Stripe payments

## Key Files/Directories
- `/Users/richardbrown/dev/screen_control/macos/ScreenControl/` - Native macOS app (Objective-C)
- `/Users/richardbrown/dev/screen_control/service/` - Cross-platform C++ service (CMakeLists.txt)
- `/Users/richardbrown/dev/screen_control/web/` - Next.js control server
- `/Users/richardbrown/dev/screen_control/web/prisma/schema.prisma` - Database schema
- `/Users/richardbrown/dev/screen_control/extension/` - Browser extensions (Firefox/Chrome/Safari)
- `/Users/richardbrown/dev/screen_control/boot/` - Rescue Boot USB system (Alpine Linux)
- `/Users/richardbrown/dev/screen_control/docs/` - Documentation
- `/Users/richardbrown/dev/screen_control/.mcp.json` - Local MCP server config

## Setup

### macOS App (Local)
```bash
cd macos
xcodebuild -project ScreenControl.xcodeproj -scheme ScreenControl -configuration Release build
```

### Cross-Platform Service
```bash
cd service
mkdir build && cd build
cmake ..
make -j$(nproc)
```

### Control Server (Web)
```bash
cd web
npm install
cp .env.example .env  # Configure DATABASE_URL
npx prisma db push
npm run dev
```

## Live Server / Deployment
- Control server runs on port 3000 (web/)
- Service HTTP API: port 3459 (localhost only)
- GUI Bridge: port 3460 (localhost only)
- Browser extension WebSocket: port 3457
- GitHub: github.com/datagram1/screen_control

## Notes
- macOS requires Screen Recording and Accessibility permissions
- 90+ MCP tools available (39 without browser extension)
- Supports multi-instance: multiple Claude Code sessions share browser connection
- Agent licensing with phone-home tracking and hardware fingerprinting
- Auto-update system with channels: stable, beta, dev
- Email agent for AI-triggered email task processing (IMAP + LLM)
