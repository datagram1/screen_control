/**
 * Stream Session Manager
 *
 * Manages active streaming sessions between viewers and agents.
 * Handles session tokens, viewer connections, and frame relay.
 */

import { WebSocket } from 'ws';
import { StreamSession, ViewerMessage, StreamAgentResponse } from './types';
import { agentRegistry } from './agent-registry';
import { prisma } from '../prisma';
import crypto from 'crypto';

// Session token validity duration (5 minutes)
const TOKEN_VALIDITY_MS = 5 * 60 * 1000;

// Maximum concurrent streams per agent
const MAX_STREAMS_PER_AGENT = 3;

interface PendingSession {
  token: string;
  agentId: string;
  userId?: string;
  displayId: number;
  quality: number;
  maxFps: number;
  createdAt: Date;
  remoteAddress: string;
}

class StreamSessionManager {
  // Active streaming sessions
  private sessions: Map<string, StreamSession> = new Map();

  // Map agent connection ID to stream sessions (for relaying frames)
  private agentToSessions: Map<string, Set<string>> = new Map();

  // Token cleanup interval
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired tokens every minute
    this.cleanupInterval = setInterval(() => this.cleanupExpiredTokens(), 60000);
  }

  /**
   * Create a session token for a viewer to connect
   * Uses database storage so tokens work across processes (API routes vs WebSocket handler)
   * Called by /api/stream/connect
   */
  async createSessionToken(params: {
    agentId: string;
    userId?: string;
    displayId?: number;
    quality?: number;
    maxFps?: number;
    remoteAddress: string;
  }): Promise<{ token: string; expiresAt: Date } | { error: string }> {
    const { agentId, userId, displayId = 0, quality = 80, maxFps = 30, remoteAddress } = params;

    // Verify agent exists and is connected
    const agent = agentRegistry.getAgentByDbId(agentId);
    if (!agent) {
      return { error: 'Agent not connected' };
    }

    // Check agent state
    if (agent.state !== 'ACTIVE') {
      return { error: `Agent is ${agent.state.toLowerCase()}` };
    }

    // Check concurrent stream limit
    const existingSessions = this.agentToSessions.get(agent.id);
    if (existingSessions && existingSessions.size >= MAX_STREAMS_PER_AGENT) {
      return { error: 'Maximum concurrent streams reached for this agent' };
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_VALIDITY_MS);

    // Store token in database (works across processes)
    await prisma.streamSessionToken.create({
      data: {
        token,
        agentId,
        userId,
        displayId,
        quality,
        maxFps,
        remoteAddress,
        expiresAt,
      },
    });

    // Clean up expired tokens periodically (async, don't wait)
    this.cleanupExpiredTokens().catch(console.error);

    console.log(`[Stream] Created session token for agent ${agent.machineName || agentId}`);
    return { token, expiresAt };
  }

  /**
   * Validate and consume a session token
   * Reads from database so tokens work across processes
   * Returns session info if valid, null if invalid/expired
   */
  async validateToken(token: string): Promise<PendingSession | null> {
    // Validate token from database
    const tokenData = await prisma.streamSessionToken.findUnique({
      where: { token },
    });

    if (!tokenData) {
      return null;
    }

    // Check expiry
    if (new Date() > tokenData.expiresAt) {
      await prisma.streamSessionToken.delete({ where: { id: tokenData.id } });
      return null;
    }

    // Token is valid - consume it (one-time use)
    await prisma.streamSessionToken.delete({ where: { id: tokenData.id } });

    return {
      token: tokenData.token,
      agentId: tokenData.agentId,
      userId: tokenData.userId ?? undefined,
      displayId: tokenData.displayId,
      quality: tokenData.quality,
      maxFps: tokenData.maxFps,
      createdAt: tokenData.createdAt,
      remoteAddress: tokenData.remoteAddress,
    };
  }

  /**
   * Create a streaming session after viewer connects and authenticates
   */
  async createSession(
    viewerSocket: WebSocket,
    viewerAddress: string,
    pending: PendingSession
  ): Promise<StreamSession | { error: string }> {
    // Re-verify agent is still connected
    const agent = agentRegistry.getAgentByDbId(pending.agentId);
    if (!agent) {
      return { error: 'Agent disconnected' };
    }

    // Generate session ID
    const sessionId = crypto.randomUUID();

    // Create session object
    const session: StreamSession = {
      id: sessionId,
      agentId: pending.agentId,
      viewerSocket,
      viewerAddress,
      userId: pending.userId,
      displayId: pending.displayId,
      quality: pending.quality,
      maxFps: pending.maxFps,
      createdAt: new Date(),
      lastActivity: new Date(),
      framesRelayed: 0,
      bytesRelayed: 0,
      inputEventsRelayed: 0,
    };

    // Store session
    this.sessions.set(sessionId, session);

    // Track agent → sessions mapping
    let agentSessions = this.agentToSessions.get(agent.id);
    if (!agentSessions) {
      agentSessions = new Set();
      this.agentToSessions.set(agent.id, agentSessions);
    }
    agentSessions.add(sessionId);

    // Send stream_start command to agent
    try {
      await this.sendToAgent(agent.id, {
        type: 'stream_start',
        id: crypto.randomUUID(),
        sessionId,
        displayId: pending.displayId,
        quality: pending.quality,
        maxFps: pending.maxFps,
      });
    } catch (err) {
      // Clean up on failure
      this.sessions.delete(sessionId);
      agentSessions.delete(sessionId);
      return { error: `Failed to start stream on agent: ${err}` };
    }

    console.log(`[Stream] Session ${sessionId} created for agent ${agent.machineName}`);
    return session;
  }

  /**
   * End a streaming session
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Find agent connection ID
    const agent = agentRegistry.getAgentByDbId(session.agentId);

    // Send stream_stop to agent
    if (agent) {
      try {
        await this.sendToAgent(agent.id, {
          type: 'stream_stop',
          id: crypto.randomUUID(),
          sessionId,
        });
      } catch (err) {
        console.error(`[Stream] Error stopping stream on agent: ${err}`);
      }

      // Remove from agent's session set
      const agentSessions = this.agentToSessions.get(agent.id);
      if (agentSessions) {
        agentSessions.delete(sessionId);
        if (agentSessions.size === 0) {
          this.agentToSessions.delete(agent.id);
        }
      }
    }

    // Close viewer socket if still open
    if (session.viewerSocket.readyState === WebSocket.OPEN) {
      session.viewerSocket.send(JSON.stringify({ type: 'stream_stopped', sessionId }));
      session.viewerSocket.close(1000, 'Stream ended');
    }

    // Remove session
    this.sessions.delete(sessionId);

    console.log(`[Stream] Session ${sessionId} ended (${session.framesRelayed} frames, ${formatBytes(session.bytesRelayed)})`);
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): StreamSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for an agent
   */
  getSessionsForAgent(agentDbId: string): StreamSession[] {
    const sessions: StreamSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.agentId === agentDbId) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /**
   * Handle incoming frame data from agent
   * Relays to all viewers watching that agent
   */
  handleAgentFrame(agentConnectionId: string, msg: StreamAgentResponse, binaryData?: Buffer): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      console.warn(`[Stream] Frame for unknown session ${msg.sessionId}`);
      return;
    }

    session.lastActivity = new Date();

    if (session.viewerSocket.readyState !== WebSocket.OPEN) {
      // Viewer disconnected, end session
      this.endSession(msg.sessionId);
      return;
    }

    if (msg.type === 'stream_frame' && binaryData) {
      // Send frame header as JSON, followed by binary data
      const header = JSON.stringify({
        type: 'frame',
        sessionId: msg.sessionId,
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        numRects: msg.numRects,
        frameSize: binaryData.length,
      });

      // Send as two messages: JSON header, then binary
      session.viewerSocket.send(header);
      session.viewerSocket.send(binaryData);

      session.framesRelayed++;
      session.bytesRelayed += binaryData.length;
    } else if (msg.type === 'stream_cursor') {
      // Relay cursor update
      session.viewerSocket.send(JSON.stringify({
        type: 'cursor',
        sessionId: msg.sessionId,
        cursorX: msg.cursorX,
        cursorY: msg.cursorY,
        cursorVisible: msg.cursorVisible,
        cursorShape: msg.cursorShape,
        cursorHotspotX: msg.cursorHotspotX,
        cursorHotspotY: msg.cursorHotspotY,
      }));
    } else if (msg.type === 'stream_error') {
      session.viewerSocket.send(JSON.stringify({
        type: 'error',
        sessionId: msg.sessionId,
        error: msg.error,
      }));
    } else if (msg.type === 'stream_started') {
      session.viewerSocket.send(JSON.stringify({
        type: 'stream_started',
        sessionId: msg.sessionId,
        width: msg.width,
        height: msg.height,
      }));
    }
  }

  /**
   * Handle input event from viewer
   */
  async handleViewerInput(sessionId: string, msg: ViewerMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.lastActivity = new Date();

    const agent = agentRegistry.getAgentByDbId(session.agentId);
    if (!agent) {
      return;
    }

    // Forward input to agent
    await this.sendToAgent(agent.id, {
      type: 'stream_input',
      id: crypto.randomUUID(),
      sessionId,
      inputType: msg.inputType,
      x: msg.x,
      y: msg.y,
      button: msg.button,
      buttons: msg.buttons,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY,
      keyCode: msg.keyCode,
      key: msg.key,
      modifiers: msg.modifiers,
      isKeyDown: msg.isKeyDown,
    });

    session.inputEventsRelayed++;
  }

  /**
   * Handle quality change request from viewer
   */
  async handleQualityChange(sessionId: string, quality: number, maxFps?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.quality = quality;
    if (maxFps !== undefined) {
      session.maxFps = maxFps;
    }

    const agent = agentRegistry.getAgentByDbId(session.agentId);
    if (!agent) {
      return;
    }

    // Send quality update to agent
    // This could be a config update or a stream restart
    // For now, we'll restart the stream with new parameters
    await this.sendToAgent(agent.id, {
      type: 'stream_start',
      id: crypto.randomUUID(),
      sessionId,
      displayId: session.displayId,
      quality,
      maxFps: session.maxFps,
    });
  }

  /**
   * Request a full frame refresh (keyframe)
   */
  async requestRefresh(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const agent = agentRegistry.getAgentByDbId(session.agentId);
    if (!agent) {
      return;
    }

    // The agent's HTTP endpoint can be used for this
    // Or we can add a stream_refresh message type
    // For now, restart the stream which will send a full frame
    await this.sendToAgent(agent.id, {
      type: 'stream_start',
      id: crypto.randomUUID(),
      sessionId,
      displayId: session.displayId,
      quality: session.quality,
      maxFps: session.maxFps,
    });
  }

  /**
   * Handle agent disconnect - end all sessions for that agent
   */
  handleAgentDisconnect(agentConnectionId: string): void {
    const sessionIds = this.agentToSessions.get(agentConnectionId);
    if (!sessionIds) {
      return;
    }

    console.log(`[Stream] Agent disconnected, ending ${sessionIds.size} stream session(s)`);

    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Notify viewer
        if (session.viewerSocket.readyState === WebSocket.OPEN) {
          session.viewerSocket.send(JSON.stringify({
            type: 'error',
            code: 'AGENT_DISCONNECTED',
            error: 'Agent disconnected',
          }));
          session.viewerSocket.close(1001, 'Agent disconnected');
        }
        this.sessions.delete(sessionId);
      }
    }

    this.agentToSessions.delete(agentConnectionId);
  }

  /**
   * Get statistics
   */
  getStats(): {
    activeSessions: number;
    totalFramesRelayed: number;
    totalBytesRelayed: number;
  } {
    let totalFrames = 0;
    let totalBytes = 0;

    for (const session of this.sessions.values()) {
      totalFrames += session.framesRelayed;
      totalBytes += session.bytesRelayed;
    }

    return {
      activeSessions: this.sessions.size,
      totalFramesRelayed: totalFrames,
      totalBytesRelayed: totalBytes,
    };
  }

  /**
   * Clean up expired tokens from database
   */
  private async cleanupExpiredTokens(): Promise<void> {
    await prisma.streamSessionToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
  }

  /**
   * Send a message to an agent
   */
  private async sendToAgent(agentConnectionId: string, message: object): Promise<void> {
    const agent = agentRegistry.getAgent(agentConnectionId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Agent not connected');
    }

    agent.socket.send(JSON.stringify(message));
  }

  /**
   * Cleanup on shutdown
   */
  cleanup(): void {
    clearInterval(this.cleanupInterval);

    // End all sessions
    for (const sessionId of this.sessions.keys()) {
      this.endSession(sessionId);
    }

    this.sessions.clear();
    this.agentToSessions.clear();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Export singleton instance
export const streamSessionManager = new StreamSessionManager();
