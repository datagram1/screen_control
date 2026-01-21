'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Agent {
  id: string;
  agentKey: string;
  hostname: string;
  displayName: string | null;
  machineId: string;
  customerId: string | null;
  licenseUuid: string | null;
  osType: 'MACOS' | 'WINDOWS' | 'LINUX';
  osVersion: string | null;
  arch: string | null;
  agentVersion: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'SUSPENDED';
  state: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'EXPIRED';
  powerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
  isScreenLocked: boolean;
  hasDisplay: boolean;
  currentTask: string | null;
  ipAddress: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastActivity: string | null;
  activatedAt: string | null;
  label: string | null;
  groupName: string | null;
  tags: string[];
}

interface Stats {
  total: number;
  online: number;
  offline: number;
  byState: Record<string, number>;
  byOS: Record<string, number>;
}

const osIcons: Record<string, string> = {
  MACOS: '🍎',
  WINDOWS: '🪟',
  LINUX: '🐧',
};

const statusColors: Record<string, string> = {
  ONLINE: 'bg-green-500',
  OFFLINE: 'bg-gray-500',
  SUSPENDED: 'bg-red-500',
};

const stateColors: Record<string, string> = {
  PENDING: 'bg-yellow-500',
  ACTIVE: 'bg-green-500',
  BLOCKED: 'bg-red-500',
  EXPIRED: 'bg-gray-500',
};

