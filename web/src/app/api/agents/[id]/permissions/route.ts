/**
 * Agent Permissions API Route
 *
 * GET /api/agents/[id]/permissions - Get agent permissions
 * PATCH /api/agents/[id]/permissions - Update agent permissions (admin or owner only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/agents/[id]/permissions - Get agent permissions
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, role: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: 'User not found' },
      { status: 404 }
    );
  }

  const { id } = await context.params;

  // Find agent - admin can see any agent, users can only see their own
  const agent = await prisma.agent.findFirst({
    where: user.role === 'ADMIN'
      ? { id }
      : { id, ownerUserId: user.id },
    select: {
      id: true,
      masterModeEnabled: true,
      fileTransferEnabled: true,
      localSettingsLocked: true,
      permissionsLockedAt: true,
      permissionsLockedById: true,
      permissionsLockedBy: {
        select: {
          email: true,
          name: true,
        },
      },
    },
  });

  if (!agent) {
    return NextResponse.json(
      { error: 'Agent not found' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    permissions: {
      masterMode: agent.masterModeEnabled,
      fileTransfer: agent.fileTransferEnabled,
      localSettingsLocked: agent.localSettingsLocked,
      lockedAt: agent.permissionsLockedAt,
      lockedBy: agent.permissionsLockedBy,
    },
  });
}

/**
 * PATCH /api/agents/[id]/permissions - Update agent permissions
 *
 * Body: {
 *   masterMode?: boolean,
 *   fileTransfer?: boolean,
 *   localSettingsLocked?: boolean
 * }
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  const session = await getServerSession();
  if (!session?.user?.email) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, role: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: 'User not found' },
      { status: 404 }
    );
  }

  const { id } = await context.params;

  // Find agent - admin can update any agent, users can only update their own
  const agent = await prisma.agent.findFirst({
    where: user.role === 'ADMIN'
      ? { id }
      : { id, ownerUserId: user.id },
  });

  if (!agent) {
    return NextResponse.json(
      { error: 'Agent not found or access denied' },
      { status: 404 }
    );
  }

  try {
    const body = await request.json();
    const { masterMode, fileTransfer, localSettingsLocked } = body;

    // Build update data
    type UpdateData = {
      masterModeEnabled?: boolean;
      fileTransferEnabled?: boolean;
      localSettingsLocked?: boolean;
      permissionsLockedAt?: Date | null;
      permissionsLockedById?: string | null;
    };

    const updateData: UpdateData = {};

    if (masterMode !== undefined) {
      updateData.masterModeEnabled = Boolean(masterMode);
    }

    if (fileTransfer !== undefined) {
      updateData.fileTransferEnabled = Boolean(fileTransfer);
    }

    if (localSettingsLocked !== undefined) {
      updateData.localSettingsLocked = Boolean(localSettingsLocked);

      // Track who locked the settings and when
      if (localSettingsLocked) {
        updateData.permissionsLockedAt = new Date();
        updateData.permissionsLockedById = user.id;
      } else {
        updateData.permissionsLockedAt = null;
        updateData.permissionsLockedById = null;
      }
    }

    const updatedAgent = await prisma.agent.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        masterModeEnabled: true,
        fileTransferEnabled: true,
        localSettingsLocked: true,
        permissionsLockedAt: true,
        permissionsLockedBy: {
          select: {
            email: true,
            name: true,
          },
        },
      },
    });

    // Log the permission change
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        agentId: id,
        action: 'PERMISSIONS_UPDATED',
        details: {
          changes: {
            masterMode: masterMode !== undefined ? masterMode : undefined,
            fileTransfer: fileTransfer !== undefined ? fileTransfer : undefined,
            localSettingsLocked: localSettingsLocked !== undefined ? localSettingsLocked : undefined,
          },
          updatedBy: user.role,
        },
      },
    });

    return NextResponse.json({
      permissions: {
        masterMode: updatedAgent.masterModeEnabled,
        fileTransfer: updatedAgent.fileTransferEnabled,
        localSettingsLocked: updatedAgent.localSettingsLocked,
        lockedAt: updatedAgent.permissionsLockedAt,
        lockedBy: updatedAgent.permissionsLockedBy,
      },
    });
  } catch (err) {
    console.error('[Permissions PATCH] Error:', err);
    return NextResponse.json(
      { error: 'Failed to update permissions' },
      { status: 500 }
    );
  }
}
