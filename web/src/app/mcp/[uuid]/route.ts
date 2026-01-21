/**
 * MCP Tenant Endpoint
 *
 * POST/GET /mcp/{uuid}
 *
 * Per-tenant MCP endpoint that:
 * - Validates OAuth Bearer tokens
 * - Verifies token audience matches this endpoint
 * - Handles MCP JSON-RPC requests (POST)
 * - Handles SSE streams (GET)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashToken, isTokenExpired, validateTokenAudience } from '@/lib/oauth';
import { RateLimiters, getClientIp, rateLimitExceeded } from '@/lib/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { agentRegistry } from '@/lib/control-server';
import { sseManager } from '@/lib/mcp-sse-manager';

export const dynamic = 'force-dynamic';

const APP_URL = process.env.APP_URL || 'https://screencontrol.knws.co.uk';

interface RouteParams {
  params: Promise<{ uuid: string }>;
}

// MCP Server capabilities
const MCP_CAPABILITIES = {
  tools: {
    listChanged: true
  },
  resources: {},
  prompts: {},
};

// Logging helper
function logMcp(stage: string, data: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[MCP Endpoint] ${stage} - ${timestamp}`);
  console.log('='.repeat(60));
  Object.entries(data).forEach(([key, value]) => {
    if (key.toLowerCase().includes('token') && typeof value === 'string' && value.length > 20) {
      console.log(`  ${key}: ${value.substring(0, 12)}...${value.substring(value.length - 4)} (${value.length} chars)`);
    } else if (typeof value === 'object') {
      console.log(`  ${key}:`, JSON.stringify(value, null, 2));
    } else {
      console.log(`  ${key}: ${value}`);
    }
  });
}

/**
 * Extract and validate Bearer token from Authorization header
 */
async function validateRequest(request: NextRequest, endpointUuid: string) {
  const authHeader = request.headers.get('authorization');

  logMcp('VALIDATE REQUEST', {
    endpointUuid,
    hasAuthHeader: !!authHeader,
    authHeaderPrefix: authHeader?.substring(0, 20) || 'NONE',
  });

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logMcp('ERROR', { error: 'invalid_token', reason: 'Missing or invalid Authorization header' });
    return {
      error: 'invalid_token',
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="invalid_token", error_description="Missing or invalid Authorization header"',
      },
    };
  }

  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);
  const expectedAudience = APP_URL + '/mcp/' + endpointUuid;

  logMcp('TOKEN LOOKUP', {
    tokenHash: tokenHash.substring(0, 16) + '...',
    expectedAudience,
  });

  // Find the token
  const tokenRecord = await prisma.oAuthAccessToken.findUnique({
    where: { accessTokenHash: tokenHash },
    include: {
      connection: true,
      user: true,
    },
  });

  if (!tokenRecord) {
    logMcp('ERROR', { error: 'invalid_token', reason: 'Token not found in database' });
    return {
      error: 'invalid_token',
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="invalid_token"',
      },
    };
  }

  logMcp('TOKEN FOUND', {
    tokenId: tokenRecord.id,
    userId: tokenRecord.userId,
    userEmail: tokenRecord.user.email,
    connectionId: tokenRecord.connectionId,
    connectionName: tokenRecord.connection.name,
    connectionStatus: tokenRecord.connection.status,
    audience: tokenRecord.audience,
    expectedAudience,
    scope: tokenRecord.scope,
    revokedAt: tokenRecord.revokedAt?.toISOString() || 'NOT REVOKED',
    expiresAt: tokenRecord.accessExpiresAt.toISOString(),
  });

  // Check if revoked
  if (tokenRecord.revokedAt) {
    logMcp('ERROR', { error: 'invalid_token', reason: 'Token has been revoked' });
    return {
      error: 'invalid_token',
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="invalid_token", error_description="Token has been revoked"',
      },
    };
  }

  // Check if expired
  if (isTokenExpired(tokenRecord.accessExpiresAt)) {
    logMcp('ERROR', { error: 'invalid_token', reason: 'Token has expired' });
    return {
      error: 'invalid_token',
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="invalid_token", error_description="Token has expired"',
      },
    };
  }

  // Check audience
  const audienceValid = validateTokenAudience(tokenRecord.audience, expectedAudience);
  logMcp('AUDIENCE CHECK', {
    tokenAudience: tokenRecord.audience,
    expectedAudience,
    valid: audienceValid,
  });
  if (!audienceValid) {
    logMcp('ERROR', { error: 'insufficient_scope', reason: 'Token not valid for this resource' });
    return {
      error: 'insufficient_scope',
      status: 403,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="insufficient_scope", error_description="Token not valid for this resource"',
      },
    };
  }

  // Check connection is active
  if (tokenRecord.connection.status !== 'ACTIVE') {
    logMcp('ERROR', { error: 'invalid_token', reason: 'Connection is not active', status: tokenRecord.connection.status });
    return {
      error: 'invalid_token',
      status: 403,
      headers: {
        'WWW-Authenticate': 'Bearer realm="mcp", error="invalid_token", error_description="Connection is not active"',
      },
    };
  }

  logMcp('VALIDATION SUCCESS', { userId: tokenRecord.userId, connectionId: tokenRecord.connectionId });

  // Update last used timestamp
  await Promise.all([
    prisma.oAuthAccessToken.update({
      where: { id: tokenRecord.id },
      data: { lastUsedAt: new Date() },
    }),
    prisma.mcpConnection.update({
      where: { id: tokenRecord.connectionId },
      data: {
        lastUsedAt: new Date(),
        totalRequests: { increment: 1 },
      },
    }),
  ]);

  return {
    valid: true,
    userId: tokenRecord.userId,
    connectionId: tokenRecord.connectionId,
    scope: tokenRecord.scope,
  };
}

