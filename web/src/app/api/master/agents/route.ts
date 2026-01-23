/**
 * Master Controller - List Accessible Agents API
 *
 * Returns list of agents that a master controller can access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { masterSessionManager } from '@/lib/control-server/master-session-manager';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/master/agents?agentId=xxx
 * List all agents accessible to a master controller
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const agentId = request.nextUrl.searchParams.get('agentId');
  if (!agentId) {
    return NextResponse.json(
      { error: 'Missing agentId parameter' },
      { status: 400 }
    );
  }

  try {
    // Verify agent exists and user owns it
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        ownerUserId: true,
        masterModeEnabled: true,
      },
    });

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Check user owns this agent
    if (agent.ownerUserId !== session.user.id) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (!agent.masterModeEnabled) {
      return NextResponse.json(
        { error: 'Master mode not enabled for this agent' },
        { status: 403 }
      );
    }

    const agents = await masterSessionManager.getAccessibleAgents(agentId);
    return NextResponse.json({ agents });
  } catch (error) {
    console.error('[API] Failed to get accessible agents:', error);
    const message = error instanceof Error ? error.message : 'Failed to get accessible agents';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
