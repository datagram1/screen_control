'use client';

import { useState, useEffect, useRef, useCallback, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

// Dynamic import of xterm to avoid SSR issues
const XTermComponent = dynamic(
  () => import('@/components/XTermComponent'),
  { ssr: false }
);

interface TerminalState {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  sessionId?: string;
}

interface PageProps {
  params: Promise<{ agentId: string }>;
}

export default function TerminalPage({ params }: PageProps) {
  const { agentId } = use(params);
  const router = useRouter();
  const wsRef = useRef<WebSocket | null>(null);

  const [terminalState, setTerminalState] = useState<TerminalState>({
    status: 'connecting',
  });
  const [agentInfo, setAgentInfo] = useState<{ hostname: string; osType: string } | null>(null);
  const [writeToTerminal, setWriteToTerminal] = useState<((data: string) => void) | null>(null);
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);
  const focusTerminalRef = useRef<(() => void) | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    writeToTerminalRef.current = writeToTerminal;
  }, [writeToTerminal]);

  // Request terminal session and connect
  const connect = useCallback(async () => {
    setTerminalState({ status: 'connecting' });

    try {
      // Request terminal session token
      const tokenRes = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });

      if (!tokenRes.ok) {
        const data = await tokenRes.json();
        throw new Error(data.error || 'Failed to get terminal token');
      }

      const tokenData = await tokenRes.json();
      setAgentInfo(tokenData.agent);

      // Connect to WebSocket
      const ws = new WebSocket(tokenData.wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send terminal_start with token
        ws.send(JSON.stringify({
          type: 'terminal_start',
          sessionToken: tokenData.token,
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      };

      ws.onerror = () => {
        setTerminalState({
          status: 'error',
          error: 'WebSocket connection error',
        });
      };

      ws.onclose = (event) => {
        if (terminalState.status !== 'error') {
          setTerminalState({
            status: 'disconnected',
            error: event.reason || 'Connection closed',
          });
        }
      };
    } catch (err) {
      setTerminalState({
        status: 'error',
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    }
  }, [agentId]);

  // Handle incoming messages
  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'terminal_started':
        setTerminalState({
          status: 'connected',
          sessionId: msg.sessionId as string,
        });
        // Write welcome message (use ref for current value)
        if (writeToTerminalRef.current) {
          writeToTerminalRef.current(`\r\n\x1b[32mConnected to ${agentInfo?.hostname || 'remote host'}\x1b[0m\r\n\r\n`);
        }
        // Focus terminal for Playwright/automated access
        if (focusTerminalRef.current) {
          focusTerminalRef.current();
        }
        break;

      case 'terminal_output':
        // Output from the shell (use ref for current value)
        if (writeToTerminalRef.current && typeof msg.data === 'string') {
          writeToTerminalRef.current(msg.data);
        }
        break;

      case 'terminal_error':
        setTerminalState({
          status: 'error',
          error: msg.error as string,
        });
        break;

      case 'terminal_stopped':
        setTerminalState({
          status: 'disconnected',
          error: 'Terminal session ended',
        });
        break;

      case 'error':
        setTerminalState({
          status: 'error',
          error: msg.error as string,
        });
        break;
    }
  }, [agentInfo]); // Uses writeToTerminalRef which is stable

  // Disconnect
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setTerminalState({ status: 'disconnected' });
  }, []);

  // Handle terminal input
  const handleTerminalInput = useCallback((data: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'terminal_input',
        data,
      }));
    }
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Handle reconnect when writeToTerminal becomes available
  useEffect(() => {
    if (writeToTerminal && terminalState.status === 'connected' && agentInfo) {
      writeToTerminal(`\r\n\x1b[32mConnected to ${agentInfo.hostname}\x1b[0m\r\n`);
      writeToTerminal(`\x1b[90mOS: ${agentInfo.osType}\x1b[0m\r\n\r\n`);
    }
  }, [writeToTerminal, terminalState.status, agentInfo]);

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard/agents"
            className="text-gray-400 hover:text-white transition-colors"
          >
            &larr; Back to Agents
          </Link>
          <span className="text-gray-500">|</span>
          <div className="flex items-center gap-2">
            <span className="text-white font-medium">
              {agentInfo?.hostname || 'Connecting...'}
            </span>
            {agentInfo?.osType && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">
                {agentInfo.osType}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Status indicator */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                terminalState.status === 'connected'
                  ? 'bg-green-500'
                  : terminalState.status === 'connecting'
                  ? 'bg-yellow-500 animate-pulse'
                  : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-400 capitalize">
              {terminalState.status}
            </span>
          </div>

          {/* Reconnect button */}
          {terminalState.status === 'disconnected' && (
            <button
              onClick={connect}
              className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
            >
              Reconnect
            </button>
          )}

          {/* Disconnect button */}
          {terminalState.status === 'connected' && (
            <button
              onClick={disconnect}
              className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 relative">
        {terminalState.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 z-10">
            <div className="text-center">
              <div className="text-red-500 text-lg mb-2">Connection Error</div>
              <div className="text-gray-400 mb-4">{terminalState.error}</div>
              <button
                onClick={connect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        <XTermComponent
          onInput={handleTerminalInput}
          onReady={(write, focus) => {
            setWriteToTerminal(() => write);
            focusTerminalRef.current = focus;
            // Initial focus for Playwright
            focus();
          }}
        />
      </div>
    </div>
  );
}