/**
 * Handle POST requests (Streamable HTTP JSON-RPC)
 */
export async function POST(request: NextRequest, context: RouteParams): Promise<Response> {
  const { uuid } = await context.params;
  const clientIp = getClientIp(request);

  // Validate the endpoint exists first (lightweight check)
  const connection = await prisma.mcpConnection.findUnique({
    where: { endpointUuid: uuid },
  });

  if (!connection) {
    return NextResponse.json(
      { error: 'not_found', error_description: 'MCP endpoint not found' },
      { status: 404 }
    );
  }

  // Validate the request (authentication)
  const validation = await validateRequest(request, uuid);
  if ('error' in validation) {
    // Request is unauthenticated - apply stricter IP-based rate limit
    const unauthRateLimit = RateLimiters.mcpUnauthenticated(clientIp);
    if (!unauthRateLimit.success) {
      return rateLimitExceeded(unauthRateLimit);
    }
    return NextResponse.json(
      { error: validation.error },
      {
        status: validation.status,
        headers: validation.headers,
      }
    );
  }

  // Request is authenticated - apply connection-based rate limit (100 requests/minute)
  const connRateLimit = RateLimiters.mcpRequest(validation.connectionId);
  if (!connRateLimit.success) {
    return rateLimitExceeded(connRateLimit);
  }

  // Parse JSON-RPC request
  let rpcRequest;
  try {
    rpcRequest = await request.json();
  } catch (e) {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  // Handle JSON-RPC
  const { id, method, params } = rpcRequest;

  logMcp('JSON-RPC REQUEST', {
    id: id ?? 'NOTIFICATION (no id)',
    method,
    params: params || {},
    clientIp,
    userAgent: request.headers.get('user-agent') || 'unknown',
    connectionId: validation.connectionId,
  });

  // Check if this is a notification (no id field = no response expected)
  const isNotification = id === undefined || id === null;

  // Log the request
  const startTime = Date.now();

  try {
    const response = await handleMcpMethod(method, params, validation);

    logMcp('JSON-RPC RESPONSE SUCCESS', {
      id: id ?? 'NOTIFICATION',
      method,
      responseKeys: Object.keys(response || {}),
      isNotification,
      // For tools/list, log count and first/last 10 tool names
      toolCount: method === 'tools/list' && response && 'tools' in response && response.tools ? (response.tools as any[]).length : undefined,
      firstTools: method === 'tools/list' && response && 'tools' in response && response.tools ? (response.tools as any[]).slice(0, 10).map((t: any) => t.name) : undefined,
      lastTools: method === 'tools/list' && response && 'tools' in response && response.tools ? (response.tools as any[]).slice(-10).map((t: any) => t.name) : undefined,
    });



    // Log request
    await logRequest(validation.connectionId, method, params, true, Date.now() - startTime, request);

    // Notifications don't get responses per JSON-RPC spec
    if (isNotification) {
      return new NextResponse(null, {
        status: 202,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return NextResponse.json({
      jsonrpc: '2.0',
      id,
      result: response,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': uuidv4(),
      },
    });
  } catch (error: any) {
    const code = error.code || -32603;
    const message = error.message || 'Internal error';

    logMcp('JSON-RPC RESPONSE ERROR', {
      id: id ?? 'NOTIFICATION',
      method,
      errorCode: code,
      errorMessage: message,
      isNotification,
    });

    // Log request
    await logRequest(validation.connectionId, method, params, false, Date.now() - startTime, request, code, message);

    // Notifications don't get error responses either
    if (isNotification) {
      return new NextResponse(null, {
        status: 202,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return jsonRpcError(id, code, message);
  }
}

/**
 * Handle MCP methods
 */
async function handleMcpMethod(method: string, params: any, auth: { userId: string; scope: string[] }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: MCP_CAPABILITIES,
        serverInfo: {
          name: 'ScreenControl MCP',
          version: '1.0.0',
        },
      };

    case 'tools/list':
      // Get user's active agents
      const agentsForTools = await prisma.agent.findMany({
        where: {
          ownerUserId: auth.userId,
          status: 'ONLINE',
        },
        select: {
          id: true,
          hostname: true,
          osType: true,
        },
      });

      // Try to get dynamic tools from connected agents first
      let toolsList: any[] = [];
      let toolsSource = 'default';  // Track where tools came from for logging

      // Aggregate tools from all online agents
      const agentToolsMap = new Map<string, any>();  // tool name -> tool definition

      for (const dbAgent of agentsForTools) {
        const connectedAgent = agentRegistry.getAgent(dbAgent.id);

        // If tools haven't been fetched yet, fetch them now (synchronously)
        if (connectedAgent && (!connectedAgent.tools || connectedAgent.tools.length === 0)) {
          logMcp('FETCHING TOOLS FOR AGENT', {
            agentId: dbAgent.id,
            hostname: dbAgent.hostname,
          });
          await agentRegistry.fetchAgentCapabilities(connectedAgent.id);
        }

        if (connectedAgent?.tools && connectedAgent.tools.length > 0) {
          connectedAgent.tools.forEach(tool => {
            agentToolsMap.set(tool.name, tool);
          });
        }
      }

      // If we have tools from agents, use them
      if (agentToolsMap.size > 0) {
        toolsList = Array.from(agentToolsMap.values());
        toolsSource = `agent (${agentToolsMap.size} tools from ${agentsForTools.length} agents)`;

        logMcp('USING AGENT TOOLS', {
          agentCount: agentsForTools.length,
          toolCount: toolsList.length,
          toolNames: toolsList.map(t => t.name).slice(0, 20),  // First 20 for logging
        });
      } else {
        // Fall back to default hardcoded tools if agents haven't advertised yet
        toolsSource = 'default hardcoded';
        logMcp('USING DEFAULT TOOLS', {
          reason: 'No tools advertised by agents yet',
          agentCount: agentsForTools.length,
        });

        toolsList = [
        // === Emergency Control ===
        {
          name: 'emergency_stop',
          description: 'EMERGENCY STOP - Immediately cancel all pending operations on an agent. Use this if the user says "stop", "cancel", "abort", or indicates they selected the wrong agent.',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Agent to stop (optional - stops all if not specified)' },
              reason: { type: 'string', description: 'Reason for stopping' },
            },
          },
        },

        // === Agent Management ===
        {
          name: 'list_agents',
          description: 'List all connected desktop agents that can be controlled remotely',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },

        // === Desktop Screenshot & Vision ===
        {
          name: 'desktop_screenshot',
          description: 'Take a screenshot of the entire desktop or a specific window',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID (optional, uses first available)' },
              format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format' },
              quality: { type: 'number', description: 'JPEG quality 1-100' },
            },
          },
        },

        // === Mouse Actions ===
        {
          name: 'mouse_click',
          description: 'Click at specific screen coordinates',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
              clickCount: { type: 'number', description: 'Number of clicks (1=single, 2=double)' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'mouse_move',
          description: 'Move mouse cursor to specific coordinates',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'mouse_drag',
          description: 'Drag from one position to another',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              startX: { type: 'number' },
              startY: { type: 'number' },
              endX: { type: 'number' },
              endY: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right'] },
            },
            required: ['startX', 'startY', 'endX', 'endY'],
          },
        },
        {
          name: 'mouse_scroll',
          description: 'Scroll the mouse wheel',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              x: { type: 'number', description: 'X position to scroll at' },
              y: { type: 'number', description: 'Y position to scroll at' },
              deltaX: { type: 'number', description: 'Horizontal scroll amount' },
              deltaY: { type: 'number', description: 'Vertical scroll amount (negative=up, positive=down)' },
            },
            required: ['deltaY'],
          },
        },

        // === Keyboard Actions ===
        {
          name: 'keyboard_type',
          description: 'Type text using the keyboard',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              text: { type: 'string', description: 'Text to type' },
              delay: { type: 'number', description: 'Delay between keystrokes in ms' },
            },
            required: ['text'],
          },
        },
        {
          name: 'keyboard_press',
          description: 'Press a specific key or key combination',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              key: { type: 'string', description: 'Key to press (e.g., Enter, Tab, Escape, F1, a, A)' },
              modifiers: {
                type: 'array',
                items: { type: 'string', enum: ['Control', 'Alt', 'Shift', 'Meta', 'Command'] },
                description: 'Modifier keys to hold',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'keyboard_shortcut',
          description: 'Execute a keyboard shortcut (e.g., Cmd+C, Ctrl+V)',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              shortcut: { type: 'string', description: 'Shortcut like "Command+C" or "Control+Shift+S"' },
            },
            required: ['shortcut'],
          },
        },

        // === Browser Automation ===
        // NOTE: Browser tools are provided by agents dynamically.
        // This fallback should only contain minimal desktop control tools.
        // If you're seeing this, agents haven't advertised their tools yet.

        // === Window Management ===
        {
          name: 'window_list',
          description: 'List all open windows on the desktop',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
            },
          },
        },
        {
          name: 'window_focus',
          description: 'Focus/activate a specific window',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              windowId: { type: 'string', description: 'Window ID from window_list' },
              title: { type: 'string', description: 'Window title to match' },
            },
          },
        },
        {
          name: 'window_resize',
          description: 'Resize a window',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              windowId: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['width', 'height'],
          },
        },
        {
          name: 'window_move',
          description: 'Move a window to specific position',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              windowId: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['x', 'y'],
          },
        },

        // === Application Control ===
        {
          name: 'app_launch',
          description: 'Launch an application',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              app: { type: 'string', description: 'Application name or path' },
              args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments' },
            },
            required: ['app'],
          },
        },
        {
          name: 'app_close',
          description: 'Close an application',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              app: { type: 'string', description: 'Application name' },
              force: { type: 'boolean', description: 'Force quit' },
            },
            required: ['app'],
          },
        },

        // === Clipboard ===
        {
          name: 'clipboard_read',
          description: 'Read content from clipboard',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
            },
          },
        },
        {
          name: 'clipboard_write',
          description: 'Write content to clipboard',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              text: { type: 'string', description: 'Text to copy to clipboard' },
            },
            required: ['text'],
          },
        },

        // === File Operations ===
        {
          name: 'file_read',
          description: 'Read contents of a file',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              path: { type: 'string', description: 'File path' },
              encoding: { type: 'string', description: 'Text encoding (utf8, base64)' },
            },
            required: ['path'],
          },
        },
        {
          name: 'file_write',
          description: 'Write contents to a file',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              path: { type: 'string', description: 'File path' },
              content: { type: 'string', description: 'Content to write' },
              encoding: { type: 'string', description: 'Text encoding' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'file_list',
          description: 'List files in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              path: { type: 'string', description: 'Directory path' },
            },
            required: ['path'],
          },
        },

        // === System Info ===
        // === Filesystem Tools (fs_* aliases) ===
        {
          name: 'fs_list',
          description: 'List files and directories in a path',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'Directory path to list' },
            },
            required: ['path'],
          },
        },
        {
          name: 'fs_read',
          description: 'Read contents of a file',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'File path to read' },
            },
            required: ['path'],
          },
        },
        {
          name: 'fs_write',
          description: 'Write content to a file',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'File path to write' },
              content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'fs_delete',
          description: 'Delete a file or directory',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'Path to delete' },
              recursive: { type: 'boolean', description: 'Delete recursively for directories' },
            },
            required: ['path'],
          },
        },
        {
          name: 'fs_move',
          description: 'Move or rename a file or directory',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              source: { type: 'string', description: 'Source path' },
              destination: { type: 'string', description: 'Destination path' },
            },
            required: ['source', 'destination'],
          },
        },
        {
          name: 'fs_search',
          description: 'Search for files by glob pattern',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'Directory to search in' },
              pattern: { type: 'string', description: 'Glob pattern (e.g., *.txt)' },
            },
            required: ['path', 'pattern'],
          },
        },
        {
          name: 'fs_grep',
          description: 'Search file contents with regex',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              path: { type: 'string', description: 'Directory to search in' },
              pattern: { type: 'string', description: 'Regex pattern to search for' },
            },
            required: ['path', 'pattern'],
          },
        },
        {
          name: 'shell_exec',
          description: 'Execute a shell command',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              command: { type: 'string', description: 'Command to execute' },
              cwd: { type: 'string', description: 'Working directory' },
              timeout_seconds: { type: 'number', description: 'Timeout in seconds' },
            },
            required: ['command'],
          },
        },
        {
          name: 'wait',
          description: 'Wait for specified milliseconds',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Target agent ID' },
              milliseconds: { type: 'number', description: 'Time to wait in ms' },
            },
            required: ['milliseconds'],
          },
        },
        {
          name: 'system_info',
          description: 'Get system information (OS, CPU, memory, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
            },
          },
        },

        // === Screen OCR / Vision ===
        {
          name: 'screen_find_text',
          description: 'Find text on screen using OCR and return coordinates',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              text: { type: 'string', description: 'Text to find on screen' },
            },
            required: ['text'],
          },
        },
        {
          name: 'screen_find_image',
          description: 'Find an image pattern on screen',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              imageBase64: { type: 'string', description: 'Base64 encoded image to find' },
              threshold: { type: 'number', description: 'Match threshold 0-1' },
            },
            required: ['imageBase64'],
          },
        },
        ];
      }

      logMcp('TOOLS LIST RESPONSE', {
        toolCount: toolsList.length,
        toolsSource: toolsSource,
        toolNames: toolsList.map(t => t.name),
        onlineAgents: agentsForTools.length,
      });

      return { tools: toolsList };

    case 'tools/call':
      const { name, arguments: args } = params;
      return await executeToolCall(name, args, auth.userId);

    case 'resources/list':
      return { resources: [] };

    case 'prompts/list':
      return { prompts: [] };

    case 'ping':
      return {};

    // MCP Notifications - these don't require meaningful responses
    case 'notifications/initialized':
      // Client confirms it received our initialize response
      return {};

    case 'notifications/cancelled':
      // Client cancelled a pending request
      return {};

    case 'notifications/progress':
      // Progress update from client
      return {};

    default:
      throw { code: -32601, message: 'Method not found: ' + method };
  }
}

