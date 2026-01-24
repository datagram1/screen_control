/**
 * Agent Registry
 *
 * Manages connected agents in memory with database persistence.
 * This is the "local" implementation - for horizontal scaling,
 * a Redis-based implementation would replace this.
 */

import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import {
  ConnectedAgent,
  AgentMessage,
  CommandMessage,
  IAgentRegistry,
  OSType,
  MCPTool,
  MCPResource,
  MCPPrompt,
} from './types';
import { NetworkUtils } from './network';
import { broadcastMCPNotification } from '../mcp-sse-manager';
import { prisma } from '../prisma';
import {
  findOrCreateAgent,
  markAgentOnline,
  markAgentOffline,
  updateAgentHeartbeat,
  logCommand,
  updateCommandLog,
  checkCommandPreConditions,
  getAgentSchedule,
  getAgentsNeedingScheduleUpdate,
  ScheduleInfo,
  getAgentsWithLicenseChanges,
  LicenseValidationResult,
} from './db-service';

// Command queue entry for sleeping agents (1.2.18)
interface QueuedCommand {
  id: string;
  method: string;
  params: Record<string, unknown>;
  context?: { aiConnectionId?: string; ipAddress?: string };
  queuedAt: Date;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class LocalAgentRegistry implements IAgentRegistry {
  private agents = new Map<string, ConnectedAgent>();
  private agentsByMachineId = new Map<string, string>(); // machineId -> agentId
  private agentsByDbId = new Map<string, string>(); // dbId -> connectionId
  private sessionIds = new Map<string, string>(); // connectionId -> sessionId
  private commandQueue = new Map<string, QueuedCommand[]>(); // agentId -> queued commands (1.2.18)
  private scheduleCheckTimer: NodeJS.Timeout | null = null;
  private licenseCheckTimer: NodeJS.Timeout | null = null; // I.2.2

  constructor() {
    // Start periodic schedule checker (runs every minute)
    this.startScheduleChecker();
    // Start periodic license checker (runs every 5 minutes)
    this.startLicenseChecker();
  }

  /**
   * Start periodic schedule checker (I.2.1)
   */
  private startScheduleChecker(): void {
    // Check every minute for schedule transitions
    this.scheduleCheckTimer = setInterval(() => {
      this.checkScheduleTransitions().catch(err => {
        console.error('[Registry] Schedule check error:', err);
      });
    }, 60000); // 1 minute

    console.log('[Registry] Schedule checker started (60s interval)');
  }

  /**
   * Check for schedule-based power state transitions (I.2.1)
   */
  private async checkScheduleTransitions(): Promise<void> {
    try {
      const updates = await getAgentsNeedingScheduleUpdate();

      for (const update of updates) {
        const connectionId = this.agentsByDbId.get(update.agentDbId);
        if (!connectionId) continue;

        const agent = this.agents.get(connectionId);
        if (!agent) continue;

        // TEMPORARY: Force ACTIVE power state (ignoring schedule)
        const forcedPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP' = 'ACTIVE';

        // Send config update
        this.sendConfigUpdate(agent, {
          heartbeatInterval: update.heartbeatInterval,
          powerState: forcedPowerState,
        });

        // Update local state
        agent.powerState = forcedPowerState;

        console.log(
          `[Registry] Schedule transition for ${agent.machineName || agent.machineId}: ` +
          `${update.currentPowerState} -> ${update.desiredPowerState}`
        );
      }
    } catch (err) {
      console.error('[Registry] Failed to check schedule transitions:', err);
    }
  }

  /**
   * Start periodic license checker (I.2.2)
   */
  private startLicenseChecker(): void {
    // Check every 5 minutes for license validity
    this.licenseCheckTimer = setInterval(() => {
      this.checkLicenseValidity().catch(err => {
        console.error('[Registry] License check error:', err);
      });
    }, 300000); // 5 minutes

    console.log('[Registry] License checker started (5m interval)');
  }

  /**
   * Check license validity for all connected agents (I.2.2)
   */
  private async checkLicenseValidity(): Promise<void> {
    try {
      const updates = await getAgentsWithLicenseChanges();

      for (const update of updates) {
        const connectionId = this.agentsByDbId.get(update.agentDbId);
        if (!connectionId) continue;

        const agent = this.agents.get(connectionId);
        if (!agent) continue;

        // Handle license expiry mid-session (I.2.3)
        await this.handleLicenseStateChange(agent, update);
      }

      if (updates.length > 0) {
        console.log(`[Registry] License check: ${updates.length} agents with state changes`);
      }
    } catch (err) {
      console.error('[Registry] Failed to check license validity:', err);
    }
  }

  /**
   * Handle license state change for an agent (I.2.3)
   */
  private async handleLicenseStateChange(
    agent: ConnectedAgent,
    update: LicenseValidationResult
  ): Promise<void> {
    const previousState = agent.state;
    agent.state = update.newState;
    agent.licenseStatus = this.mapStateToLicenseStatus(update.newState);

    console.log(
      `[Registry] License state change for ${agent.machineName || agent.machineId}: ` +
      `${previousState} -> ${update.newState} (${update.reason})`
    );

    // Send notification to agent about state change
    if (agent.socket.readyState === WebSocket.OPEN) {
      const message: CommandMessage = {
        type: 'command',
        id: uuidv4(),
        method: 'license_state_change',
        params: {
          newState: update.newState,
          reason: update.reason,
          // For EXPIRED/BLOCKED, we allow graceful shutdown
          // Agent should complete current task, then enter degraded mode
          gracePeriodMs: update.newState === 'BLOCKED' ? 0 : 60000, // 1 minute grace for EXPIRED
        },
      };

      try {
        agent.socket.send(JSON.stringify(message));
      } catch (err) {
        console.error(`[Registry] Failed to notify agent of license change:`, err);
      }
    }

    // For BLOCKED state, optionally disconnect after grace period
    if (update.newState === 'BLOCKED') {
      // Schedule disconnect after 30 seconds (allow agent to acknowledge)
      setTimeout(() => {
        if (agent.socket.readyState === WebSocket.OPEN && agent.state === 'BLOCKED') {
          console.log(`[Registry] Disconnecting blocked agent: ${agent.machineName || agent.machineId}`);
          agent.socket.close(4003, 'License blocked');
        }
      }, 120000); // Increased timeout for large responses like screenshots
    }
  }

  /**
   * Map agent state to license status
   */
  private mapStateToLicenseStatus(
    state: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'BLOCKED'
  ): 'active' | 'pending' | 'expired' | 'blocked' {
    switch (state) {
      case 'ACTIVE':
        return 'active';
      case 'PENDING':
        return 'pending';
      case 'EXPIRED':
        return 'expired';
      case 'BLOCKED':
        return 'blocked';
    }
  }

  /**
   * Register a new agent connection
   */
  async register(
    socket: WebSocket,
    msg: AgentMessage,
    remoteAddress: string
  ): Promise<ConnectedAgent | null> {
    // Validate required fields
    if (!msg.machineId) {
      console.error('[Registry] Registration failed: missing machineId');
      return null;
    }

    const isInternal = NetworkUtils.isInternalIP(remoteAddress);
    const connectionId = uuidv4();

    // Check for existing connection from same machine
    // IMPORTANT: Always accept new connections and close old ones.
    // Through Apache proxy, connections can die silently (no TCP RST), so the agent
    // may reconnect before the server detects the old connection is dead.
    // Rejecting duplicates causes connection loops in this scenario.
    const existingConnectionId = this.agentsByMachineId.get(msg.machineId);
    if (existingConnectionId) {
      const existingAgent = this.agents.get(existingConnectionId);
      if (existingAgent) {
        const socketIsOpen = existingAgent.socket.readyState === 1;
        const socketState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][existingAgent.socket.readyState] || 'UNKNOWN';
        const agentName = existingAgent.machineName || existingAgent.machineId;
        const timeSinceLastPing = Date.now() - existingAgent.lastPing.getTime();

        console.log(`[Registry] Replacing connection for ${agentName}:`, {
          oldConnectionId: existingConnectionId.substring(0, 8) + '...',
          newConnectionId: connectionId.substring(0, 8) + '...',
          socketState,
          timeSinceLastPing: `${timeSinceLastPing}ms`,
          remoteAddress: existingAgent.remoteAddress || 'unknown',
        });

        if (socketIsOpen) {
          try {
            existingAgent.socket.close(1000, 'New connection from same machine');
          } catch (e) {
            console.warn(`[Registry] Error closing old socket for ${agentName}:`, e);
          }
        }
        await this.unregister(existingConnectionId);
      }
    }

    // Parse OS type
    let osType: OSType = 'MACOS';
    if (msg.osType) {
      const osLower = msg.osType.toLowerCase();
      if (osLower.includes('windows') || osLower === 'win32') {
        osType = 'WINDOWS';
      } else if (osLower.includes('linux')) {
        osType = 'LINUX';
      }
    }

    // Database: Find or create agent record
    let dbResult: {
      agentDbId: string;
      licenseStatus: 'active' | 'pending' | 'expired' | 'blocked';
      licenseUuid: string | null;
      isNew: boolean;
      secretError?: string;
    };

    try {
      dbResult = await findOrCreateAgent(msg, remoteAddress);

      // Check for agent secret validation failure
      if (dbResult.secretError) {
        console.error(`[Registry] Agent secret validation failed: ${dbResult.secretError}`);
        socket.send(JSON.stringify({
          type: 'error',
          code: 'INVALID_AGENT_SECRET',
          message: dbResult.secretError,
        }));
        socket.close(4001, 'Agent secret validation failed');
        return null;
      }
    } catch (err) {
      console.error('[Registry] Database error during registration:', err);
      // Continue without DB persistence for now
      dbResult = {
        agentDbId: connectionId,
        licenseStatus: 'pending',
        licenseUuid: null,
        isNew: true,
      };
    }

    // Map license status to agent state
    const state = this.mapLicenseStatusToState(dbResult.licenseStatus);

    const agent: ConnectedAgent = {
      id: connectionId,
      dbId: dbResult.agentDbId,
      socket,
      remoteAddress,
      isInternal,

      customerId: msg.customerId,
      licenseUuid: dbResult.licenseUuid || msg.licenseUuid,
      machineId: msg.machineId,
      machineName: msg.machineName || msg.fingerprint?.hostname,

      osType,
      osVersion: msg.osVersion,
      arch: msg.arch,
      agentVersion: msg.agentVersion,

      fingerprint: msg.fingerprint ? this.computeFingerprint(msg.fingerprint) : undefined,
      fingerprintRaw: msg.fingerprint,

      state,
      licenseStatus: dbResult.licenseStatus,
      powerState: 'ACTIVE',
      isScreenLocked: false,
      hasDisplay: msg.hasDisplay !== false, // Default to true, only false if explicitly set

      connectedAt: new Date(),
      lastPing: new Date(),
      lastActivity: new Date(),

      pendingRequests: new Map(),
    };

    // Store in memory indexes
    this.agents.set(connectionId, agent);
    if (msg.machineId) {
      this.agentsByMachineId.set(msg.machineId, connectionId);
    }
    this.agentsByDbId.set(dbResult.agentDbId, connectionId);

    // Database: Mark agent online and create session
    try {
      const sessionId = await markAgentOnline(dbResult.agentDbId, {
        ipAddress: remoteAddress,
        powerState: 'ACTIVE',
      });
      this.sessionIds.set(connectionId, sessionId);
    } catch (err) {
      console.error('[Registry] Failed to create session:', err);
    }

    console.log(
      `[Registry] Agent registered: ${agent.machineName || agent.machineId} ` +
      `(${agent.osType}) from ${remoteAddress} ` +
      `[${isInternal ? 'INTERNAL' : 'EXTERNAL'}] ` +
      `[${agent.state}] [${dbResult.isNew ? 'NEW' : 'EXISTING'}]`
    );

    // Fetch agent capabilities asynchronously (don't block registration)
    this.fetchAgentCapabilities(agent.id).catch(err => {
      console.error(`[Registry] Failed to fetch capabilities for ${agent.machineName}:`, err);
    });

    // Apply schedule-based power state (I.2.1)
    this.applyScheduleToAgent(agent).catch(err => {
      console.error(`[Registry] Failed to apply schedule for ${agent.machineName}:`, err);
    });

    return agent;
  }

