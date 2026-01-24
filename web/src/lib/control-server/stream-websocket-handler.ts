/**
 * Stream WebSocket Handler
 *
 * Handles WebSocket connections from viewers for screen streaming.
 */

import { WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { ViewerMessage, StreamSession } from './types';
import { streamSessionManager } from './stream-session-manager';
import { NetworkUtils } from './network';

/**
 * Handle a new viewer WebSocket connection for streaming
 */
export function handleStreamConnection(
  socket: WebSocket,
  req: IncomingMessage
): void {
  const remoteAddress = NetworkUtils.getClientIP(req);
  console.log(`[Stream] New viewer connection from ${remoteAddress}`);

  let session: StreamSession | null = null;
  let authenticated = false;

  // Set binary type for frame data
  socket.binaryType = 'arraybuffer';

  // Handle incoming messages
  socket.on('message', async (data: RawData, isBinary: boolean) => {
    try {
      // Binary messages are not expected from viewers
      if (isBinary) {
        console.warn('[Stream] Unexpected binary message from viewer');
        return;
      }

      const msg: ViewerMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case 'stream_start':
          // Authenticate with session token
          if (!msg.sessionToken) {
            socket.send(JSON.stringify({
              type: 'error',
              code: 'MISSING_TOKEN',
              error: 'Session token required',
            }));
            socket.close(4001, 'Missing token');
            return;
          }

          // Validate token (async - stored in database)
          const pending = await streamSessionManager.validateToken(msg.sessionToken);
          if (!pending) {
            socket.send(JSON.stringify({
              type: 'error',
              code: 'INVALID_TOKEN',
              error: 'Invalid or expired session token',
            }));
            socket.close(4002, 'Invalid token');
            return;
          }

          // Create session
          const result = await streamSessionManager.createSession(
            socket,
            remoteAddress,
            pending
          );

          if ('error' in result) {
            socket.send(JSON.stringify({
              type: 'error',
              code: 'SESSION_FAILED',
              error: result.error,
            }));
            socket.close(4003, 'Session creation failed');
            return;
          }

          session = result;
          authenticated = true;
          console.log(`[Stream] Viewer authenticated, session ${session.id}`);
          break;

        case 'stream_stop':
          if (session) {
            await streamSessionManager.endSession(session.id);
            session = null;
          }
          socket.close(1000, 'Stream stopped');
          break;

        case 'input':
          if (!session) {
            socket.send(JSON.stringify({
              type: 'error',
              code: 'NOT_AUTHENTICATED',
              error: 'Not authenticated',
            }));
            return;
          }

          await streamSessionManager.handleViewerInput(session.id, msg);
          break;

        case 'quality_change':
          if (!session) {
            return;
          }

          if (msg.quality !== undefined) {
            await streamSessionManager.handleQualityChange(
              session.id,
              msg.quality,
              msg.maxFps
            );
          }
          break;

        case 'refresh':
          if (!session) {
            return;
          }

          await streamSessionManager.requestRefresh(session.id);
          break;

        case 'ping':
          socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          console.warn(`[Stream] Unknown message type from viewer: ${(msg as any).type}`);
      }
    } catch (e) {
      console.error('[Stream] Message parse error:', e);
      socket.send(JSON.stringify({
        type: 'error',
        code: 'PARSE_ERROR',
        error: 'Invalid message format',
      }));
    }
  });

  // Handle disconnect
  socket.on('close', async (code, reason) => {
    if (session) {
      await streamSessionManager.endSession(session.id);
    }
    console.log(`[Stream] Viewer disconnected: ${code} ${reason.toString()}`);
  });

  // Handle errors
  socket.on('error', (err) => {
    console.error('[Stream] Socket error:', err);
  });

  // Send initial ping to verify connection
  socket.send(JSON.stringify({
    type: 'pong',
    message: 'Connected to stream server',
    timestamp: Date.now(),
  }));
}
