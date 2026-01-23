/**
 * File Transfer Manager
 *
 * Handles chunked file transfers between agents through the control server.
 * Files are transferred in chunks to avoid memory issues with large files.
 */

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../prisma';
import { agentRegistry } from './agent-registry';

// Chunk size for file transfers (256KB)
const CHUNK_SIZE = 256 * 1024;

// Maximum file size (1GB)
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

// Transfer timeout (30 minutes)
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

export interface TransferRequest {
  sourceAgentId: string;
  destAgentId: string;
  sourcePath: string;
  destPath: string;
  initiatorUserId: string;
}

export interface TransferStatus {
  transferId: string;
  status: 'PENDING' | 'TRANSFERRING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  fileName: string;
  fileSize: bigint;
  bytesTransferred: bigint;
  progress: number;
  errorMessage?: string;
  createdAt: Date;
  completedAt?: Date;
}

interface ActiveTransfer {
  transferId: string;
  sourceAgentId: string;
  destAgentId: string;
  sourcePath: string;
  destPath: string;
  fileName: string;
  fileSize: bigint;
  checksum: string;
  totalChunks: number;
  currentChunk: number;
  bytesTransferred: bigint;
  startedAt: Date;
  timeout: NodeJS.Timeout;
}

class FileTransferManager {
  private activeTransfers = new Map<string, ActiveTransfer>();