  /**
   * Apply schedule-based power state to an agent (I.2.1)
   *
   * NOTE: Currently forcing all agents to ACTIVE to troubleshoot communication issues.
   * Schedule-based power states will be re-enabled later.
   */
  private async applyScheduleToAgent(agent: ConnectedAgent): Promise<void> {
    if (!agent.dbId) return;

    try {
      const schedule = await getAgentSchedule(agent.dbId);
      if (!schedule) return;

      // TEMPORARY: Force ACTIVE power state for all agents (ignoring schedule)
      const forcedPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP' = 'ACTIVE';

      // Send config update with ACTIVE power state
      this.sendConfigUpdate(agent, {
        heartbeatInterval: schedule.heartbeatInterval,
        powerState: forcedPowerState,
      });

      // Update local state
      agent.powerState = forcedPowerState;

      console.log(
        `[Registry] Applied schedule to ${agent.machineName || agent.machineId}: ` +
        `FORCED ACTIVE (schedule would be: ${schedule.scheduleMode} -> ${schedule.desiredPowerState})`
      );
    } catch (err) {
      console.error(`[Registry] Failed to get schedule for agent ${agent.id}:`, err);
    }
  }

  /**
   * Send config update to agent
   */
  private sendConfigUpdate(
    agent: ConnectedAgent,
    config: { heartbeatInterval?: number; powerState?: 'ACTIVE' | 'PASSIVE' | 'SLEEP' }
  ): void {
    if (agent.socket.readyState !== WebSocket.OPEN) return;

    const message: CommandMessage = {
      type: 'config',
      id: uuidv4(),
      config,
    };

    try {
      agent.socket.send(JSON.stringify(message));
    } catch (err) {
      console.error(`[Registry] Failed to send config to ${agent.id}:`, err);
    }
  }

