/**
 * Job Run API Route
 *
 * GET /api/jobs/runs/[id] - Get details of a specific job run
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const { id } = await params;

  const jobRun = await prisma.jobRun.findUnique({
    where: { id },
    include: {
      scheduledJob: {
        select: {
          id: true,
          name: true,
          userId: true,
        },
      },
      results: {
        orderBy: { startedAt: 'asc' },
      },
    },
  });

  if (!jobRun) {
    return NextResponse.json({ error: 'Job run not found' }, { status: 404 });
  }

  // Check ownership
  if (jobRun.scheduledJob.userId !== user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Get agent names for the results
  const agentIds = jobRun.results.map(r => r.agentId);
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: {
      id: true,
      hostname: true,
      displayName: true,
      machineId: true,
    },
  });

  const agentMap = new Map(agents.map(a => [a.id, a]));

  const resultsWithAgentNames = jobRun.results.map(r => ({
    ...r,
    agentName: agentMap.get(r.agentId)?.displayName ||
               agentMap.get(r.agentId)?.hostname ||
               agentMap.get(r.agentId)?.machineId ||
               r.agentId,
  }));

  return NextResponse.json({
    jobRun: {
      ...jobRun,
      results: resultsWithAgentNames,
    },
  });
}
