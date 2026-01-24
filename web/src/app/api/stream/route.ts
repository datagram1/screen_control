/**
 * Stream API Routes
 *
 * POST /api/stream - Request a stream session token
 * GET /api/stream - Get active stream sessions (stats)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { streamSessionManager } from '@/lib/control-server/stream-session-manager';
import { agentRegistry } from '@/lib/control-server/agent-registry';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/stream - Request a streaming session token
 *
 * Body: { agentId, displayId?, quality?, maxFps? }
 * Returns: { token, expiresAt, wsUrl }
 */
export async function POST(request: NextRequest) {
  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Get user
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: 'User not found' },
      { status: 404 }
    );
  }

  // Parse request body
  let body: {
    agentId?: string;
    displayId?: number;
    quality?: number;
    maxFps?: number;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  if (!body.agentId) {
    return NextResponse.json(
      { error: 'agentId is required' },
      { status: 400 }
    );
  }

  // Verify user owns this agent
  const agent = await prisma.agent.findFirst({
    where: {
      id: body.agentId,
      ownerUserId: user.id,
    },
    select: {
      id: true,
      hostname: true,
      status: true,
      state: true,
    },
  });

  if (!agent) {
    return NextResponse.json(
      { error: 'Agent not found or access denied' },
      { status: 404 }
    );
  }

  // Check agent is online
  if (agent.status !== 'ONLINE') {
    return NextResponse.json(
      { error: 'Agent is offline' },
      { status: 400 }
    );
  }

  // Check agent is active (licensed)
  if (agent.state !== 'ACTIVE') {
    return NextResponse.json(
      { error: `Agent is ${agent.state.toLowerCase()}` },
      { status: 400 }
    );
  }

  // Get client IP
  const headersList = await headers();
  const remoteAddress =
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headersList.get('x-real-ip') ||
    'unknown';

  // Create session token (async - stored in database for cross-process access)
  const result = await streamSessionManager.createSessionToken({
    agentId: body.agentId,
    userId: user.id,
    displayId: body.displayId ?? 0,
    quality: body.quality ?? 80,
    maxFps: body.maxFps ?? 30,
    remoteAddress,
  });

  if ('error' in result) {
    return NextResponse.json(
      { error: result.error },
      { status: 400 }
    );
  }

  // Return token and WebSocket URL
  const protocol = request.headers.get('x-forwarded-proto') || 'http';
  const host = request.headers.get('host') || 'localhost:3000';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  return NextResponse.json({
    success: true,
    token: result.token,
    expiresAt: result.expiresAt.toISOString(),
    wsUrl: `${wsProtocol}://${host}/ws/stream`,
    agent: {
      id: agent.id,
      hostname: agent.hostname,
    },
  });
}

/**
 * GET /api/stream - Get streaming statistics and active sessions
 */
export async function GET(request: NextRequest) {
  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Get user
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: 'User not found' },
      { status: 404 }
    );
  }

  // Get optional agentId filter
  const agentId = request.nextUrl.searchParams.get('agentId');

  // Get stats
  const stats = streamSessionManager.getStats();

  // Get user's active sessions
  let activeSessions: {
    sessionId: string;
    agentId: string;
    agentHostname: string;
    displayId: number;
    framesRelayed: number;
    bytesRelayed: number;
    createdAt: string;
  }[] = [];

  // Get all user's agents
  const userAgents = await prisma.agent.findMany({
    where: { ownerUserId: user.id },
    select: { id: true, hostname: true },
  });

  const agentMap = new Map(userAgents.map(a => [a.id, a.hostname]));

  // Filter sessions by user's agents
  for (const [agentDbId, hostname] of agentMap) {
    if (agentId && agentId !== agentDbId) continue;

    const sessions = streamSessionManager.getSessionsForAgent(agentDbId);
    for (const s of sessions) {
      if (s.userId === user.id) {
        activeSessions.push({
          sessionId: s.id,
          agentId: s.agentId,
          agentHostname: hostname || 'Unknown',
          displayId: s.displayId,
          framesRelayed: s.framesRelayed,
          bytesRelayed: s.bytesRelayed,
          createdAt: s.createdAt.toISOString(),
        });
      }
    }
  }

  return NextResponse.json({
    success: true,
    stats: {
      totalActiveSessions: stats.activeSessions,
      totalFramesRelayed: stats.totalFramesRelayed,
      totalBytesRelayed: stats.totalBytesRelayed,
    },
    sessions: activeSessions,
  });
}
