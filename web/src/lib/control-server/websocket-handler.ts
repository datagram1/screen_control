/**
 * WebSocket Handler
 *
 * Handles incoming WebSocket connections from agents.
 */

import { WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { AgentMessage, ConnectedAgent, StreamAgentResponse } from './types';
import { NetworkUtils } from './network';
import { LocalAgentRegistry } from './agent-registry';
import { checkLicenseStatus } from './db-service';
import { checkUpdateAvailable } from './update-service';
import { streamSessionManager } from './stream-session-manager';
import { terminalSessionManager } from './terminal-session-manager';
import { masterSessionManager } from './master-session-manager';

/**
 * Handle a new agent WebSocket connection
 */
export function handleAgentConnection(
  socket: WebSocket,
  req: IncomingMessage,
  registry: LocalAgentRegistry
): void {
  const remoteAddress = NetworkUtils.getClientIP(req);
  console.log(`[WS] New connection from ${remoteAddress}`);

  let agent: ConnectedAgent | null = null;

  // Handle incoming messages
  socket.on('message', async (data) => {
    try {
      const msg: AgentMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case 'register':
          agent = await registry.register(socket, msg, remoteAddress);
          if (agent) {
            socket.send(
              JSON.stringify({
                type: 'registered',
                id: agent.id,
                agentId: agent.dbId || agent.id,
                licenseStatus: agent.licenseStatus || 'pending',
                licenseUuid: agent.licenseUuid,
                state: agent.state,
                powerState: agent.powerState,
                config: {
                  heartbeatInterval: getHeartbeatInterval(agent.powerState),
                  graceHours: 72, // 72-hour grace period for network issues
                },
              })
            );

            // Register as master session if agent has master mode enabled
            // This is checked via database in masterSessionManager
            if (agent.dbId) {
              masterSessionManager.registerMasterSession(agent.dbId, socket).catch((err) => {
                console.error('[WS] Failed to register master session:', err);
              });
            }
          } else {
            socket.send(
              JSON.stringify({
                type: 'error',
                error: 'Registration failed',
              })
            );
            socket.close(4000, 'Registration failed');
          }
          break;

        case 'response':
        case 'error':
          if (agent) {
            registry.handleResponse(agent, msg);
          }
          break;

        case 'pong':
          if (agent) {
            registry.updatePing(agent);
          }
          break;

        case 'heartbeat':
          if (agent) {
            registry.updatePing(agent);
            // Update state if provided
            if (msg.powerState || msg.isScreenLocked !== undefined || msg.hasDisplay !== undefined || msg.currentTask) {
              await registry.updateState(agent, {
                powerState: msg.powerState || agent.powerState,
                isScreenLocked: msg.isScreenLocked ?? agent.isScreenLocked,
                hasDisplay: msg.hasDisplay ?? agent.hasDisplay,
                currentTask: msg.currentTask,
              });
            }

            // Check license status on heartbeat (1.2.4)
            if (agent.dbId) {
              try {
                const licenseCheck = await checkLicenseStatus(agent.dbId);

                // Check if there are pending commands for this agent
                const hasPendingCommands = registry.hasPendingQueuedCommands(agent.id);

                // Check for available updates (1.3.0)
                let updateFlag = 0;
                if (agent.agentVersion && agent.osType && agent.arch) {
                  const updateInfo = await checkUpdateAvailable(
                    agent.agentVersion,
                    agent.osType,
                    agent.arch,
                    agent.machineId
                  );
                  if (updateInfo.hasUpdate) {
                    updateFlag = updateInfo.isForced ? 2 : 1; // 2 = forced, 1 = available
                  }
                }

                // Send heartbeat_ack with license status, pending commands flag, update flag, and permissions
                socket.send(
                  JSON.stringify({
                    type: 'heartbeat_ack',
                    id: msg.id,
                    licenseStatus: licenseCheck.licenseStatus,
                    licenseChanged: licenseCheck.changed,
                    licenseMessage: licenseCheck.message,
                    pendingCommands: hasPendingCommands, // (1.2.19)
                    u: updateFlag, // Update flag: 0 = none, 1 = available, 2 = forced (1.3.0)
                    defaultBrowser: licenseCheck.defaultBrowser, // Browser preference (1.3.1)
                    permissions: licenseCheck.permissions, // Server-controlled permissions
                    config: licenseCheck.changed
                      ? {
                          heartbeatInterval: getHeartbeatInterval(agent.powerState),
                          state: licenseCheck.licenseStatus === 'active' ? 'ACTIVE' : 'DEGRADED',
                        }
                      : undefined,
                  })
                );

                // Update agent's license status in memory if changed
                if (licenseCheck.changed) {
                  agent.licenseStatus = licenseCheck.licenseStatus;
                  agent.state = licenseCheck.licenseStatus === 'active' ? 'ACTIVE' :
                               licenseCheck.licenseStatus === 'expired' ? 'EXPIRED' :
                               licenseCheck.licenseStatus === 'blocked' ? 'BLOCKED' : 'PENDING';
                }
              } catch (err) {
                console.error('[WS] License check error:', err);
              }
            }
          }
          break;

        case 'state_change':
          if (agent) {
            const previousPowerState = agent.powerState;

            await registry.updateState(agent, {
              powerState: msg.powerState || agent.powerState,
              isScreenLocked: msg.isScreenLocked ?? agent.isScreenLocked,
              currentTask: msg.currentTask,
            });

            // If power state changed, send new config
            if (msg.powerState && msg.powerState !== previousPowerState) {
              socket.send(
                JSON.stringify({
                  type: 'config',
                  id: crypto.randomUUID(),
                  config: {
                    heartbeatInterval: getHeartbeatInterval(msg.powerState),
                    powerState: msg.powerState,
                  },
                })
              );

              // If agent just woke up (was SLEEP, now ACTIVE or PASSIVE), process queued commands
              if (previousPowerState === 'SLEEP' && (msg.powerState === 'ACTIVE' || msg.powerState === 'PASSIVE')) {
                console.log(`[WS] Agent ${agent.machineName || agent.machineId} woke up, checking queued commands`);
                // Process asynchronously to not block
                registry.processQueuedCommands(agent.id).catch((err) => {
                  console.error('[WS] Error processing queued commands:', err);
                });
              }
            }
          }
          break;

        case 'tools_changed':
          if (agent) {
            const agentId = agent.id;
            const agentName = agent.machineName || agent.machineId;
            console.log(
              `[WS] Tools changed notification from ${agentName} ` +
              `(browserBridge: ${msg.browserBridgeRunning ? 'running' : 'stopped'})`
            );
            // Re-fetch agent capabilities to get updated tool list (including/excluding browser tools)
            registry.fetchAgentCapabilities(agentId).catch((err) => {
              console.error(`[WS] Failed to re-fetch capabilities for ${agentId}:`, err);
            });
          }
          break;

        // Streaming messages from agent
        case 'stream_started':
        case 'stream_stopped':
        case 'stream_frame':
        case 'stream_cursor':
        case 'stream_error':
          if (agent) {
            const streamMsg = msg as unknown as StreamAgentResponse;
            // Relay to stream session manager
            // Note: For stream_frame, binary data follows the JSON message
            // This will be handled in a separate binary message handler
            streamSessionManager.handleAgentFrame(agent.id, streamMsg);
          }
          break;

        // Master mode: relay command to another agent
        case 'relay_request':
          if (agent && agent.dbId) {
            const { targetAgentId, method, params } = msg;
            if (!targetAgentId || !method) {
              socket.send(JSON.stringify({
                type: 'relay_response',
                id: msg.id,
                error: 'Missing targetAgentId or method',
              }));
              break;
            }

            // Check if this agent is a master
            if (!masterSessionManager.isMaster(agent.dbId)) {
              socket.send(JSON.stringify({
                type: 'relay_response',
                id: msg.id,
                error: 'Agent is not authorized for master mode',
              }));
              break;
            }

            // Relay the command
            masterSessionManager.relayCommand(
              agent.dbId,
              targetAgentId,
              method,
              params || {}
            ).then((result) => {
              socket.send(JSON.stringify({
                type: 'relay_response',
                id: msg.id,
                result,
              }));
            }).catch((err) => {
              socket.send(JSON.stringify({
                type: 'relay_response',
                id: msg.id,
                error: err.message,
              }));
            });
          }
          break;

        default:
          console.warn(`[WS] Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      console.error('[WS] Message parse error:', e);
    }
  });

  // Handle disconnect
  socket.on('close', async (code, reason) => {
    const agentName = agent?.machineName || agent?.machineId || 'unknown';
    const reasonStr = reason?.toString() || '';

    // Log detailed close information
    console.log(`[WS] Connection closed for ${agentName}: code=${code}, reason="${reasonStr}"`);

    // Interpret close codes
    let closeType = 'unknown';
    switch (code) {
      case 1000: closeType = 'normal'; break;
      case 1001: closeType = 'going_away'; break;
      case 1002: closeType = 'protocol_error'; break;
      case 1003: closeType = 'unsupported_data'; break;
      case 1005: closeType = 'no_status'; break;
      case 1006: closeType = 'abnormal'; break;
      case 1007: closeType = 'invalid_payload'; break;
      case 1008: closeType = 'policy_violation'; break;
      case 1009: closeType = 'message_too_big'; break;
      case 1010: closeType = 'extension_required'; break;
      case 1011: closeType = 'internal_error'; break;
      case 1015: closeType = 'tls_handshake_fail'; break;
      case 4000: closeType = 'registration_failed'; break;
      case 4001: closeType = 'auth_failed'; break;
    }
    console.log(`[WS] Close type: ${closeType}`);

    if (agent) {
      // End any active streaming sessions for this agent
      streamSessionManager.handleAgentDisconnect(agent.id);
      // End any active terminal sessions for this agent
      terminalSessionManager.handleAgentDisconnect(agent.id);
      // Unregister master session if this was a master controller
      if (agent.dbId) {
        masterSessionManager.unregisterMasterSession(agent.dbId);
      }
      await registry.unregister(agent.id);
    }
  });

  // Handle errors
  socket.on('error', (err) => {
    console.error('[WS] Socket error:', err);
  });
}

/**
 * Get heartbeat interval based on power state
 */
function getHeartbeatInterval(powerState: ConnectedAgent['powerState']): number {
  switch (powerState) {
    case 'ACTIVE':
      return 5000; // 5 seconds
    case 'PASSIVE':
      return 30000; // 30 seconds
    case 'SLEEP':
      return 300000; // 5 minutes
    default:
      return 30000;
  }
}
