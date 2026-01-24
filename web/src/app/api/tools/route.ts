/**
 * Tool Definitions API Route
 *
 * GET /api/tools - List all tool definitions with platform variants
 * POST /api/tools - Create a new tool definition
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { ToolCategory, OSType } from '@prisma/client';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Parse query parameters
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') as ToolCategory | null;
  const platform = searchParams.get('platform') as OSType | null;
  const enabledOnly = searchParams.get('enabledOnly') === 'true';

  // Build where clause
  const where: {
    category?: ToolCategory;
    isEnabled?: boolean;
  } = {};

  if (category && Object.values(ToolCategory).includes(category)) {
    where.category = category;
  }
  if (enabledOnly) {
    where.isEnabled = true;
  }

  // Fetch tool definitions with platform variants
  const tools = await prisma.toolDefinition.findMany({
    where,
    orderBy: [
      { category: 'asc' },
      { sortOrder: 'asc' },
      { name: 'asc' },
    ],
    include: {
      platformVariants: platform ? {
        where: { platform },
      } : true,
      _count: {
        select: { agentCapabilities: true },
      },
    },
  });

  // Get category stats
  const categoryStats = await prisma.toolDefinition.groupBy({
    by: ['category'],
    _count: true,
  });

  return NextResponse.json({
    tools,
    stats: {
      total: tools.length,
      byCategory: categoryStats.reduce((acc, curr) => {
        acc[curr.category] = curr._count;
        return acc;
      }, {} as Record<string, number>),
      categories: Object.values(ToolCategory),
    },
  });
}

export async function POST(request: NextRequest) {
  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Check if user is admin
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { role: true },
  });

  if (user?.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { name, category, isEnabled = true, sortOrder = 0, platformVariants = [] } = body;

    if (!name || !category) {
      return NextResponse.json(
        { error: 'name and category are required' },
        { status: 400 }
      );
    }

    // Create tool definition with platform variants
    const tool = await prisma.toolDefinition.create({
      data: {
        name,
        category,
        isEnabled,
        sortOrder,
        platformVariants: {
          create: platformVariants.map((variant: {
            platform: OSType;
            description: string;
            inputSchema: object;
            directives?: string;
            isAvailable?: boolean;
            requiresDisplay?: boolean;
            requiresBrowser?: boolean;
          }) => ({
            platform: variant.platform,
            description: variant.description,
            inputSchema: variant.inputSchema,
            directives: variant.directives,
            isAvailable: variant.isAvailable ?? true,
            requiresDisplay: variant.requiresDisplay ?? false,
            requiresBrowser: variant.requiresBrowser ?? false,
          })),
        },
      },
      include: {
        platformVariants: true,
      },
    });

    return NextResponse.json({ tool }, { status: 201 });
  } catch (error) {
    console.error('Error creating tool definition:', error);
    if ((error as { code?: string }).code === 'P2002') {
      return NextResponse.json(
        { error: 'Tool with this name already exists' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to create tool definition' },
      { status: 500 }
    );
  }
}
