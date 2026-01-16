/**
 * Job Trigger API Route
 *
 * POST /api/jobs/[id]/trigger - Manually trigger a job
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { jobSchedulerService } from '@/lib/job-scheduler';

export const dynamic = 'force-dynamic';

export async function POST(
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

  // Check job exists and belongs to user
  const job = await prisma.scheduledJob.findFirst({
    where: { id, userId: user.id },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  try {
    const jobRunId = await jobSchedulerService.triggerJob(id, 'MANUAL');

    return NextResponse.json({
      success: true,
      jobRunId,
      message: 'Job triggered successfully',
    });
  } catch (error) {
    console.error('[Jobs API] Failed to trigger job:', error);
    return NextResponse.json(
      { error: 'Failed to trigger job' },
      { status: 500 }
    );
  }
}