  /**
   * Fetch and cache agent capabilities (tools, resources, prompts)
   */
  async fetchAgentCapabilities(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      // Fetch tools
      const toolsResult = await this.sendCommand(agentId, 'tools/list', {});
      if (toolsResult && typeof toolsResult === 'object' && 'tools' in toolsResult) {
        const newTools = (toolsResult as { tools: MCPTool[] }).tools || [];
        const hadPreviousTools = Array.isArray(agent.tools) && agent.tools.length > 0;
        const previousTools = agent.tools || [];

        const previousNames = new Set(previousTools.map(t => t.name));
        const newNames = new Set(newTools.map(t => t.name));

        const added = newTools.filter(t => !previousNames.has(t.name)).map(t => t.name);
        const removed = previousTools.filter(t => !newNames.has(t.name)).map(t => t.name);

        const hasChanged = added.length > 0 || removed.length > 0 || !hadPreviousTools;

        agent.tools = newTools;
        agent.toolsFetchedAt = new Date();

        console.log(
          `[Registry] Cached ${agent.tools.length} tools for ${agent.machineName || agent.machineId} ` +
          `(added: ${added.length}, removed: ${removed.length})`
        );

        if (hasChanged) {
          console.log('[Registry] Tool set changed, broadcasting tools/list_changed to MCP clients', {
            added: added.slice(0, 10),
            removed: removed.slice(0, 10),
          });

          // Broadcast MCP notification to all connected clients
          try {
            const mcpConnections = await prisma.mcpConnection.findMany({
              where: { status: 'ACTIVE' },
            });
            console.log(`[Registry] Found ${mcpConnections.length} active MCP connections`);
            for (const conn of mcpConnections) {
              broadcastMCPNotification(conn.endpointUuid, 'notifications/tools/list_changed');
            }
          } catch (error) {
            console.error('[Registry] Failed to broadcast tool changes:', error);
          }
        } else {
          console.log('[Registry] Tool set unchanged; skipping broadcast');
        }
      }

      // Fetch resources (optional, agent may not support)
      try {
        const resourcesResult = await this.sendCommand(agentId, 'resources/list', {});
        if (resourcesResult && typeof resourcesResult === 'object' && 'resources' in resourcesResult) {
          agent.resources = (resourcesResult as { resources: MCPResource[] }).resources || [];
        }
      } catch {
        // Resources not supported - that's fine
        agent.resources = [];
      }

      // Fetch prompts (optional, agent may not support)
      try {
        const promptsResult = await this.sendCommand(agentId, 'prompts/list', {});
        if (promptsResult && typeof promptsResult === 'object' && 'prompts' in promptsResult) {
          agent.prompts = (promptsResult as { prompts: MCPPrompt[] }).prompts || [];
        }
      } catch {
        // Prompts not supported - that's fine
        agent.prompts = [];
      }
    } catch (err) {
      console.error(`[Registry] Failed to fetch tools for ${agent.machineName}:`, err);
      // Don't fail registration, just leave tools undefined
    }
  }

  /**
   * Refresh capabilities for all connected agents
   */
  async refreshAllCapabilities(): Promise<void> {
    const agents = Array.from(this.agents.values());
    await Promise.allSettled(
      agents.map(agent => this.fetchAgentCapabilities(agent.id))
    );
  }

  /**
   * Unregister an agent connection
   */
  async unregister(connectionId: string): Promise<void> {
    const agent = this.agents.get(connectionId);
    if (!agent) return;

    // Cancel all pending requests
    for (const [, pending] of agent.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Agent disconnected'));
    }

    // Database: Mark agent offline
    if (agent.dbId) {
      try {
        const sessionId = this.sessionIds.get(connectionId);
        await markAgentOffline(agent.dbId, sessionId);
      } catch (err) {
        console.error('[Registry] Failed to mark agent offline:', err);
      }
    }

    // Remove from indexes
    if (agent.machineId) {
      this.agentsByMachineId.delete(agent.machineId);
    }
    if (agent.dbId) {
      this.agentsByDbId.delete(agent.dbId);
    }
    this.sessionIds.delete(connectionId);
    this.agents.delete(connectionId);

    console.log(`[Registry] Agent unregistered: ${agent.machineName || agent.machineId}`);
  }

  /**
   * Get an agent by connection ID or database ID
   */
  getAgent(agentId: string): ConnectedAgent | undefined {
    // Try connection ID first
    let agent = this.agents.get(agentId);
    if (agent) return agent;

    // Try database ID
    const connectionId = this.agentsByDbId.get(agentId);
    if (connectionId) {
      return this.agents.get(connectionId);
    }

    // Debug: Log why agent not found
    console.log(`[Registry] getAgent failed for ${agentId}:`, {
      inAgentsMap: this.agents.has(agentId),
      inDbIdMap: this.agentsByDbId.has(agentId),
      agentsMapSize: this.agents.size,
      dbIdMapSize: this.agentsByDbId.size,
      dbIdMapKeys: Array.from(this.agentsByDbId.keys()),
    });

    return undefined;
  }

  /**
   * Get an agent by database ID
   */
  getAgentByDbId(dbId: string): ConnectedAgent | undefined {
    const connectionId = this.agentsByDbId.get(dbId);
    return connectionId ? this.agents.get(connectionId) : undefined;
  }

  /**
   * Get an agent by machine ID
   */
  getAgentByMachineId(machineId: string): ConnectedAgent | undefined {
    const agentId = this.agentsByMachineId.get(machineId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  /**
   * Get all agents for a customer
   */
  getAgentsByCustomerId(customerId: string): ConnectedAgent[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.customerId === customerId
    );
  }

  /**
   * Get all connected agents
   */
  getAllAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get aggregated tools from all connected agents
   * Tools are prefixed with agent name to avoid conflicts
   */
  getAggregatedTools(): Array<MCPTool & { agentId: string; agentName: string }> {
    const aggregatedTools: Array<MCPTool & { agentId: string; agentName: string }> = [];

    for (const agent of this.agents.values()) {
      if (!agent.tools || agent.state !== 'ACTIVE') continue;

      const agentName = agent.machineName || agent.machineId || agent.id;

      for (const tool of agent.tools) {
        aggregatedTools.push({
          ...tool,
          name: `${agentName}__${tool.name}`,
          description: `[${agentName}] ${tool.description || ''}`,
          agentId: agent.id,
          agentName,
        });
      }
    }

    return aggregatedTools;
  }

  /**
   * Get aggregated tools from database definitions (new architecture)
   * Uses server-side tool definitions instead of querying agents
   */
  async getAggregatedToolsFromDB(): Promise<Array<MCPTool & { agentId: string; agentName: string }>> {
    const { getToolsForAgent } = await import('./tool-service');
    const aggregatedTools: Array<MCPTool & { agentId: string; agentName: string }> = [];

    for (const agent of this.agents.values()) {
      if (agent.state !== 'ACTIVE' || !agent.dbId) continue;

      const agentName = agent.machineName || agent.machineId || agent.id;

      try {
        const tools = await getToolsForAgent(agent.dbId);

        for (const tool of tools) {
          aggregatedTools.push({
            name: `${agentName}__${tool.name}`,
            description: `[${agentName}] ${tool.description || ''}`,
            inputSchema: tool.inputSchema,
            agentId: agent.id,
            agentName,
          });
        }
      } catch (err) {
        console.error(`[Registry] Failed to get DB tools for ${agentName}:`, err);
        // Fallback to cached tools
        if (agent.tools) {
          for (const tool of agent.tools) {
            aggregatedTools.push({
              ...tool,
              name: `${agentName}__${tool.name}`,
              description: `[${agentName}] ${tool.description || ''}`,
              agentId: agent.id,
              agentName,
            });
          }
        }
      }
    }

    return aggregatedTools;
  }

  /**
   * Get aggregated resources from all connected agents
   */
  getAggregatedResources(): Array<MCPResource & { agentId: string; agentName: string }> {
    const aggregatedResources: Array<MCPResource & { agentId: string; agentName: string }> = [];

    for (const agent of this.agents.values()) {
      if (!agent.resources || agent.state !== 'ACTIVE') continue;

      const agentName = agent.machineName || agent.machineId || agent.id;

      for (const resource of agent.resources) {
        aggregatedResources.push({
          ...resource,
          uri: `${agentName}://${resource.uri}`,
          name: `[${agentName}] ${resource.name}`,
          agentId: agent.id,
          agentName,
        });
      }
    }

    return aggregatedResources;
  }

  /**
   * Get aggregated prompts from all connected agents
   */
  getAggregatedPrompts(): Array<MCPPrompt & { agentId: string; agentName: string }> {
    const aggregatedPrompts: Array<MCPPrompt & { agentId: string; agentName: string }> = [];

    for (const agent of this.agents.values()) {
      if (!agent.prompts || agent.state !== 'ACTIVE') continue;

      const agentName = agent.machineName || agent.machineId || agent.id;

      for (const prompt of agent.prompts) {
        aggregatedPrompts.push({
          ...prompt,
          name: `${agentName}__${prompt.name}`,
          description: `[${agentName}] ${prompt.description || ''}`,
          agentId: agent.id,
          agentName,
        });
      }
    }

    return aggregatedPrompts;
  }

  /**
   * Find agent by tool name prefix (agentName__toolName)
   */
  findAgentByToolPrefix(prefixedToolName: string): { agent: ConnectedAgent; toolName: string } | null {
    const match = prefixedToolName.match(/^(.+?)__(.+)$/);
    if (!match) return null;

    const [, agentName, toolName] = match;

    for (const agent of this.agents.values()) {
      if (agent.machineName === agentName || agent.machineId === agentName || agent.id === agentName) {
        return { agent, toolName };
      }
    }

    return null;
  }

  /**
   * Find agent by WebSocket
   */
  findAgentBySocket(socket: WebSocket): ConnectedAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.socket === socket) return agent;
    }
    return undefined;
  }

  /**
   * Send a command to an agent and wait for response
   */
  async sendCommand(
    agentId: string,
    method: string,
    params: Record<string, unknown> = {},
    context?: { aiConnectionId?: string; ipAddress?: string }
  ): Promise<unknown> {
    const agent = this.getAgent(agentId);
    if (!agent) {
      console.error('[Registry] sendCommand failed: agent not found', { agentId, method });
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Pre-condition checks (1.2.6)
    if (agent.dbId) {
      try {
        const preCheck = await checkCommandPreConditions(agent.dbId, method);
        if (!preCheck.allowed) {
          throw new Error(`Command blocked: ${preCheck.reason}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Command blocked:')) {
          throw err;
        }
        console.error('[Registry] Pre-condition check error:', err);
        // Continue anyway if DB check fails
      }
    }

    // If agent is sleeping, queue the command (1.2.18)
    if (agent.powerState === 'SLEEP') {
      console.log(`[Registry] Agent ${agentId} is sleeping, queueing command: ${method}`);
      return this.queueCommand(agentId, method, params, context);
    }

    if (agent.socket.readyState !== WebSocket.OPEN) {
      console.error('[Registry] sendCommand failed: socket not open', {
        agentId,
        agentName: agent.machineName || agent.machineId,
        readyState: agent.socket.readyState,
        readyStateLabel: this.describeSocketState(agent.socket.readyState),
        lastPing: agent.lastPing?.toISOString(),
      });
      throw new Error(`Agent not connected: ${agentId}`);
    }

    const requestId = uuidv4();
    const message: CommandMessage = {
      type: 'request',
      id: requestId,
      method,
      params,
    };

    // Database: Log the command
    let commandLogId: string | undefined;
    if (agent.dbId) {
      try {
        commandLogId = await logCommand({
          agentId: agent.dbId,
          aiConnectionId: context?.aiConnectionId,
          method,
          params,
          toolName: method === 'tools/call' ? (params.name as string) : undefined,
          ipAddress: context?.ipAddress,
        });
      } catch (err) {
        console.error('[Registry] Failed to log command:', err);
      }
    }

    console.log('[Registry] Sending command to agent', {
      agentId,
      agentName: agent.machineName || agent.machineId,
      method,
      requestId,
      readyState: this.describeSocketState(agent.socket.readyState),
    });

    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(async () => {
        agent.pendingRequests.delete(requestId);

        // Database: Update command log with timeout
        if (commandLogId) {
          try {
            await updateCommandLog(commandLogId, { status: 'TIMEOUT' });
          } catch (err) {
            console.error('[Registry] Failed to update command log:', err);
          }
        }

        console.error('[Registry] Command timeout', {
          agentId,
          agentName: agent.machineName || agent.machineId,
          method,
          requestId,
          durationMs: Date.now() - startedAt,
        });

        reject(new Error('Request timeout'));
      }, 120000); // Increased timeout for large responses like screenshots

      agent.pendingRequests.set(requestId, {
        resolve: async (result: unknown) => {
          // Database: Update command log with success
          if (commandLogId) {
            try {
              await updateCommandLog(commandLogId, {
                status: 'COMPLETED',
                result,
              });
            } catch (err) {
              console.error('[Registry] Failed to update command log:', err);
            }
          }
          console.log('[Registry] Command success', {
            agentId,
            agentName: agent.machineName || agent.machineId,
            method,
            requestId,
            durationMs: Date.now() - startedAt,
          });
          resolve(result);
        },
        reject: async (error: Error) => {
          // Database: Update command log with failure
          if (commandLogId) {
            try {
              await updateCommandLog(commandLogId, {
                status: 'FAILED',
                errorMessage: error.message,
              });
            } catch (err) {
              console.error('[Registry] Failed to update command log:', err);
            }
          }
          console.error('[Registry] Command failed', {
            agentId,
            agentName: agent.machineName || agent.machineId,
            method,
            requestId,
            durationMs: Date.now() - startedAt,
            error: error.message,
          });
          reject(error);
        },
        timeout,
        startedAt: new Date(),
      });

      try {
        agent.socket.send(JSON.stringify(message));
      } catch (err: any) {
        clearTimeout(timeout);
        agent.pendingRequests.delete(requestId);
        const sendErr = err instanceof Error ? err.message : String(err);
        console.error('[Registry] Failed to send command to agent', {
          agentId,
          agentName: agent.machineName || agent.machineId,
          method,
          requestId,
          error: sendErr,
        });
        reject(new Error(`Send failed: ${sendErr}`));
      }
    });
  }

  /**
   * Queue a command for a sleeping agent (1.2.18)
   */
  private queueCommand(
    agentId: string,
    method: string,
    params: Record<string, unknown>,
    context?: { aiConnectionId?: string; ipAddress?: string }
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const commandId = uuidv4();

      // 5 minute timeout for queued commands
      const timeout = setTimeout(() => {
        this.removeQueuedCommand(agentId, commandId);
        reject(new Error('Queued command timeout - agent did not wake'));
      }, 300000);

      const queuedCommand: QueuedCommand = {
        id: commandId,
        method,
        params,
        context,
        queuedAt: new Date(),
        resolve,
        reject,
        timeout,
      };

      const queue = this.commandQueue.get(agentId) || [];
      queue.push(queuedCommand);
      this.commandQueue.set(agentId, queue);

      console.log(`[Registry] Queued command ${commandId} for agent ${agentId}: ${method}`);
    });
  }

  /**
   * Remove a queued command
   */
  private removeQueuedCommand(agentId: string, commandId: string): void {
    const queue = this.commandQueue.get(agentId);
    if (queue) {
      const index = queue.findIndex((c) => c.id === commandId);
      if (index !== -1) {
        clearTimeout(queue[index].timeout);
        queue.splice(index, 1);
        if (queue.length === 0) {
          this.commandQueue.delete(agentId);
        }
      }
    }
  }

  /**
   * Check if agent has pending queued commands (1.2.19)
   */
  hasPendingQueuedCommands(agentId: string): boolean {
    const queue = this.commandQueue.get(agentId);
    return queue !== undefined && queue.length > 0;
  }

  /**
   * Process queued commands when agent wakes up
   */
  async processQueuedCommands(agentId: string): Promise<void> {
    const queue = this.commandQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    console.log(`[Registry] Processing ${queue.length} queued commands for agent ${agentId}`);

    // Process commands in order
    const commands = [...queue];
    this.commandQueue.delete(agentId);

    for (const cmd of commands) {
      clearTimeout(cmd.timeout);
      try {
        const result = await this.sendCommand(agentId, cmd.method, cmd.params, cmd.context);
        cmd.resolve(result);
      } catch (err) {
        cmd.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Handle response from agent
   */
  handleResponse(agent: ConnectedAgent, msg: AgentMessage): void {
    if (!msg.id) return;

    const pending = agent.pendingRequests.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    agent.pendingRequests.delete(msg.id);

    if (msg.type === 'error') {
      console.warn('[Registry] Agent returned error', {
        agentId: agent.id,
        agentName: agent.machineName || agent.machineId,
        requestId: msg.id,
        error: msg.error,
      });
      pending.reject(new Error(msg.error || 'Unknown error'));
    } else {
      console.log("[Registry] Resolving response", { agentId: agent.id, resultType: typeof msg.result, resultKeys: msg.result && typeof msg.result === "object" ? Object.keys(msg.result as object) : [], hasImage: !!(msg.result as any)?.image, resultSize: JSON.stringify(msg.result || {}).length }); pending.resolve(msg.result);
    }
  }

  /**
   * Update agent's last ping time
   */
  updatePing(agent: ConnectedAgent): void {
    agent.lastPing = new Date();
  }

  private describeSocketState(state: number): string {
    switch (state) {
      case WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return `UNKNOWN(${state})`;
    }
  }

  /**
   * Update agent state
   */
  async updateState(agent: ConnectedAgent, state: Partial<ConnectedAgent>): Promise<void> {
    Object.assign(agent, state);
    agent.lastActivity = new Date();

    // Database: Update heartbeat
    if (agent.dbId) {
      try {
        await updateAgentHeartbeat(agent.dbId, {
          powerState: state.powerState || agent.powerState,
          isScreenLocked: state.isScreenLocked ?? agent.isScreenLocked,
          hasDisplay: state.hasDisplay ?? agent.hasDisplay,
          currentTask: state.currentTask,
        });
      } catch (err) {
        console.error('[Registry] Failed to update agent heartbeat:', err);
      }
    }
  }

  /**
   * Cleanup all connections
   */
  async cleanup(): Promise<void> {
    // Stop periodic timers
    if (this.scheduleCheckTimer) {
      clearInterval(this.scheduleCheckTimer);
      this.scheduleCheckTimer = null;
      console.log('[Registry] Schedule checker stopped');
    }
    if (this.licenseCheckTimer) {
      clearInterval(this.licenseCheckTimer);
      this.licenseCheckTimer = null;
      console.log('[Registry] License checker stopped');
    }

    const promises: Promise<void>[] = [];

    for (const [id, agent] of this.agents) {
      for (const [, pending] of agent.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Server shutting down'));
      }
      agent.socket.close(1000, 'Server shutting down');

      // Mark offline in database
      if (agent.dbId) {
        const sessionId = this.sessionIds.get(id);
        promises.push(
          markAgentOffline(agent.dbId, sessionId).catch((err) =>
            console.error('[Registry] Failed to mark agent offline:', err)
          )
        );
      }

      this.agents.delete(id);
    }

    await Promise.all(promises);

    this.agentsByMachineId.clear();
    this.agentsByDbId.clear();
    this.sessionIds.clear();

    console.log('[Registry] All agents cleaned up');
  }

  /**
   * Compute fingerprint hash from raw fingerprint data
   */
  private computeFingerprint(data: ConnectedAgent['fingerprintRaw']): string {
    if (!data) return '';

    const parts = [
      data.cpuModel || '',
      data.diskSerial || '',
      data.motherboardUuid || '',
      ...(data.macAddresses || []).sort(),
    ].filter(Boolean);

    if (parts.length === 0) return '';

    return crypto
      .createHash('sha256')
      .update(parts.join('|'))
      .digest('hex');
  }

  /**
   * Map license status to agent state
   */
  private mapLicenseStatusToState(
    status: 'active' | 'pending' | 'expired' | 'blocked'
  ): ConnectedAgent['state'] {
    switch (status) {
      case 'active':
        return 'ACTIVE';
      case 'expired':
        return 'EXPIRED';
      case 'blocked':
        return 'BLOCKED';
      default:
        return 'PENDING';
    }
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnected: number;
    byState: Record<string, number>;
    byPowerState: Record<string, number>;
    byOS: Record<string, number>;
  } {
    const stats = {
      totalConnected: this.agents.size,
      byState: {} as Record<string, number>,
      byPowerState: {} as Record<string, number>,
      byOS: {} as Record<string, number>,
    };

    for (const agent of this.agents.values()) {
      stats.byState[agent.state] = (stats.byState[agent.state] || 0) + 1;
      stats.byPowerState[agent.powerState] = (stats.byPowerState[agent.powerState] || 0) + 1;
      stats.byOS[agent.osType] = (stats.byOS[agent.osType] || 0) + 1;
    }

    return stats;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Wake Broadcasts (1.2.12, 1.2.13)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Broadcast wake signal to all sleeping agents (1.2.12)
   * Called when user logs into portal or AI connects
   */
  broadcastWake(reason: 'portal_login' | 'ai_connection', customerId?: string): number {
    let wokenCount = 0;

    for (const agent of this.agents.values()) {
      // Filter by customer if specified
      if (customerId && agent.customerId !== customerId) {
        continue;
      }

      // Only wake sleeping agents
      if (agent.powerState !== 'SLEEP') {
        continue;
      }

      // Only wake active/pending agents (not blocked/expired)
      if (agent.state !== 'ACTIVE' && agent.state !== 'PENDING') {
        continue;
      }

      try {
        agent.socket.send(
          JSON.stringify({
            type: 'wake',
            id: uuidv4(),
            reason,
            config: {
              heartbeatInterval: 5000, // Wake to ACTIVE interval
              powerState: 'ACTIVE',
            },
          })
        );

        // Update local state
        agent.powerState = 'ACTIVE';
        wokenCount++;

        console.log(
          `[Registry] Woke agent ${agent.machineName || agent.machineId} (reason: ${reason})`
        );
      } catch (err) {
        console.error(`[Registry] Failed to wake agent ${agent.id}:`, err);
      }
    }

    if (wokenCount > 0) {
      console.log(`[Registry] Broadcast wake (${reason}): woke ${wokenCount} agents`);
    }

    return wokenCount;
  }

  /**
   * Wake a specific agent
   */
  wakeAgent(agentId: string, reason: string = 'command'): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) {
      return false;
    }

    if (agent.powerState !== 'SLEEP') {
      return true; // Already awake
    }

    try {
      agent.socket.send(
        JSON.stringify({
          type: 'wake',
          id: uuidv4(),
          reason,
          config: {
            heartbeatInterval: 5000,
            powerState: 'ACTIVE',
          },
        })
      );

      agent.powerState = 'ACTIVE';
      console.log(`[Registry] Woke agent ${agent.machineName || agent.machineId} (reason: ${reason})`);
      return true;
    } catch (err) {
      console.error(`[Registry] Failed to wake agent ${agentId}:`, err);
      return false;
    }
  }

  /**
   * Get all sleeping agents for a customer
   */
  getSleepingAgents(customerId?: string): ConnectedAgent[] {
    return Array.from(this.agents.values()).filter((agent) => {
      if (agent.powerState !== 'SLEEP') return false;
      if (customerId && agent.customerId !== customerId) return false;
      return true;
    });
  }
}

// Singleton instance using globalThis to survive Next.js module reloading
// and ensure the same instance is used across custom server and API routes
const globalForAgentRegistry = globalThis as unknown as {
  agentRegistry: LocalAgentRegistry | undefined;
};

export const agentRegistry =
  globalForAgentRegistry.agentRegistry ??
  new LocalAgentRegistry();

// Always save to global to ensure singleton works in both dev and production
globalForAgentRegistry.agentRegistry = agentRegistry;

export { LocalAgentRegistry };
