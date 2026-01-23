/**
 * File Transfer API
 *
 * Endpoints for managing file transfers between agents.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { fileTransferManager } from '@/lib/control-server/file-transfer-manager';

/**
 * GET /api/transfers
 * List all transfers for the current user
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const transfers = await fileTransferManager.getTransfersForUser(session.user.id);
    return NextResponse.json({ transfers });
  } catch (error) {
    console.error('[API] Failed to get transfers:', error);
    return NextResponse.json(
      { error: 'Failed to get transfers' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/transfers
 * Initiate a new file transfer
 *
 * Body:
 * - sourceAgentId: string
 * - destAgentId: string
 * - sourcePath: string
 * - destPath: string (optional, defaults to sourcePath)
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { sourceAgentId, destAgentId, sourcePath, destPath } = body;

    if (!sourceAgentId || !destAgentId || !sourcePath) {
      return NextResponse.json(
        { error: 'Missing required fields: sourceAgentId, destAgentId, sourcePath' },
        { status: 400 }
      );
    }

    const transferId = await fileTransferManager.initiateTransfer({
      sourceAgentId,
      destAgentId,
      sourcePath,
      destPath: destPath || sourcePath,
      initiatorUserId: session.user.id,
    });

    return NextResponse.json({ transferId });
  } catch (error) {
    console.error('[API] Failed to initiate transfer:', error);
    const message = error instanceof Error ? error.message : 'Failed to initiate transfer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
