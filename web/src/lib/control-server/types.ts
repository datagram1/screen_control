/**
 * ScreenControl Control Server Types
 */

import { WebSocket } from 'ws';

// ═══════════════════════════════════════════════════════════════════════════
// Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export type PowerState = 'ACTIVE' | 'PASSIVE' | 'SLEEP';
export type AgentState = 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'EXPIRED';
export type OSType = 'WINDOWS' | 'MACOS' | 'LINUX';

export interface ConnectedAgent {
  // Connection identity
  id: string;                  // Connection session ID (ephemeral)
  dbId?: string;               // Database ID (persistent)
  socket: WebSocket;
  remoteAddress: string;
  isInternal: boolean;

  // Agent identity (from registration)
  customerId?: string;         // From stamped installer
  licenseUuid?: string;        // Issued on activation
  licenseStatus?: 'active' | 'pending' | 'expired' | 'blocked';
  machineId?: string;          // Hardware identifier
  machineName?: string;

  // System info
  osType: OSType;
  osVersion?: string;
  arch?: string;
  agentVersion?: string;

  // Fingerprinting
  fingerprint?: string;        // SHA256 hash
  fingerprintRaw?: FingerprintData;

  // State
  state: AgentState;
  powerState: PowerState;
  isScreenLocked: boolean;
  hasDisplay: boolean;          // False for headless servers
  currentTask?: string;

  // Timestamps
  connectedAt: Date;
  lastPing: Date;
  lastActivity: Date;

  // Capabilities (cached from agent on connect)
  tools?: MCPTool[];
  toolsFetchedAt?: Date;
  resources?: MCPResource[];
  prompts?: MCPPrompt[];

