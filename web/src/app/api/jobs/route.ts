/**
 * Jobs API Route
 *
 * GET /api/jobs - List all scheduled jobs
 * POST /api/jobs - Create a new scheduled job
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
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

  const jobs = await prisma.scheduledJob.findMany({
    where: { userId: user.id },
    include: {
      jobType: {
        select: {
          id: true,
          name: true,
          displayName: true,
          category: true,
        },
      },
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          successCount: true,
          failureCount: true,
          issuesFound: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ jobs });
}

export async function POST(request: NextRequest) {
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

  try {
    const body = await request.json();

    const {
      name,
      description,
      jobTypeId,
      cronExpression,
      timezone = 'UTC',
      targetAgentIds,
      runParallel = true,
      customPrompt,
      notifyEmail,
      notifyOn = 'ISSUES',
      isEnabled = true,
    } = body;

    // Validate required fields
    if (!name || !cronExpression || !targetAgentIds || targetAgentIds.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: name, cronExpression, targetAgentIds' },
        { status: 400 }
      );
    }

    // Validate cron expression
    const { isValidCronExpression, getNextRunTime } = await import('@/lib/job-scheduler/cron-parser');
    if (!isValidCronExpression(cronExpression)) {
      return NextResponse.json(
        { error: 'Invalid cron expression' },
        { status: 400 }
      );
    }

    // Calculate next run time
    const nextRunAt = getNextRunTime(cronExpression, timezone);

    const job = await prisma.scheduledJob.create({
      data: {
        userId: user.id,
        name,
        description,
        jobTypeId,
        cronExpression,
        timezone,
        targetAgentIds,
        runParallel,
        customPrompt,
        notifyEmail,
        notifyOn,
        isEnabled,
        nextRunAt,
      },
      include: {
        jobType: true,
      },
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    console.error('[Jobs API] Failed to create job:', error);
    return NextResponse.json(
      { error: 'Failed to create job' },
      { status: 500 }
    );
  }
}
