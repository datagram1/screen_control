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
    // Verify user owns this agent
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        customerId: true,
        masterModeEnabled: true,
        customer: {
          select: {
            users: {
              where: { userId: session.user.id },
              select: { role: true },
            },
          },
        },
      },
    });

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Check user has access to this agent's customer
    if (!agent.customer?.users?.length) {
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