  // Pending requests (for request/response correlation)
  pendingRequests: Map<string, PendingRequest>;
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP Capability Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface FingerprintData {
  cpuModel?: string;
  cpuCores?: number;
  totalMemory?: number;
  diskSerial?: string;
  motherboardUuid?: string;
  macAddresses?: string[];
  hostname?: string;
  username?: string;
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startedAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════
// Message Types
// ═══════════════════════════════════════════════════════════════════════════

// Messages FROM agent TO control server
export interface AgentMessage {
  type: 'register' | 'response' | 'pong' | 'error' | 'heartbeat' | 'state_change' | 'tools_changed'
      | 'stream_started' | 'stream_stopped' | 'stream_frame' | 'stream_cursor' | 'stream_error'
      | 'relay_request';  // Master mode: relay command to another agent
  id?: string;

  // Registration data
  customerId?: string;
  licenseUuid?: string;
  machineId?: string;
  machineName?: string;
  osType?: string;
  osVersion?: string;
  arch?: string;
  agentVersion?: string;
  fingerprint?: FingerprintData;
  agentSecret?: string;  // API key for re-authentication after token expiry
  capabilities?: string[]; // Tool names the agent supports (new protocol)

  // Response data
  result?: unknown;
  error?: string;

  // State change data
  powerState?: PowerState;
  isScreenLocked?: boolean;
  hasDisplay?: boolean;         // False for headless servers
  currentTask?: string;

  // Tools changed notification data
  browserBridgeRunning?: boolean;
  timestamp?: number;

  // Relay request data (for master mode)
  targetAgentId?: string;
  method?: string;
  params?: Record<string, unknown>;
}

// Messages FROM control server TO agent
export interface CommandMessage {
  type: 'request' | 'ping' | 'command' | 'config';
  id: string;
  method?: string;
  params?: Record<string, unknown>;

  // Config updates
  config?: {
    heartbeatInterval?: number;
    powerState?: PowerState;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry Interface (for future Redis implementation)
// ═══════════════════════════════════════════════════════════════════════════

export interface IAgentRegistry {
  // Connection management
  register(socket: WebSocket, msg: AgentMessage, remoteAddress: string): Promise<ConnectedAgent | null>;
  unregister(agentId: string): void;

  // Lookups
  getAgent(agentId: string): ConnectedAgent | undefined;
  getAgentByMachineId(machineId: string): ConnectedAgent | undefined;
  getAgentsByCustomerId(customerId: string): ConnectedAgent[];
  getAllAgents(): ConnectedAgent[];

  // Commands
  sendCommand(agentId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  handleResponse(agent: ConnectedAgent, msg: AgentMessage): void;

  // State updates
  updatePing(agent: ConnectedAgent): void;
  updateState(agent: ConnectedAgent, state: Partial<ConnectedAgent>): void;

  // Cleanup
  cleanup(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming Types
// ═══════════════════════════════════════════════════════════════════════════

export interface StreamSession {
  id: string;                    // Session ID
  agentId: string;               // Database agent ID
  viewerSocket: WebSocket;       // Viewer's WebSocket connection
  viewerAddress: string;         // Viewer's IP
  userId?: string;               // Authenticated user ID
  displayId: number;             // Which display to stream
  quality: number;               // Stream quality (0-100)
  maxFps: number;                // Max FPS
  createdAt: Date;
  lastActivity: Date;

  // Statistics
  framesRelayed: number;
  bytesRelayed: number;
  inputEventsRelayed: number;
}

// Messages FROM viewer TO control server
export interface ViewerMessage {
  type: 'stream_start' | 'stream_stop' | 'input' | 'ping' | 'quality_change' | 'refresh';
  sessionToken?: string;         // Auth token from /api/stream/connect
  agentId?: string;              // Target agent

  // Stream config (for stream_start)
  displayId?: number;
  quality?: number;
  maxFps?: number;

  // Input events (for input)
  inputType?: 'mouse' | 'keyboard';
  x?: number;
  y?: number;
  button?: number;               // Mouse button
  buttons?: number;              // Button state
  deltaX?: number;               // Scroll
  deltaY?: number;
  keyCode?: number;
  key?: string;
  modifiers?: number;            // Shift=1, Ctrl=2, Alt=4, Meta=8
  isKeyDown?: boolean;
}

// Messages FROM control server TO viewer
export interface StreamServerMessage {
  type: 'stream_started' | 'stream_stopped' | 'frame' | 'cursor' | 'error' | 'stats' | 'pong';
  sessionId?: string;

  // Error info
  error?: string;
  code?: string;

  // Frame data (binary follows this JSON header for 'frame' type)
  sequence?: number;
  timestamp?: number;
  numRects?: number;
  frameSize?: number;            // Size of binary data that follows

  // Cursor update
  cursorX?: number;
  cursorY?: number;
  cursorShape?: string;          // Base64 encoded cursor image
  cursorHotspotX?: number;
  cursorHotspotY?: number;

  // Stats
  fps?: number;
  latency?: number;
  bandwidth?: number;
}

// Messages TO agent for streaming
export interface StreamAgentMessage {
  type: 'stream_start' | 'stream_stop' | 'stream_input';
  id: string;                    // Request ID for correlation
  sessionId: string;             // Stream session ID

  // Stream config
  displayId?: number;
  quality?: number;
  maxFps?: number;

  // Input event
  inputType?: 'mouse' | 'keyboard';
  x?: number;
  y?: number;
  button?: number;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  keyCode?: number;
  key?: string;
  modifiers?: number;
  isKeyDown?: boolean;
}

// Messages FROM agent for streaming
export interface StreamAgentResponse {
  type: 'stream_started' | 'stream_stopped' | 'stream_frame' | 'stream_cursor' | 'stream_error';
  id?: string;                   // Correlation ID
  sessionId: string;

  // For stream_started
  width?: number;
  height?: number;

  // For stream_frame (binary data follows)
  sequence?: number;
  timestamp?: number;
  numRects?: number;
  frameSize?: number;

  // For stream_cursor
  cursorX?: number;
  cursorY?: number;
  cursorVisible?: boolean;
  cursorShape?: string;          // Base64 encoded
  cursorHotspotX?: number;
  cursorHotspotY?: number;

  // For stream_error
  error?: string;
}
