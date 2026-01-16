/**
 * Job Types API Route
 *
 * GET /api/jobs/types - List all job types
 * POST /api/jobs/types - Create a new job type (admin only for system types)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const jobTypes = await prisma.jobType.findMany({
    orderBy: [
      { isSystem: 'desc' },
      { category: 'asc' },
      { displayName: 'asc' },
    ],
  });

  return NextResponse.json({ jobTypes });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();

    const {
      name,
      displayName,
      description,
      category = 'CUSTOM',
      defaultPrompt,
      defaultTasks,
    } = body;

    // Validate required fields
    if (!name || !displayName || !defaultPrompt) {
      return NextResponse.json(
        { error: 'Missing required fields: name, displayName, defaultPrompt' },
        { status: 400 }
      );
    }

    // Check for duplicate name
    const existing = await prisma.jobType.findUnique({
      where: { name },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'A job type with this name already exists' },
        { status: 409 }
      );
    }

    const jobType = await prisma.jobType.create({
      data: {
        name,
        displayName,
        description,
        category,
        defaultPrompt,
        defaultTasks,
        isSystem: false, // User-created types are never system
      },
    });

    return NextResponse.json({ jobType }, { status: 201 });
  } catch (error) {
    console.error('[Jobs API] Failed to create job type:', error);
    return NextResponse.json(
      { error: 'Failed to create job type' },
      { status: 500 }
    );
  }
}