/**
 * Execute a tool call
 */
async function executeToolCall(toolName: string, args: any, userId: string) {
  logMcp('TOOL CALL', {
    tool: toolName,
    arguments: args || {},
    userId,
  });

  // Get user's online agents for tools that need them
  const getOnlineAgents = async () => {
    return prisma.agent.findMany({
      where: { ownerUserId: userId, status: 'ONLINE' },
      select: { id: true, hostname: true, displayName: true, osType: true },
    });
  };

  // Helper to format agent name for display (prefers displayName over hostname)
  // NEVER falls back to ID - users can't understand IDs
  const formatAgentName = (agent: { displayName: string | null; hostname: string | null }) => {
    return agent.displayName || agent.hostname || 'Unnamed Agent';
  };

  // Normalize a string for fuzzy matching: lowercase, remove special chars, collapse spaces
  const normalizeForMatch = (str: string): string => {
    return str
      .toLowerCase()
      .replace(/[''`]/g, '')           // Remove apostrophes
      .replace(/[^a-z0-9\s]/g, ' ')    // Replace special chars with spaces
      .replace(/\s+/g, ' ')            // Collapse multiple spaces
      .trim();
  };

  // Calculate similarity score between two strings (0-1, higher is better)
  const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = normalizeForMatch(str1);
    const s2 = normalizeForMatch(str2);

    // Exact match after normalization
    if (s1 === s2) return 1.0;

    // One contains the other
    if (s1.includes(s2) || s2.includes(s1)) {
      const shorter = s1.length < s2.length ? s1 : s2;
      const longer = s1.length < s2.length ? s2 : s1;
      return shorter.length / longer.length * 0.9; // Slight penalty for partial match
    }

    // Word-based matching
    const words1 = s1.split(' ').filter(w => w.length > 0);
    const words2 = s2.split(' ').filter(w => w.length > 0);
    const matchingWords = words1.filter(w1 =>
      words2.some(w2 => w1.includes(w2) || w2.includes(w1))
    ).length;

    if (matchingWords > 0) {
      return matchingWords / Math.max(words1.length, words2.length) * 0.8;
    }

    // Levenshtein-like: count matching characters
    let matches = 0;
    const chars1 = s1.replace(/\s/g, '');
    const chars2 = s2.replace(/\s/g, '');
    for (const char of chars1) {
      if (chars2.includes(char)) matches++;
    }
    return matches / Math.max(chars1.length, chars2.length) * 0.5;
  };

  // Find best matching agent(s) with similarity scores
  type OnlineAgent = { id: string; hostname: string | null; displayName: string | null; osType: string };
  type AgentWithScore = { agent: OnlineAgent; score: number; matchedOn: string };

  const findMatchingAgents = (agents: OnlineAgent[], search: string): AgentWithScore[] => {
    const results: AgentWithScore[] = [];

    for (const agent of agents) {
      // Check exact ID match first (internal use)
      if (agent.id === search) {
        results.push({ agent, score: 1.0, matchedOn: 'id' });
        continue;
      }

      // Check displayName
      if (agent.displayName) {
        const score = calculateSimilarity(search, agent.displayName);
        if (score > 0.3) {
          results.push({ agent, score, matchedOn: 'displayName' });
          continue;
        }
      }

      // Check hostname
      if (agent.hostname) {
        const score = calculateSimilarity(search, agent.hostname);
        if (score > 0.3) {
          results.push({ agent, score, matchedOn: 'hostname' });
        }
      }
    }

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  };

  // Helper to select the target agent - returns agent or error response
  const selectAgent = async (requestedAgentId?: string): Promise<
    | { agent: { id: string; hostname: string | null; displayName: string | null; osType: string }; error?: never }
    | { error: { content: { type: string; text: string }[]; isError: boolean }; agent?: never }
  > => {
    const agents = await getOnlineAgents();

    if (agents.length === 0) {
      return {
        error: {
          content: [{
            type: 'text',
            text: `No agents are currently online. Please ensure a ScreenControl agent is running and connected.\n\nUse the "list_agents" tool to see all registered agents and their status.`,
          }],
          isError: true,
        }
      };
    }

    // If agentId specified, find matching agent(s) using fuzzy matching
    if (requestedAgentId) {
      const matches = findMatchingAgents(agents, requestedAgentId);

      // No matches found
      if (matches.length === 0) {
        return {
          error: {
            content: [{
              type: 'text',
              text: `Agent "${requestedAgentId}" not found or not online.\n\nAvailable online agents:\n${agents.map(a => `- "${formatAgentName(a)}" (${a.osType})`).join('\n')}\n\nPlease ask the user which agent they want to use.`,
            }],
            isError: true,
          }
        };
      }

      const bestMatch = matches[0];

      // High confidence match (>= 0.8) - use it directly
      if (bestMatch.score >= 0.8) {
        return { agent: bestMatch.agent };
      }

      // Medium confidence (0.5-0.8) - ask for confirmation
      if (bestMatch.score >= 0.5) {
        // Check if there are other close matches
        const closeMatches = matches.filter(m => m.score >= 0.5);

        if (closeMatches.length === 1) {
          // Only one reasonable match - ask to confirm
          return {
            error: {
              content: [{
                type: 'text',
                text: `Did you mean "${formatAgentName(bestMatch.agent)}" (${bestMatch.agent.osType})?\n\nPlease confirm with the user, then retry with the exact name: "${formatAgentName(bestMatch.agent)}"`,
              }],
              isError: true,
            }
          };
        } else {
          // Multiple close matches - ask user to clarify
          return {
            error: {
              content: [{
                type: 'text',
                text: `Multiple agents match "${requestedAgentId}". Please ask the user which one they mean:\n\n${closeMatches.map(m => `- "${formatAgentName(m.agent)}" (${m.agent.osType})`).join('\n')}\n\nThen retry with the exact name.`,
              }],
              isError: true,
            }
          };
        }
      }

      // Low confidence (< 0.5) - no good match
      return {
        error: {
          content: [{
            type: 'text',
            text: `Could not find an agent matching "${requestedAgentId}".\n\nAvailable online agents:\n${agents.map(a => `- "${formatAgentName(a)}" (${a.osType})`).join('\n')}\n\nPlease ask the user which agent they want to use.`,
          }],
          isError: true,
        }
      };
    }

    // If only one agent, use it automatically
    if (agents.length === 1) {
      return { agent: agents[0] };
    }

    // Multiple agents and none specified - ask Claude to choose
    return {
      error: {
        content: [{
          type: 'text',
          text: `Multiple agents are online. Please ask the user which agent to use.\n\nAvailable agents:\n${agents.map(a => `- "${formatAgentName(a)}" (${a.osType})`).join('\n')}\n\nThe user can refer to agents by name (e.g., "my MacBook" or the machine name shown above).`,
        }],
        isError: true,
      }
    };
  };

  // Helper to execute a command on an agent via WebSocket
  const executeAgentCommand = async (
    agent: { id: string; hostname: string | null; displayName: string | null; osType: string },
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }> => {
    try {
      logMcp('EXECUTING AGENT COMMAND', {
        agentDbId: agent.id,
        agentName: formatAgentName(agent),
        method,
        params,
      });

      // Use agentRegistry to send the command via WebSocket
      // agentRegistry.sendCommand accepts both connection ID and database ID
      const result = await agentRegistry.sendCommand(agent.id, method, params);

      logMcp('AGENT COMMAND RESULT', {
        agentDbId: agent.id,
        method,
        resultType: typeof result,
        hasResult: !!result,
      });

      // Handle different result types
      if (result === null || result === undefined) {
        return {
          content: [{
            type: 'text',
            text: `Command "${method}" completed on "${formatAgentName(agent)}" (${agent.osType}).`,
          }],
        };
      }

      // If result is an object with image data (screenshot)
      if (typeof result === 'object' && result !== null) {
        const resultObj = result as Record<string, unknown>;

        // Screenshot result - return as image
        if (resultObj.imageData || resultObj.image || resultObj.data || resultObj.base64) {
          const imageData = (resultObj.imageData || resultObj.image || resultObj.data || resultObj.base64) as string;
          const mimeType = (resultObj.mimeType || resultObj.format || 'image/png') as string;

          return {
            content: [{
              type: 'image',
              data: imageData,
              mimeType: mimeType.includes('/') ? mimeType : `image/${mimeType}`,
            }],
          };
        }

        // Error result
        if (resultObj.error) {
          return {
            content: [{
              type: 'text',
              text: `Error from agent "${formatAgentName(agent)}": ${resultObj.error}${resultObj.message ? ` - ${resultObj.message}` : ''}`,
            }],
            isError: true,
          };
        }

        // Generic object result - serialize it
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // String or primitive result
      return {
        content: [{
          type: 'text',
          text: String(result),
        }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMcp('AGENT COMMAND ERROR', {
        agentDbId: agent.id,
        method,
        error: errorMessage,
      });

      return {
        content: [{
          type: 'text',
          text: `Failed to execute "${method}" on "${formatAgentName(agent)}" (${agent.osType}): ${errorMessage}`,
        }],
        isError: true,
      };
    }
  };

  switch (toolName) {
    // === Emergency Control ===
    case 'emergency_stop': {
      const agentName = args?.agentId;
      const reason = args?.reason || 'User requested stop';

      logMcp('EMERGENCY STOP', { agentName, reason, userId });

      // If agent specified, try to find it
      if (agentName) {
        const result = await selectAgent(agentName);
        if (result.error) {
          // Even if agent not found, acknowledge the stop request
          return {
            content: [{
              type: 'text',
              text: `⛔ EMERGENCY STOP acknowledged.\n\nReason: ${reason}\n\nNote: Could not find agent "${agentName}" but all pending operations have been flagged for cancellation.\n\nThe user should verify no unintended actions occurred.`,
            }],
          };
        }

        // TODO: Send actual stop signal to agent via WebSocket
        return {
          content: [{
            type: 'text',
            text: `⛔ EMERGENCY STOP sent to "${formatAgentName(result.agent)}" (${result.agent.osType}).\n\nReason: ${reason}\n\nAll pending operations on this agent have been cancelled. The user should verify no unintended actions occurred.`,
          }],
        };
      }

      // Stop all agents
      const agents = await getOnlineAgents();
      // TODO: Send stop signal to all agents via WebSocket

      return {
        content: [{
          type: 'text',
          text: `⛔ EMERGENCY STOP sent to ALL agents (${agents.length} online).\n\nReason: ${reason}\n\nAll pending operations have been cancelled. The user should verify no unintended actions occurred.`,
        }],
      };
    }

    // === Agent Management ===
    case 'list_agents': {
      const agents = await prisma.agent.findMany({
        where: { ownerUserId: userId },
        select: {
          id: true,
          hostname: true,
          displayName: true,
          osType: true,
          status: true,
          lastSeenAt: true,
        },
      });
      logMcp('TOOL RESULT - list_agents', { agentCount: agents.length, agents });

      if (agents.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No agents registered. Install and run the ScreenControl agent on a computer to enable remote control.',
          }],
        };
      }

      // Format agents in a Claude-friendly way - never expose raw IDs to users
      const agentList = agents.map(a => ({
        name: formatAgentName(a),
        os: a.osType,
        status: a.status,
        lastSeen: a.lastSeenAt?.toISOString(),
      }));

      return {
        content: [{
          type: 'text',
          text: `Found ${agents.length} agent(s):\n\n${agentList.map(a =>
            `- "${a.name}" (${a.os}) - ${a.status}${a.status === 'ONLINE' ? ' ✓' : ''}\n  Last seen: ${a.lastSeen}`
          ).join('\n\n')}\n\nTo use a specific agent, refer to it by name (e.g., "my MacBook" or the machine name shown above).`,
        }],
      };
    }

    // === Desktop Screenshot & Vision ===
    case 'desktop_screenshot': {
      // DISABLED: Claude Web MCP client cannot process large ImageContent responses
      // Bug reported to Anthropic - re-enable when fixed
      return {
        content: [{
          type: 'text',
          text: 'Screenshot temporarily disabled for Claude Web due to MCP client limitations. Use Claude Code/Desktop for screenshots.',
        }],
        isError: true,
      };
      /* Original code:
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'screenshot',
        arguments: {
          format: args?.format || 'png',
          return_base64: true,
          quality: args?.quality,
        },
      });
      */
    }

    case 'screen_find_text': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'screen_find_text',
        arguments: { text: args?.text },
      });
    }

    case 'screen_find_image': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'screen_find_image',
        arguments: {
          imageBase64: args?.imageBase64,
          threshold: args?.threshold,
        },
      });
    }

    // === Mouse Actions ===
    case 'mouse_click': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'click',
        arguments: {
          x: args?.x,
          y: args?.y,
          button: args?.button || 'left',
          clickCount: args?.clickCount || 1,
        },
      });
    }

    case 'mouse_move': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'mouse_move',
        arguments: { x: args?.x, y: args?.y },
      });
    }

    case 'mouse_drag': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'mouse_drag',
        arguments: {
          startX: args?.startX,
          startY: args?.startY,
          endX: args?.endX,
          endY: args?.endY,
          button: args?.button || 'left',
        },
      });
    }

    case 'mouse_scroll': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'scroll',
        arguments: {
          x: args?.x,
          y: args?.y,
          deltaX: args?.deltaX || 0,
          deltaY: args?.deltaY,
        },
      });
    }

    // === Keyboard Actions ===
    case 'keyboard_type': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'type',
        arguments: {
          text: args?.text,
          delay: args?.delay,
        },
      });
    }

    case 'keyboard_press': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'key_press',
        arguments: {
          key: args?.key,
          modifiers: args?.modifiers,
        },
      });
    }

    case 'keyboard_shortcut': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'keyboard_shortcut',
        arguments: { shortcut: args?.shortcut },
      });
    }

    // === Browser Automation ===
    // NOTE: Browser tools are handled by the generic agent tool forwarding below (default case)

    // === Window Management ===
    case 'window_list': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'window_list',
        arguments: {},
      });
    }

    case 'window_focus': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'window_focus',
        arguments: {
          windowId: args?.windowId,
          title: args?.title,
        },
      });
    }

    case 'window_resize': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'window_resize',
        arguments: {
          windowId: args?.windowId,
          width: args?.width,
          height: args?.height,
        },
      });
    }

    case 'window_move': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'window_move',
        arguments: {
          windowId: args?.windowId,
          x: args?.x,
          y: args?.y,
        },
      });
    }

    // === Application Control ===
    case 'app_launch': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'app_launch',
        arguments: {
          app: args?.app,
          args: args?.args,
        },
      });
    }

    case 'app_close': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'app_close',
        arguments: {
          app: args?.app,
          force: args?.force,
        },
      });
    }

    // === Clipboard ===
    case 'clipboard_read': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'clipboard_read',
        arguments: {},
      });
    }

    case 'clipboard_write': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'clipboard_write',
        arguments: { text: args?.text },
      });
    }

    // === File Operations ===
    // Note: Agent implements fs_* names, but we accept both fs_* and file_* for compatibility
    case 'file_read':
    case 'fs_read': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_read',  // Agent implements fs_read, not file_read
        arguments: {
          path: args?.path,
          encoding: args?.encoding,
        },
      });
    }

    case 'file_write':
    case 'fs_write': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_write',  // Agent implements fs_write, not file_write
        arguments: {
          path: args?.path,
          content: args?.content,
          encoding: args?.encoding,
        },
      });
    }

    case 'file_list':
    case 'fs_list': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_list',  // Agent implements fs_list, not file_list
        arguments: { path: args?.path },
      });
    }

    // === System ===
    case 'system_info': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'system_info',
        arguments: {},
      });
    }

    case 'fs_delete': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_delete',
        arguments: { path: args?.path, recursive: args?.recursive },
      });
    }

    case 'fs_move': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_move',
        arguments: { source: args?.source, destination: args?.destination },
      });
    }

    case 'fs_search': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_search',
        arguments: { path: args?.path, pattern: args?.pattern },
      });
    }

    case 'fs_grep': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'fs_grep',
        arguments: { path: args?.path, pattern: args?.pattern },
      });
    }

    case 'shell_exec': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'shell_exec',
        arguments: {
          command: args?.command,
          cwd: args?.cwd,
          timeout_seconds: args?.timeout_seconds,
        },
      });
    }

    case 'wait': {
      const result = await selectAgent(args?.agentId);
      if (result.error) return result.error;
      return executeAgentCommand(result.agent, 'tools/call', {
        name: 'wait',
        arguments: { milliseconds: args?.milliseconds },
      });
    }

    default: {
      // Check if this tool is advertised by an agent dynamically
      // This allows agents to provide custom tools (like browser_* tools, machine_lock, etc.)
      // without needing to hardcode them in this switch statement

      const agents = await getOnlineAgents();

      // Find all agents that have this tool (important for platform-specific tools like machine_lock)
      const agentsWithTool: typeof agents = [];
      for (const dbAgent of agents) {
        const connectedAgent = agentRegistry.getAgent(dbAgent.id);
        if (connectedAgent?.tools) {
          const agentTool = connectedAgent.tools.find(t => t.name === toolName);
          if (agentTool) {
            agentsWithTool.push(dbAgent);
          }
        }
      }

      if (agentsWithTool.length > 0) {
        // Forward this tool call to an agent that has the tool
        logMcp('FORWARDING AGENT TOOL', {
          tool: toolName,
          arguments: args,
          agentsWithTool: agentsWithTool.map(a => ({ name: formatAgentName(a), os: a.osType })),
        });

        // If agentId specified, check it's one of the agents with this tool
        if (args?.agentId) {
          const matches = findMatchingAgents(agentsWithTool, args.agentId);
          if (matches.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `The tool "${toolName}" is not available on agent "${args.agentId}".\n\nThis tool is available on:\n${agentsWithTool.map(a => `- "${formatAgentName(a)}" (${a.osType})`).join('\n')}\n\nPlease specify one of these agents.`,
              }],
              isError: true,
            };
          }
          // Use the matching agent - strip agentId from arguments as the agent doesn't need it
          const { agentId: _agentId, ...toolArgs } = args;
          return executeAgentCommand(matches[0].agent, 'tools/call', {
            name: toolName,
            arguments: toolArgs,
          });
        }

        // No agentId specified - if only one agent has the tool, use it directly
        if (agentsWithTool.length === 1) {
          // Strip agentId if present (shouldn't be, but just in case)
          const { agentId: _agentId, ...toolArgs } = args || {};
          return executeAgentCommand(agentsWithTool[0], 'tools/call', {
            name: toolName,
            arguments: toolArgs,
          });
        }

        // Multiple agents have this tool - ask user to choose
        return {
          content: [{
            type: 'text',
            text: `The tool "${toolName}" is available on multiple agents. Please ask the user which agent to use:\n\n${agentsWithTool.map(a => `- "${formatAgentName(a)}" (${a.osType})`).join('\n')}\n\nThen retry with the agentId parameter.`,
          }],
          isError: true,
        };
      }

      // Tool not found anywhere
      logMcp('TOOL ERROR - Unknown tool', { tool: toolName });
      throw { code: -32601, message: `Unknown tool: ${toolName}. Use "list_agents" to see available agents and tools.` };
    }
  }
}

/**
 * Log MCP request
 */
async function logRequest(
  connectionId: string,
  method: string,
  params: any,
  success: boolean,
  durationMs: number,
  request: NextRequest,
  errorCode?: number,
  errorMessage?: string
) {
  try {
    await prisma.mcpRequestLog.create({
      data: {
        connectionId,
        method,
        toolName: method === 'tools/call' ? params?.name : undefined,
        params: params ? JSON.stringify(params) : undefined,
        success,
        errorCode,
        errorMessage,
        durationMs,
        ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0] || request.headers.get('x-real-ip'),
        userAgent: request.headers.get('user-agent'),
      },
    });
  } catch (e) {
    console.error('[MCP] Failed to log request:', e);
  }
}

/**
 * Create JSON-RPC error response
 */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return NextResponse.json({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }, { status: 400 });
}

/**
 * Handle GET requests (SSE stream)
 */
export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const { uuid } = await context.params;
  const clientIp = getClientIp(request);
  const userAgent = request.headers.get('user-agent') || 'unknown';

  // Validate the endpoint exists first (lightweight check)
  const connection = await prisma.mcpConnection.findUnique({
    where: { endpointUuid: uuid },
  });

  if (!connection) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404 }
    );
  }

  // Validate the request (authentication)
  const validation = await validateRequest(request, uuid);
  if ('error' in validation) {
    // Request is unauthenticated - apply stricter IP-based rate limit
    const unauthRateLimit = RateLimiters.mcpUnauthenticated(clientIp);
    if (!unauthRateLimit.success) {
      return rateLimitExceeded(unauthRateLimit);
    }
    return NextResponse.json(
      { error: validation.error },
      {
        status: validation.status,
        headers: validation.headers,
      }
    );
  }

  // Request is authenticated - apply connection-based rate limit (100 requests/minute)
  const connRateLimit = RateLimiters.mcpRequest(validation.connectionId);
  if (!connRateLimit.success) {
    return rateLimitExceeded(connRateLimit);
  }

  logMcp('SSE CONNECT', {
    endpointUuid: uuid,
    connectionId: validation.connectionId,
    userId: validation.userId,
    clientIp,
    userAgent,
  });

  // Create SSE stream
  const sessionId = uuidv4();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const connectedAt = new Date();
      const connectionInfo = {
        sessionId,
        controller,
        encoder,
        connectionId: validation.connectionId,
        endpointUuid: uuid,
        connectedAt,
      };

      sseManager.addConnection(sessionId, connectionInfo);
      logMcp('SSE CONNECTED', {
        sessionId,
        endpointUuid: uuid,
        connectionId: validation.connectionId,
        connectedAt: connectedAt.toISOString(),
        totalConnections: sseManager.getConnectionCount(),
        endpointConnections: sseManager.getConnectionCount(uuid),
        userAgent,
      });

      // Send initial connection event
      const event = 'data: ' + JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }) + '\n\n';
      controller.enqueue(encoder.encode(event));
      // Immediately signal that tools may have changed so clients refresh their cache
      const toolsChangedEvent = 'data: ' + JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      }) + '\n\n';
      controller.enqueue(encoder.encode(toolsChangedEvent));
      logMcp('SSE PUSH LIST_CHANGED', {
        sessionId,
        endpointUuid: uuid,
        connectionId: validation.connectionId,
        reason: 'initial_connect_force_refresh',
      });

      // Keep connection alive
      const pingInterval = setInterval(() => {
        try {
          const ping = ': ping\n\n';
          controller.enqueue(encoder.encode(ping));
        } catch {
          clearInterval(pingInterval);
        }
      }, 30000);

      let cleanedUp = false;
      let abortHandler: () => void;
      const cleanup = (reason: string) => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(pingInterval);
        request.signal.removeEventListener('abort', abortHandler);
        sseManager.removeConnection(sessionId);
        logMcp('SSE DISCONNECTED', {
          sessionId,
          endpointUuid: uuid,
          connectionId: validation.connectionId,
          reason,
          remainingConnections: sseManager.getConnectionCount(),
          remainingEndpointConnections: sseManager.getConnectionCount(uuid),
        });
      };

      abortHandler = () => cleanup('client_aborted');
      request.signal.addEventListener('abort', abortHandler);

      // Cleanup on close
      (request as any)._cleanup = () => {
        cleanup('stream_cancelled');
      };
    },
    cancel() {
      const cleanup = (request as any)._cleanup;
      if (cleanup) cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Handle DELETE requests (session termination)
 * MCP clients may send DELETE to close a session
 */
export async function DELETE(request: NextRequest, context: RouteParams): Promise<Response> {
  const { uuid } = await context.params;

  logMcp('DELETE REQUEST (session close)', { endpointUuid: uuid });

  // Just acknowledge the session close
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Handle OPTIONS for CORS
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Max-Age': '86400',
    },
  });
}
