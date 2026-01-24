/**
 * Tool Definition Detail API Route
 *
 * GET /api/tools/[id] - Get a specific tool definition
 * PUT /api/tools/[id] - Update a tool definition
 * DELETE /api/tools/[id] - Delete a tool definition
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { OSType, ToolCategory } from '@prisma/client';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;

  // Check authentication
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const tool = await prisma.toolDefinition.findUnique({
    where: { id },
    include: {
      platformVariants: true,
      agentCapabilities: {
        include: {
          agent: {
            select: {
              id: true,
              hostname: true,
              osType: true,
              status: true,
            },
          },
        },
      },
    },
  });

  if (!tool) {
    return NextResponse.json(
      { error: 'Tool not found' },
      { status: 404 }
    );
  }

  return NextResponse.json({ tool });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;

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
    const { category, isEnabled, sortOrder, platformVariants } = body;

    // Build update data
    const updateData: {
      category?: typeof ToolCategory[keyof typeof ToolCategory];
      isEnabled?: boolean;
      sortOrder?: number;
    } = {};
    if (category !== undefined && Object.values(ToolCategory).includes(category)) {
      updateData.category = category as typeof ToolCategory[keyof typeof ToolCategory];
    }
    if (isEnabled !== undefined) updateData.isEnabled = isEnabled;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    // Update tool definition
    const tool = await prisma.toolDefinition.update({
      where: { id },
      data: updateData,
      include: {
        platformVariants: true,
      },
    });

    // Update platform variants if provided
    if (platformVariants && Array.isArray(platformVariants)) {
      for (const variant of platformVariants) {
        if (variant.id) {
          // Update existing variant
          await prisma.toolPlatformVariant.update({
            where: { id: variant.id },
            data: {
              description: variant.description,
              inputSchema: variant.inputSchema,
              directives: variant.directives,
              isAvailable: variant.isAvailable,
              requiresDisplay: variant.requiresDisplay,
              requiresBrowser: variant.requiresBrowser,
            },
          });
        } else if (variant.platform) {
          // Upsert variant by platform
          await prisma.toolPlatformVariant.upsert({
            where: {
              toolId_platform: {
                toolId: id,
                platform: variant.platform as OSType,
              },
            },
            update: {
              description: variant.description,
              inputSchema: variant.inputSchema,
              directives: variant.directives,
              isAvailable: variant.isAvailable,
              requiresDisplay: variant.requiresDisplay,
              requiresBrowser: variant.requiresBrowser,
            },
            create: {
              toolId: id,
              platform: variant.platform as OSType,
              description: variant.description,
              inputSchema: variant.inputSchema,
              directives: variant.directives,
              isAvailable: variant.isAvailable ?? true,
              requiresDisplay: variant.requiresDisplay ?? false,
              requiresBrowser: variant.requiresBrowser ?? false,
            },
          });
        }
      }
    }

    // Fetch updated tool with variants
    const updatedTool = await prisma.toolDefinition.findUnique({
      where: { id },
      include: {
        platformVariants: true,
      },
    });

    return NextResponse.json({ tool: updatedTool });
  } catch (error) {
    console.error('Error updating tool definition:', error);
    return NextResponse.json(
      { error: 'Failed to update tool definition' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;

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
    await prisma.toolDefinition.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting tool definition:', error);
    return NextResponse.json(
      { error: 'Failed to delete tool definition' },
      { status: 500 }
    );
  }
}
