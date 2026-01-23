/**
 * Master Controller Session Manager
 *
 * Manages master controller connections that can relay commands to other agents.
 * When an agent has masterModeEnabled, it can:
 * - List all accessible agents (within same customer scope)
 * - Relay commands to target agents
 * - Receive responses from relayed commands
 */

import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../prisma';
import { agentRegistry } from './agent-registry';
import type { ConnectedAgent } from './types';

interface MasterSession {
  agentId: string;           // Database agent ID
  agentDbId: string;         // Database ID
  customerId: string;        // Customer scope for access control
  socket: WebSocket;         // WebSocket connection
  registeredAt: Date;
  lastActivity: Date;
}

interface RelayRequest {
  id: string;
  masterAgentId: string;
  targetAgentId: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: Date;
  timeout: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

class MasterSessionManager {
  private masterSessions = new Map<string, MasterSession>(); // agentId -> session
  private pendingRelays = new Map<string, RelayRequest>(); // requestId -> relay

  /**
   * Register an agent as a master controller
   * Called when agent with masterModeEnabled connects and registers
   */
  async registerMasterSession(
    agentDbId: string,
    socket: WebSocket
  ): Promise<boolean> {
    // Verify agent has master mode enabled
    const agent = await prisma.agent.findUnique({
      where: { id: agentDbId },
      select: {
        id: true,
        ownerUserId: true,
        masterModeEnabled: true,
        hostname: true,
        displayName: true,
      },
    });

    if (!agent) {
      console.error(`[MasterSession] Agent not found: ${agentDbId}`);
      return false;
    }

    if (!agent.masterModeEnabled) {
      console.log(`[MasterSession] Agent ${agentDbId} does not have master mode enabled`);
      return false;
    }

    const session: MasterSession = {
      agentId: agent.id,
      agentDbId: agentDbId,
      customerId: agent.ownerUserId || '',
      socket,
      registeredAt: new Date(),
      lastActivity: new Date(),
    };

    this.masterSessions.set(agentDbId, session);

    console.log(`[MasterSession] Registered master session for ${agent.displayName || agent.hostname || agentDbId}`);
    return true;
  }

  /**
   * Unregister a master session when agent disconnects
   */
  unregisterMasterSession(agentDbId: string): void {
    const session = this.masterSessions.get(agentDbId);
    if (session) {
      this.masterSessions.delete(agentDbId);
      console.log(`[MasterSession] Unregistered master session for ${agentDbId}`);

      // Cancel any pending relays from this master
      for (const [requestId, relay] of this.pendingRelays) {
        if (relay.masterAgentId === agentDbId) {
          clearTimeout(relay.timeout);
          relay.reject(new Error('Master session disconnected'));
          this.pendingRelays.delete(requestId);
        }
      }
    }
  }

  /**
   * Check if an agent is registered as a master
   */
  isMaster(agentDbId: string): boolean {
    return this.masterSessions.has(agentDbId);
  }

  /**
   * Get list of agents accessible to a master controller
   * Returns agents within the same customer scope
   */
  async getAccessibleAgents(masterAgentId: string): Promise<Array<{
    agentId: string;
    name: string;
    osType: string;
    status: string;
    powerState: string;
    lastSeenAt: Date;
  }>> {
    const session = this.masterSessions.get(masterAgentId);
    if (!session) {
      throw new Error('Master session not found');
    }

    // Get all agents within the same owner scope
    const agents = await prisma.agent.findMany({
      where: {
        ownerUserId: session.customerId,
        id: { not: masterAgentId }, // Exclude self
      },
      select: {
        id: true,
        hostname: true,
        displayName: true,
        osType: true,
        status: true,
        powerState: true,
        lastSeenAt: true,
      },
    });

    return agents.map((a) => ({
      agentId: a.id,
      name: a.displayName || a.hostname || 'Unknown',
      osType: a.osType,
      status: a.status,
      powerState: a.powerState,
      lastSeenAt: a.lastSeenAt,
    }));
  }

  /**
   * Relay a command from master agent to target agent
   */
  async relayCommand(
    masterAgentId: string,
    targetAgentId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.masterSessions.get(masterAgentId);
    if (!session) {
      throw new Error('Master session not found');
    }

    // Verify target agent is accessible (same owner)
    const targetAgent = await prisma.agent.findUnique({
      where: { id: targetAgentId },
      select: { ownerUserId: true, hostname: true },
    });

    if (!targetAgent) {
      throw new Error(`Target agent not found: ${targetAgentId}`);
    }

    if (targetAgent.ownerUserId !== session.customerId) {
      throw new Error('Access denied: target agent is not in the same owner scope');
    }

    // Check if target is connected
    const connectedTarget = agentRegistry.getAgent(targetAgentId);
    if (!connectedTarget) {
      throw new Error(`Target agent not connected: ${targetAgentId}`);
    }

    const requestId = uuidv4();

    console.log(
      `[MasterSession] Relaying command from ${masterAgentId} to ${targetAgentId}: ${method}`
    );

    // Send command to target agent and wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRelays.delete(requestId);
        reject(new Error('Relay command timeout'));
      }, 120000); // 2 minute timeout

      const relay: RelayRequest = {
        id: requestId,
        masterAgentId,
        targetAgentId,
        method,
        params,
        createdAt: new Date(),
        timeout,
        resolve,
        reject,
      };

      this.pendingRelays.set(requestId, relay);

      // Send the actual command through agent registry
      agentRegistry
        .sendCommand(targetAgentId, method, params)
        .then((result) => {
          clearTimeout(timeout);
          this.pendingRelays.delete(requestId);
          session.lastActivity = new Date();
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timeout);
          this.pendingRelays.delete(requestId);
          reject(err);
        });
    });
  }

  /**
   * Get all active master sessions
   */
  getActiveSessions(): Array<{
    agentId: string;
    customerId: string;
    registeredAt: Date;
    lastActivity: Date;
  }> {
    return Array.from(this.masterSessions.values()).map((s) => ({
      agentId: s.agentId,
      customerId: s.customerId,
      registeredAt: s.registeredAt,
      lastActivity: s.lastActivity,
    }));
  }

  /**
   * Get stats about master sessions
   */
  getStats(): {
    totalSessions: number;
    pendingRelays: number;
    sessionsByCustomer: Record<string, number>;
  } {
    const sessionsByCustomer: Record<string, number> = {};

    for (const session of this.masterSessions.values()) {
      sessionsByCustomer[session.customerId] =
        (sessionsByCustomer[session.customerId] || 0) + 1;
    }

    return {
      totalSessions: this.masterSessions.size,
      pendingRelays: this.pendingRelays.size,
      sessionsByCustomer,
    };
  }

  /**
   * Cleanup stale sessions
   */
  cleanup(): void {
    const staleThreshold = Date.now() - 30 * 60 * 1000; // 30 minutes

    for (const [agentId, session] of this.masterSessions) {
      if (session.lastActivity.getTime() < staleThreshold) {
        // Check if socket is still open
        if (session.socket.readyState !== WebSocket.OPEN) {
          this.unregisterMasterSession(agentId);
        }
      }
    }

    console.log(`[MasterSession] Cleanup complete. Active sessions: ${this.masterSessions.size}`);
  }
}

// Singleton instance
const globalForMasterSession = globalThis as unknown as {
  masterSessionManager: MasterSessionManager | undefined;
};

export const masterSessionManager =
  globalForMasterSession.masterSessionManager ?? new MasterSessionManager();

globalForMasterSession.masterSessionManager = masterSessionManager;

export { MasterSessionManager };
