/**
 * ScreenControl Custom Next.js Server
 *
 * Combines the Next.js portal with the Control Server WebSocket handler.
 * This allows agents to connect via WebSocket while the portal runs on the same process.
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { handleAgentConnection } from './src/lib/control-server/websocket-handler';
import { handleStreamConnection } from './src/lib/control-server/stream-websocket-handler';
import { handleTerminalConnection } from './src/lib/control-server/terminal-websocket-handler';
import { agentRegistry } from './src/lib/control-server/agent-registry';
import { streamSessionManager } from './src/lib/control-server/stream-session-manager';
import { terminalSessionManager } from './src/lib/control-server/terminal-session-manager';
import { startEmailAgent, stopEmailAgent } from './src/lib/email-agent';
import { startJobScheduler, stopJobScheduler } from './src/lib/job-scheduler';
import os from 'os';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Get local IPs for display
function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (addrs) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          ips.push(addr.address);
        }
      }
    }
  }
  return ips;
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // WebSocket server for agent connections
  const wssAgents = new WebSocketServer({ noServer: true });

  // WebSocket server for stream viewers
  const wssStream = new WebSocketServer({ noServer: true });

  // WebSocket server for terminal viewers
  const wssTerminal = new WebSocketServer({ noServer: true });

  // Handle upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '');

    if (pathname === '/ws') {
      // Agent connections
      wssAgents.handleUpgrade(req, socket, head, (ws) => {
        wssAgents.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/stream') {
      // Viewer stream connections
      wssStream.handleUpgrade(req, socket, head, (ws) => {
        wssStream.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/terminal') {
      // Terminal viewer connections
      wssTerminal.handleUpgrade(req, socket, head, (ws) => {
        wssTerminal.emit('connection', ws, req);
      });
    } else {
      // Reject unknown WebSocket paths
      socket.destroy();
    }
  });

  // Handle agent WebSocket connections
  wssAgents.on('connection', (ws: WebSocket, req) => {
    // Enable TCP keepalive to help maintain NAT entries
    // @ts-ignore - accessing underlying socket
    const socket = (ws as any)._socket;
    if (socket) {
      socket.setKeepAlive(true, 10000); // 10 second keepalive interval
    }
    handleAgentConnection(ws, req, agentRegistry);
  });

  // Handle viewer stream WebSocket connections
  wssStream.on('connection', (ws: WebSocket, req) => {
    handleStreamConnection(ws, req);
  });

  // Handle terminal viewer WebSocket connections
  wssTerminal.on('connection', (ws: WebSocket, req) => {
    handleTerminalConnection(ws, req);
  });

  // Heartbeat interval for connected agents - sends both:
  // 1. WebSocket protocol ping frames (for NAT/firewall keepalive)
  // 2. Application-level ping messages (for agent logic)
  // Using 10-second interval to handle aggressive NAT timeouts (some routers have 60s)
  const heartbeatInterval = setInterval(() => {
    const agents = agentRegistry.getAllAgents();
    for (const agent of agents) {
      if (agent.socket.readyState === WebSocket.OPEN) {
        // Send WebSocket protocol-level ping frame (keeps NAT tables alive)
        agent.socket.ping();
        // Send application-level ping message (for agent monitoring)
        agent.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }
  }, 10000);

  // Cleanup on server close
  server.on('close', () => {
    clearInterval(heartbeatInterval);
    agentRegistry.cleanup();
    streamSessionManager.cleanup();
    stopEmailAgent();
    stopJobScheduler();
  });

  server.listen(port, hostname, async () => {
    const localIPs = getLocalIPs();
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║               ScreenControl Server v1.6.0                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  Portal:      http://localhost:${port}                               ║
║  Agent WS:    ws://localhost:${port}/ws                              ║
║  Stream WS:   ws://localhost:${port}/ws/stream                       ║
║  Terminal WS: ws://localhost:${port}/ws/terminal                     ║
║  API:         http://localhost:${port}/api                           ║
║  Environment: ${dev ? 'development' : 'production'}                                          ║
╠═══════════════════════════════════════════════════════════════════╣
║  Local IPs:   ${localIPs.length > 0 ? localIPs.join(', ').padEnd(52) : 'none'.padEnd(52)}║
╚═══════════════════════════════════════════════════════════════════╝
    `);

    // Start email agent (if configured)
    const emailStarted = await startEmailAgent();
    if (emailStarted) {
      console.log('║  Email Agent: ACTIVE                                              ║');
    }

    // Start job scheduler
    const schedulerStarted = await startJobScheduler();
    if (schedulerStarted) {
      console.log('║  Job Scheduler: ACTIVE                                            ║');
    }
  });
});