  /**
   * Initiate a file transfer between two agents
   */
  async initiateTransfer(request: TransferRequest): Promise<string> {
    const { sourceAgentId, destAgentId, sourcePath, destPath, initiatorUserId } = request;

    // Validate agents are connected and have file transfer enabled
    const sourceAgent = agentRegistry.getAgent(sourceAgentId);
    const destAgent = agentRegistry.getAgent(destAgentId);

    if (!sourceAgent) {
      throw new Error(`Source agent not connected: ${sourceAgentId}`);
    }
    if (!destAgent) {
      throw new Error(`Destination agent not connected: ${destAgentId}`);
    }

    // Check agent permissions from database
    const [sourceDbAgent, destDbAgent] = await Promise.all([
      prisma.agent.findUnique({ where: { id: sourceAgentId }, select: { fileTransferEnabled: true } }),
      prisma.agent.findUnique({ where: { id: destAgentId }, select: { fileTransferEnabled: true } }),
    ]);

    if (!sourceDbAgent?.fileTransferEnabled) {
      throw new Error('Source agent does not have file transfer enabled');
    }
    if (!destDbAgent?.fileTransferEnabled) {
      throw new Error('Destination agent does not have file transfer enabled');
    }

    // Get file info from source agent
    const fileInfo = await this.getFileInfo(sourceAgentId, sourcePath);
    if (!fileInfo) {
      throw new Error(`File not found on source agent: ${sourcePath}`);
    }

    if (fileInfo.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${fileInfo.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    const transferId = uuidv4();
    const fileName = sourcePath.split('/').pop() || sourcePath.split('\\').pop() || 'unknown';

    // Create transfer record in database
    await prisma.fileTransfer.create({
      data: {
        transferId,
        sourceAgentId,
        destAgentId,
        initiatorUserId,
        fileName,
        sourcePath,
        destPath: destPath || sourcePath,
        fileSize: BigInt(fileInfo.size),
        status: 'PENDING',
      },
    });

    // Calculate chunks
    const totalChunks = Math.ceil(Number(fileInfo.size) / CHUNK_SIZE);

    // Set up active transfer tracking
    const timeout = setTimeout(() => {
      this.handleTransferTimeout(transferId);
    }, TRANSFER_TIMEOUT_MS);

    const transfer: ActiveTransfer = {
      transferId,
      sourceAgentId,
      destAgentId,
      sourcePath,
      destPath: destPath || sourcePath,
      fileName,
      fileSize: BigInt(fileInfo.size),
      checksum: fileInfo.checksum,
      totalChunks,
      currentChunk: 0,
      bytesTransferred: BigInt(0),
      startedAt: new Date(),
      timeout,
    };

    this.activeTransfers.set(transferId, transfer);

    // Start the transfer
    this.processTransfer(transferId).catch((err) => {
      console.error(`[FileTransfer] Transfer ${transferId} failed:`, err);
      this.failTransfer(transferId, err.message);
    });

    console.log(`[FileTransfer] Initiated transfer ${transferId}: ${sourcePath} -> ${destPath}`);
    return transferId;
  }

  /**
   * Get file info from an agent
   */
  private async getFileInfo(
    agentId: string,
    filePath: string
  ): Promise<{ size: number; checksum: string } | null> {
    try {
      const result = await agentRegistry.sendCommand(agentId, 'tools/call', {
        name: 'files_info',
        arguments: { path: filePath },
      });

      if (result && typeof result === 'object' && 'content' in result) {
        const content = (result as { content: Array<{ text?: string }> }).content;
        if (content && content[0]?.text) {
          const info = JSON.parse(content[0].text);
          return {
            size: info.size,
            checksum: info.checksum || '',
          };
        }
      }
      return null;
    } catch (err) {
      console.error(`[FileTransfer] Failed to get file info:`, err);
      return null;
    }
  }

  /**
   * Process a transfer by moving chunks from source to destination
   */
  private async processTransfer(transferId: string): Promise<void> {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    // Update status to TRANSFERRING
    await prisma.fileTransfer.update({
      where: { transferId },
      data: { status: 'TRANSFERRING' },
    });

    // Prepare destination for receiving
    await this.prepareDestination(transfer.destAgentId, transfer.destPath);

    // Transfer chunks
    for (let i = 0; i < transfer.totalChunks; i++) {
      const activeTransfer = this.activeTransfers.get(transferId);
      if (!activeTransfer) {
        console.log(`[FileTransfer] Transfer ${transferId} cancelled`);
        return;
      }

      // Read chunk from source
      const chunk = await this.readChunk(transfer.sourceAgentId, transfer.sourcePath, i);
      if (!chunk) {
        throw new Error(`Failed to read chunk ${i} from source`);
      }

      // Write chunk to destination
      const writeSuccess = await this.writeChunk(
        transfer.destAgentId,
        transfer.destPath,
        i,
        chunk.data,
        i === transfer.totalChunks - 1
      );

      if (!writeSuccess) {
        throw new Error(`Failed to write chunk ${i} to destination`);
      }

      // Update progress
      activeTransfer.currentChunk = i + 1;
      activeTransfer.bytesTransferred += BigInt(chunk.size);

      await prisma.fileTransfer.update({
        where: { transferId },
        data: { bytesTransferred: activeTransfer.bytesTransferred },
      });
    }

    // Verify checksum at destination
    if (transfer.checksum) {
      const destInfo = await this.getFileInfo(transfer.destAgentId, transfer.destPath);
      if (destInfo?.checksum && destInfo.checksum !== transfer.checksum) {
        throw new Error('Checksum mismatch after transfer');
      }
    }

    // Complete the transfer
    await this.completeTransfer(transferId);
  }

  /**
   * Prepare destination path for receiving file
   */
  private async prepareDestination(agentId: string, destPath: string): Promise<void> {
    // Ensure parent directory exists
    const parentDir = destPath.substring(0, destPath.lastIndexOf('/')) ||
                      destPath.substring(0, destPath.lastIndexOf('\\'));

    if (parentDir) {
      try {
        await agentRegistry.sendCommand(agentId, 'tools/call', {
          name: 'fs_mkdir',
          arguments: { path: parentDir, recursive: true },
        });
      } catch {
        // Directory may already exist, ignore error
      }
    }
  }

  /**
   * Read a chunk from source agent
   */
  private async readChunk(
    agentId: string,
    filePath: string,
    chunkIndex: number
  ): Promise<{ data: string; size: number } | null> {
    try {
      const result = await agentRegistry.sendCommand(agentId, 'tools/call', {
        name: 'files_read_chunk',
        arguments: {
          path: filePath,
          chunkIndex,
          chunkSize: CHUNK_SIZE,
        },
      });

      if (result && typeof result === 'object' && 'content' in result) {
        const content = (result as { content: Array<{ text?: string }> }).content;
        if (content && content[0]?.text) {
          const chunkData = JSON.parse(content[0].text);
          return {
            data: chunkData.data, // Base64 encoded
            size: chunkData.size,
          };
        }
      }
      return null;
    } catch (err) {
      console.error(`[FileTransfer] Failed to read chunk ${chunkIndex}:`, err);
      return null;
    }
  }

  /**
   * Write a chunk to destination agent
   */
  private async writeChunk(
    agentId: string,
    filePath: string,
    chunkIndex: number,
    data: string,
    isFinal: boolean
  ): Promise<boolean> {
    try {
      const result = await agentRegistry.sendCommand(agentId, 'tools/call', {
        name: 'files_write_chunk',
        arguments: {
          path: filePath,
          chunkIndex,
          data, // Base64 encoded
          isFinal,
        },
      });

      if (result && typeof result === 'object' && 'content' in result) {
        const content = (result as { content: Array<{ text?: string }> }).content;
        if (content && content[0]?.text) {
          const response = JSON.parse(content[0].text);
          return response.success === true;
        }
      }
      return false;
    } catch (err) {
      console.error(`[FileTransfer] Failed to write chunk ${chunkIndex}:`, err);
      return false;
    }
  }

  /**
   * Complete a transfer successfully
   */
  private async completeTransfer(transferId: string): Promise<void> {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      clearTimeout(transfer.timeout);
      this.activeTransfers.delete(transferId);
    }

    await prisma.fileTransfer.update({
      where: { transferId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    console.log(`[FileTransfer] Transfer ${transferId} completed successfully`);
  }

  /**
   * Fail a transfer with error
   */
  private async failTransfer(transferId: string, errorMessage: string): Promise<void> {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      clearTimeout(transfer.timeout);
      this.activeTransfers.delete(transferId);
    }

    await prisma.fileTransfer.update({
      where: { transferId },
      data: {
        status: 'FAILED',
        errorMessage,
        completedAt: new Date(),
      },
    });

    console.error(`[FileTransfer] Transfer ${transferId} failed: ${errorMessage}`);
  }

  /**
   * Handle transfer timeout
   */
  private handleTransferTimeout(transferId: string): void {
    this.failTransfer(transferId, 'Transfer timed out');
  }

  /**
   * Cancel an active transfer
   */
  async cancelTransfer(transferId: string): Promise<void> {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      clearTimeout(transfer.timeout);
      this.activeTransfers.delete(transferId);
    }

    await prisma.fileTransfer.update({
      where: { transferId },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    console.log(`[FileTransfer] Transfer ${transferId} cancelled`);
  }

  /**
   * Get transfer status
   */
  async getStatus(transferId: string): Promise<TransferStatus | null> {
    const transfer = await prisma.fileTransfer.findUnique({
      where: { transferId },
    });

    if (!transfer) return null;

    const progress =
      transfer.fileSize > 0
        ? Number((transfer.bytesTransferred * BigInt(100)) / transfer.fileSize)
        : 0;

    return {
      transferId: transfer.transferId,
      status: transfer.status,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      bytesTransferred: transfer.bytesTransferred,
      progress,
      errorMessage: transfer.errorMessage || undefined,
      createdAt: transfer.createdAt,
      completedAt: transfer.completedAt || undefined,
    };
  }

  /**
   * Get all transfers for a user
   */
  async getTransfersForUser(userId: string): Promise<TransferStatus[]> {
    const transfers = await prisma.fileTransfer.findMany({
      where: { initiatorUserId: userId },
      orderBy: { createdAt: 'desc' },
    });

    return transfers.map((t) => ({
      transferId: t.transferId,
      status: t.status,
      fileName: t.fileName,
      fileSize: t.fileSize,
      bytesTransferred: t.bytesTransferred,
      progress: t.fileSize > 0 ? Number((t.bytesTransferred * BigInt(100)) / t.fileSize) : 0,
      errorMessage: t.errorMessage || undefined,
      createdAt: t.createdAt,
      completedAt: t.completedAt || undefined,
    }));
  }

  /**
   * Cleanup old completed/failed transfers from memory
   * (Database records are kept for history)
   */
  cleanup(): void {
    // Active transfers are cleaned up on completion/failure/cancel
    // This method can be called periodically if needed
    console.log(`[FileTransfer] Active transfers: ${this.activeTransfers.size}`);
  }
}

// Singleton instance
const globalForFileTransfer = globalThis as unknown as {
  fileTransferManager: FileTransferManager | undefined;
};

export const fileTransferManager =
  globalForFileTransfer.fileTransferManager ?? new FileTransferManager();

globalForFileTransfer.fileTransferManager = fileTransferManager;

export { FileTransferManager };
