/**
 * File Transfer Status API
 *
 * Get status or cancel a specific transfer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { fileTransferManager } from '@/lib/control-server/file-transfer-manager';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/transfers/[id]
 * Get transfer status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const status = await fileTransferManager.getStatus(id);
    if (!status) {
      return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    }

    // Verify user owns this transfer
    const transfer = await prisma.fileTransfer.findUnique({
      where: { transferId: id },
      select: { initiatorUserId: true },
    });

    if (transfer?.initiatorUserId !== session.user.id) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json(status);
  } catch (error) {
    console.error('[API] Failed to get transfer status:', error);
    return NextResponse.json(
      { error: 'Failed to get transfer status' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/transfers/[id]
 * Cancel a transfer
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    // Verify user owns this transfer
    const transfer = await prisma.fileTransfer.findUnique({
      where: { transferId: id },
      select: { initiatorUserId: true, status: true },
    });

    if (!transfer) {
      return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    }

    if (transfer.initiatorUserId !== session.user.id) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (transfer.status !== 'PENDING' && transfer.status !== 'TRANSFERRING') {
      return NextResponse.json(
        { error: 'Transfer cannot be cancelled (already completed or failed)' },
        { status: 400 }
      );
    }

    await fileTransferManager.cancelTransfer(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] Failed to cancel transfer:', error);
    return NextResponse.json(
      { error: 'Failed to cancel transfer' },
      { status: 500 }
    );
  }
}
