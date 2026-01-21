/**
 * Terminal API Routes
 *
 * POST /api/terminal - Request a terminal session token
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { terminalSessionManager } from '@/lib/control-server/terminal-session-manager';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/terminal - Request a terminal session token
 *
 * Body: { agentId }
 * Returns: { token, expiresAt, wsUrl, agent }
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
  let body: { agentId?: string };

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
      osType: true,
      status: true,
      state: true,
      hasDisplay: true,
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

  // Create session token (stored in database for cross-process access)
  const result = await terminalSessionManager.createSessionToken({
    agentId: body.agentId,
    userId: user.id,
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
    wsUrl: `${wsProtocol}://${host}/ws/terminal`,
    agent: {
      id: agent.id,
      hostname: agent.hostname,
      osType: agent.osType,
      hasDisplay: agent.hasDisplay,
    },
  });
}
