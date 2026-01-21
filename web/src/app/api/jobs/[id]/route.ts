/**
 * Single Job API Route
 *
 * GET /api/jobs/[id] - Get a specific job
 * PATCH /api/jobs/[id] - Update a job
 * DELETE /api/jobs/[id] - Delete a job
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

  const job = await prisma.scheduledJob.findFirst({
    where: { id, userId: user.id },
    include: {
      jobType: true,
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 20,
        include: {
          results: true,
        },
      },
    },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json({ job });
}

export async function PATCH(
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
  const existingJob = await prisma.scheduledJob.findFirst({
    where: { id, userId: user.id },
  });

  if (!existingJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  try {
    const body = await request.json();

    const {
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
    } = body;

    // Build update data
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (jobTypeId !== undefined) updateData.jobTypeId = jobTypeId;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (targetAgentIds !== undefined) updateData.targetAgentIds = targetAgentIds;
    if (runParallel !== undefined) updateData.runParallel = runParallel;
    if (customPrompt !== undefined) updateData.customPrompt = customPrompt;
    if (notifyEmail !== undefined) updateData.notifyEmail = notifyEmail;
    if (notifyOn !== undefined) updateData.notifyOn = notifyOn;
    if (isEnabled !== undefined) updateData.isEnabled = isEnabled;

    // Handle cron expression update
    if (cronExpression !== undefined) {
      const { isValidCronExpression, getNextRunTime } = await import('@/lib/job-scheduler/cron-parser');
      if (!isValidCronExpression(cronExpression)) {
        return NextResponse.json(
          { error: 'Invalid cron expression' },
          { status: 400 }
        );
      }
      updateData.cronExpression = cronExpression;
      updateData.nextRunAt = getNextRunTime(cronExpression, timezone || existingJob.timezone);
    }

    const job = await prisma.scheduledJob.update({
      where: { id },
      data: updateData,
      include: { jobType: true },
    });

    return NextResponse.json({ job });
  } catch (error) {
    console.error('[Jobs API] Failed to update job:', error);
    return NextResponse.json(
      { error: 'Failed to update job' },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
  const existingJob = await prisma.scheduledJob.findFirst({
    where: { id, userId: user.id },
  });

  if (!existingJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  await prisma.scheduledJob.delete({
    where: { id },
  });

  return NextResponse.json({ success: true });
}