const powerStateColors: Record<string, string> = {
  ACTIVE: 'bg-green-400',
  PASSIVE: 'bg-blue-400',
  SLEEP: 'bg-purple-400',
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [stateFilter, setStateFilter] = useState<string>('');
  const [osFilter, setOsFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Display name preference
  const [nameDisplay, setNameDisplay] = useState<'friendly' | 'machine' | 'both'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('agentNameDisplay') as 'friendly' | 'machine' | 'both') || 'friendly';
    }
    return 'friendly';
  });

  // Action loading states
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAgents = async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (stateFilter) params.set('state', stateFilter);
      if (osFilter) params.set('osType', osFilter);
      if (searchQuery) params.set('search', searchQuery);

      const url = `/api/agents${params.toString() ? `?${params}` : ''}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error('Failed to fetch agents');
      }

      const data = await res.json();
      setAgents(data.agents);
      setStats(data.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
    // Poll for updates every 10 seconds
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, [statusFilter, stateFilter, osFilter, searchQuery]);

  const handleAction = async (agentId: string, action: string, newState?: string) => {
    setActionLoading(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState }),
      });

      if (!res.ok) {
        throw new Error(`Failed to ${action} agent`);
      }

      // Refresh the list
      await fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  const formatTimestamp = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  const formatAgentName = (agent: Agent) => {
    const friendlyName = agent.displayName || agent.hostname;
    const machineName = agent.hostname;

    switch (nameDisplay) {
      case 'friendly':
        return friendlyName;
      case 'machine':
        return machineName;
      case 'both':
        return agent.displayName ? `${agent.displayName} <${machineName}>` : machineName;
      default:
        return friendlyName;
    }
  };

  const handleNameDisplayChange = (value: 'friendly' | 'machine' | 'both') => {
    setNameDisplay(value);
    localStorage.setItem('agentNameDisplay', value);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          <p className="text-slate-400 text-sm mt-1">
            Manage your connected screen control agents
          </p>
        </div>
        <Link
          href="/dashboard/connections"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Download Agent
        </Link>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-slate-400 text-sm">Total Agents</div>
            <div className="text-2xl font-bold text-white">{stats.total}</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-slate-400 text-sm">Online</div>
            <div className="text-2xl font-bold text-green-400">{stats.online}</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-slate-400 text-sm">Offline</div>
            <div className="text-2xl font-bold text-gray-400">{stats.offline}</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="text-slate-400 text-sm">Active</div>
            <div className="text-2xl font-bold text-blue-400">
              {stats.byState.ACTIVE || 0}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-slate-800 rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div>
            <label className="block text-slate-400 text-sm mb-1">Search</label>
            <input
              type="text"
              placeholder="Search by hostname..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-slate-400 text-sm mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">All</option>
              <option value="ONLINE">Online</option>
              <option value="OFFLINE">Offline</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-sm mb-1">State</label>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="ACTIVE">Active</option>
              <option value="BLOCKED">Blocked</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-sm mb-1">OS Type</label>
            <select
              value={osFilter}
              onChange={(e) => setOsFilter(e.target.value)}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="">All</option>
              <option value="MACOS">macOS</option>
              <option value="WINDOWS">Windows</option>
              <option value="LINUX">Linux</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-sm mb-1">Name Display</label>
            <select
              value={nameDisplay}
              onChange={(e) => handleNameDisplayChange(e.target.value as 'friendly' | 'machine' | 'both')}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="friendly">Friendly Name</option>
              <option value="machine">Machine Name</option>
              <option value="both">Both</option>
            </select>
          </div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Agents List */}
      {agents.length === 0 ? (
        <div className="bg-slate-800 rounded-lg p-12 text-center">
          <div className="text-6xl mb-4">🖥️</div>
          <h3 className="text-xl font-semibold text-white mb-2">No agents connected yet</h3>
          <p className="text-slate-400 mb-6">
            Download and install an agent on your machines to start controlling them remotely.
          </p>
          <Link
            href="/dashboard/connections"
            className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Download Agent
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-lg overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-slate-700">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-300">Machine</th>
                <th className="px-2 py-3 text-center text-sm font-medium text-slate-300 w-12" title="Online Status">●</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-slate-300">State</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-slate-300">Power</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-slate-300">Last Seen</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-slate-300">IP</th>
                <th className="px-3 py-3 text-left text-sm font-medium text-slate-300">Version</th>
                <th className="px-3 py-3 text-center text-sm font-medium text-slate-300">Connect</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-slate-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-slate-700/50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/agents/${agent.id}`} className="flex items-center space-x-3">
                      <span className="text-2xl">{osIcons[agent.osType] || '💻'}</span>
                      <div>
                        <div className="text-white font-medium hover:text-blue-400">
                          {formatAgentName(agent)}
                        </div>
                        <div className="text-slate-400 text-sm">
                          {agent.osType} {agent.osVersion || ''} • {agent.arch || 'unknown'}
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td className="px-2 py-3 text-center">
                    <span
                      className={`inline-block w-3 h-3 rounded-full ${statusColors[agent.status]} ${agent.status === 'ONLINE' ? 'animate-pulse shadow-lg shadow-green-500/50' : ''}`}
                      title={agent.status === 'ONLINE' ? 'Online' : agent.status === 'OFFLINE' ? 'Offline' : 'Suspended'}
                    ></span>
                    {agent.isScreenLocked && (
                      <span className="ml-1 text-yellow-500 text-xs" title="Screen locked">🔒</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium text-white ${stateColors[agent.state]}`}>
                      {agent.state}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium text-white ${powerStateColors[agent.powerState]}`}>
                      {agent.powerState}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-300 text-sm whitespace-nowrap">
                    {formatTimestamp(agent.lastSeenAt)}
                  </td>
                  <td className="px-3 py-3 text-slate-400 text-sm font-mono whitespace-nowrap">
                    {agent.ipAddress || '-'}
                  </td>
                  <td className="px-3 py-3 text-slate-300 text-sm font-mono">
                    {agent.agentVersion || '-'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    {agent.status === 'ONLINE' && agent.state === 'ACTIVE' ? (
                      <div className="flex justify-center space-x-2">
                        {/* Screen/GUI connection - only for machines with display */}
                        {agent.hasDisplay !== false && (
                          <Link
                            href={`/dashboard/viewer/${agent.id}`}
                            className="p-1.5 bg-slate-700 hover:bg-blue-600 text-slate-300 hover:text-white rounded transition-colors"
                            title="Connect to screen (GUI)"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                              <line x1="8" y1="21" x2="16" y2="21"></line>
                              <line x1="12" y1="17" x2="12" y2="21"></line>
                            </svg>
                          </Link>
                        )}
                        {/* Terminal connection - available for all machines */}
                        <Link
                          href={`/dashboard/terminal/${agent.id}`}
                          className="p-1.5 bg-slate-700 hover:bg-green-600 text-slate-300 hover:text-white rounded transition-colors"
                          title="Connect to terminal (CLI)"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="4 17 10 11 4 5"></polyline>
                            <line x1="12" y1="19" x2="20" y2="19"></line>
                          </svg>
                        </Link>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-sm">-</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end space-x-1.5 flex-nowrap">
                      {/* Activate button for PENDING agents */}
                      {agent.state === 'PENDING' && (
                        <button
                          onClick={() => handleAction(agent.id, 'activate', 'ACTIVE')}
                          disabled={actionLoading === agent.id}
                          className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          {actionLoading === agent.id ? '...' : 'Activate'}
                        </button>
                      )}

                      {/* Deactivate button for ACTIVE agents */}
                      {agent.state === 'ACTIVE' && (
                        <button
                          onClick={() => handleAction(agent.id, 'deactivate', 'PENDING')}
                          disabled={actionLoading === agent.id}
                          className="px-2 py-1 bg-yellow-600 text-white text-xs rounded hover:bg-yellow-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                          title="Deactivate agent"
                        >
                          Deact.
                        </button>
                      )}

                      {/* Block button (except for already blocked) */}
                      {agent.state !== 'BLOCKED' && (
                        <button
                          onClick={() => handleAction(agent.id, 'block', 'BLOCKED')}
                          disabled={actionLoading === agent.id}
                          className="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                          title="Block agent"
                        >
                          Block
                        </button>
                      )}

                      {/* Unblock button for BLOCKED agents */}
                      {agent.state === 'BLOCKED' && (
                        <button
                          onClick={() => handleAction(agent.id, 'unblock', 'PENDING')}
                          disabled={actionLoading === agent.id}
                          className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          Unblock
                        </button>
                      )}

                      {/* Wake button for sleeping agents */}
                      {agent.powerState === 'SLEEP' && agent.status === 'ONLINE' && (
                        <button
                          onClick={() => handleAction(agent.id, 'wake', undefined)}
                          disabled={actionLoading === agent.id}
                          className="px-2 py-1 bg-purple-600 text-white text-xs rounded hover:bg-purple-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          Wake
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
