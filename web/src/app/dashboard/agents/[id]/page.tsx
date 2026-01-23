'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type BrowserType = 'SYSTEM' | 'CHROME' | 'FIREFOX' | 'SAFARI' | 'EDGE' | null;

interface Permissions {
  masterMode: boolean;
  fileTransfer: boolean;
  localSettingsLocked: boolean;
  lockedAt: string | null;
  lockedBy: {
    email: string;
    name: string | null;
  } | null;
}

interface Agent {
  id: string;
  agentKey: string;
  hostname: string;
  displayName: string | null;
  machineId: string;
  machineFingerprint: string | null;
  fingerprintRaw: Record<string, unknown> | null;
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
  currentTask: string | null;
  ipAddress: string | null;
  localIpAddress: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastActivity: string | null;
  activatedAt: string | null;
  label: string | null;
  groupName: string | null;
  tags: string[];
  defaultBrowser: BrowserType;
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

const browserOptions = [
  { value: 'SYSTEM', label: 'System Default', icon: '🌐' },
  { value: 'CHROME', label: 'Chrome', icon: '🔵' },
  { value: 'FIREFOX', label: 'Firefox', icon: '🦊' },
  { value: 'SAFARI', label: 'Safari', icon: '🧭' },
  { value: 'EDGE', label: 'Edge', icon: '🔷' },
];

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function AgentDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [label, setLabel] = useState('');
  const [editDisplayNameMode, setEditDisplayNameMode] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showResetSecretModal, setShowResetSecretModal] = useState(false);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [permissionSaving, setPermissionSaving] = useState<string | null>(null);

  // Display name preference
  const [nameDisplay, setNameDisplay] = useState<'friendly' | 'machine' | 'both'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('agentNameDisplay') as 'friendly' | 'machine' | 'both') || 'friendly';
    }
    return 'friendly';
  });

  const fetchAgent = async () => {
    try {
      const res = await fetch(`/api/agents/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError('Agent not found');
        } else {
          throw new Error('Failed to fetch agent');
        }
        return;
      }
      const data = await res.json();
      setAgent(data.agent);
      setLabel(data.agent.label || '');
      setDisplayName(data.agent.displayName || '');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const fetchPermissions = async () => {
    try {
      const res = await fetch(`/api/agents/${id}/permissions`);
      if (res.ok) {
        const data = await res.json();
        setPermissions(data.permissions);
      }
    } catch (err) {
      console.error('Failed to fetch permissions:', err);
    }
  };

  const updatePermission = async (key: 'masterMode' | 'fileTransfer' | 'localSettingsLocked', value: boolean) => {
    setPermissionSaving(key);
    try {
      const res = await fetch(`/api/agents/${id}/permissions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error('Failed to update permission');
      const data = await res.json();
      setPermissions(data.permissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update permission');
    } finally {
      setPermissionSaving(null);
    }
  };

  useEffect(() => {
    fetchAgent();
    fetchPermissions();
    const interval = setInterval(fetchAgent, 5000);
    return () => clearInterval(interval);
  }, [id]);

  const handleStateChange = async (newState: string) => {
    setActionLoading(newState);
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState }),
      });
      if (!res.ok) throw new Error('Failed to update state');
      await fetchAgent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleLabelSave = async () => {
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error('Failed to update label');
      await fetchAgent();
      setEditMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleDisplayNameSave = async () => {
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error('Failed to update friendly name');
      await fetchAgent();
      setEditDisplayNameMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleDelete = async () => {
    try {
      const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete agent');
      router.push('/dashboard/agents');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setShowDeleteModal(false);
    }
  };

  const handleResetSecret = async () => {
    try {
      setActionLoading('RESET_SECRET');
      const res = await fetch(`/api/agents/${id}/reset-secret`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to reset secret');
      setShowResetSecretModal(false);
      // Show success message
      setError(null);
      alert('Agent secret reset successfully. The agent can now re-register with a new API key.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset secret failed');
    } finally {
      setActionLoading(null);
      setShowResetSecretModal(false);
    }
  };

  const handleBrowserChange = async (browser: BrowserType) => {
    setBrowserSaving(true);
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultBrowser: browser }),
      });
      if (!res.ok) throw new Error('Failed to update browser preference');
      await fetchAgent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save browser preference');
    } finally {
      setBrowserSaving(false);
    }
  };

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return 'Never';
    const date = new Date(ts);
    return date.toLocaleString();
  };

  const formatRelativeTime = (ts: string | null) => {
    if (!ts) return 'Never';
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} minutes ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
    return `${Math.floor(diff / 86400000)} days ago`;
  };

  const formatAgentName = () => {
    if (!agent) return '';
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

  if (error || !agent) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/agents" className="text-blue-400 hover:text-blue-300">
          &larr; Back to Agents
        </Link>
        <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
          {error || 'Agent not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard/agents" className="text-slate-400 hover:text-white">
            &larr;
          </Link>
          <span className="text-4xl">{osIcons[agent.osType] || '💻'}</span>
          <div>
            {editMode ? (
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={agent.hostname}
                  className="px-3 py-1 bg-slate-700 border border-slate-600 rounded text-white"
                />
                <button
                  onClick={handleLabelSave}
                  className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  className="px-3 py-1 bg-slate-600 text-white rounded hover:bg-slate-500"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <h1
                className="text-2xl font-bold text-white cursor-pointer hover:text-blue-400"
                onClick={() => setEditMode(true)}
                title="Click to edit label"
              >
                {formatAgentName()}
              </h1>
            )}
            <p className="text-slate-400 text-sm">
              {agent.osType} {agent.osVersion} • {agent.arch}
            </p>
          </div>
        </div>
      </div>

      {/* Status Badges */}
      <div className="flex flex-wrap gap-3 items-center">
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-white ${statusColors[agent.status]}`}>
          {agent.status === 'ONLINE' && (
            <span className="w-2 h-2 bg-white rounded-full mr-2 animate-pulse"></span>
          )}
          {agent.status}
        </span>
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-white ${stateColors[agent.state]}`}>
          {agent.state}
        </span>
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-white ${powerStateColors[agent.powerState]}`}>
          Power: {agent.powerState}
        </span>
        {agent.isScreenLocked && (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-yellow-400 bg-yellow-900/50">
            🔒 Screen Locked
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-slate-400 text-sm">Name Display:</label>
          <select
            value={nameDisplay}
            onChange={(e) => handleNameDisplayChange(e.target.value as 'friendly' | 'machine' | 'both')}
            className="px-3 py-1 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="friendly">Friendly Name</option>
            <option value="machine">Machine Name</option>
            <option value="both">Both</option>
          </select>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="bg-slate-800 rounded-lg p-4">
        <h3 className="text-white font-medium mb-3">Actions</h3>
        <div className="flex flex-wrap gap-3">
          {/* Connect Button - only for ONLINE + ACTIVE agents */}
          {agent.status === 'ONLINE' && agent.state === 'ACTIVE' && (
            <Link
              href={`/dashboard/viewer/${agent.id}`}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
            >
              <span>Connect to Screen</span>
            </Link>
          )}

          {/* Separator if connect is shown */}
          {agent.status === 'ONLINE' && agent.state === 'ACTIVE' && (
            <div className="w-px h-8 bg-slate-600 mx-2"></div>
          )}

          {agent.state === 'PENDING' && (
            <button
              onClick={() => handleStateChange('ACTIVE')}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {actionLoading === 'ACTIVE' ? 'Activating...' : 'Activate Agent'}
            </button>
          )}
          {agent.state === 'ACTIVE' && (
            <button
              onClick={() => handleStateChange('PENDING')}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50"
            >
              {actionLoading === 'PENDING' ? 'Deactivating...' : 'Deactivate Agent'}
            </button>
          )}
          {agent.state !== 'BLOCKED' && (
            <button
              onClick={() => handleStateChange('BLOCKED')}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {actionLoading === 'BLOCKED' ? 'Blocking...' : 'Block Agent'}
            </button>
          )}
          {agent.state === 'BLOCKED' && (
            <button
              onClick={() => handleStateChange('PENDING')}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {actionLoading === 'PENDING' ? 'Unblocking...' : 'Unblock Agent'}
            </button>
          )}

          {/* Separator */}
          <div className="w-px h-8 bg-slate-600 mx-2"></div>

          {/* Reset Secret Button */}
          <button
            onClick={() => setShowResetSecretModal(true)}
            disabled={actionLoading !== null}
            className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
          >
            {actionLoading === 'RESET_SECRET' ? 'Resetting...' : 'Reset Secret'}
          </button>

          {/* Delete Button */}
          <button
            onClick={() => setShowDeleteModal(true)}
            disabled={actionLoading !== null}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            Delete Agent
          </button>
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Machine Info */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">Machine Information</h3>
          <dl className="space-y-3">
            <div className="flex justify-between items-center">
              <dt className="text-slate-400">Friendly Name</dt>
              {editDisplayNameMode ? (
                <dd className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={agent.hostname}
                    className="px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-sm"
                  />
                  <button
                    onClick={handleDisplayNameSave}
                    className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditDisplayNameMode(false)}
                    className="px-2 py-1 bg-slate-600 text-white text-xs rounded hover:bg-slate-500"
                  >
                    Cancel
                  </button>
                </dd>
              ) : (
                <dd
                  className="text-white cursor-pointer hover:text-blue-400"
                  onClick={() => setEditDisplayNameMode(true)}
                  title="Click to edit friendly name"
                >
                  {agent.displayName || <span className="text-slate-500 italic">Not set</span>}
                </dd>
              )}
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Hostname</dt>
              <dd className="text-white">{agent.hostname}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Machine ID</dt>
              <dd className="text-white font-mono text-sm">{agent.machineId}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">OS Type</dt>
              <dd className="text-white">{agent.osType}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">OS Version</dt>
              <dd className="text-white">{agent.osVersion || 'Unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Architecture</dt>
              <dd className="text-white">{agent.arch || 'Unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Agent Version</dt>
              <dd className="text-white">{agent.agentVersion || 'Unknown'}</dd>
            </div>
          </dl>
        </div>

        {/* Network Info */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">Network</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-400">Public IP</dt>
              <dd className="text-white font-mono">{agent.ipAddress || 'Unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Local IP</dt>
              <dd className="text-white font-mono">{agent.localIpAddress || 'Unknown'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Customer ID</dt>
              <dd className="text-white font-mono text-sm">{agent.customerId || 'None'}</dd>
            </div>
          </dl>
        </div>

        {/* License Info */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">License</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-400">State</dt>
              <dd>
                <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium text-white ${stateColors[agent.state]}`}>
                  {agent.state}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">License UUID</dt>
              <dd className="text-white font-mono text-sm break-all">
                {agent.licenseUuid || 'Not licensed'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Activated At</dt>
              <dd className="text-white">{formatTimestamp(agent.activatedAt)}</dd>
            </div>
          </dl>
        </div>

        {/* Activity Info */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">Activity</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-400">First Seen</dt>
              <dd className="text-white">{formatTimestamp(agent.firstSeenAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Last Seen</dt>
              <dd className="text-white">
                {formatTimestamp(agent.lastSeenAt)}
                <span className="text-slate-400 text-sm ml-2">
                  ({formatRelativeTime(agent.lastSeenAt)})
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Last Activity</dt>
              <dd className="text-white">{formatTimestamp(agent.lastActivity)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Current Task</dt>
              <dd className="text-white">{agent.currentTask || 'None'}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Browser Settings */}
      <div className="bg-slate-800 rounded-lg p-4">
        <h3 className="text-white font-medium mb-4">Browser Settings</h3>
        <p className="text-slate-400 text-sm mb-4">
          Select the default browser for LLM tools. When an AI uses browser automation tools,
          it will use this browser unless a specific browser is requested.
        </p>
        <div className="flex flex-wrap gap-3">
          {browserOptions.map((option) => {
            const isSelected = (agent.defaultBrowser || 'SYSTEM') === option.value;
            return (
              <button
                key={option.value}
                onClick={() => handleBrowserChange(option.value as BrowserType)}
                disabled={browserSaving}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${
                  isSelected
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
                } ${browserSaving ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="text-lg">{option.icon}</span>
                <span>{option.label}</span>
                {isSelected && <span className="ml-1 text-xs">&#10003;</span>}
              </button>
            );
          })}
        </div>
        {browserSaving && (
          <p className="text-blue-400 text-sm mt-3">Saving...</p>
        )}
      </div>

      {/* Agent Permissions */}
      {permissions && (
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">Agent Permissions</h3>
          <p className="text-slate-400 text-sm mb-4">
            Server-controlled permissions that are pushed to the agent via heartbeat.
            Changes take effect on the agent&apos;s next heartbeat.
          </p>
          <div className="space-y-4">
            {/* Master Controller Mode */}
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <div>
                <div className="text-white font-medium">Master Controller Mode</div>
                <p className="text-slate-400 text-sm">
                  Enable two-way STDIO communication for remote control of other agents
                </p>
              </div>
              <button
                onClick={() => updatePermission('masterMode', !permissions.masterMode)}
                disabled={permissionSaving === 'masterMode'}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  permissions.masterMode ? 'bg-blue-600' : 'bg-slate-600'
                } ${permissionSaving === 'masterMode' ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    permissions.masterMode ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* File Transfer */}
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <div>
                <div className="text-white font-medium">File Transfer</div>
                <p className="text-slate-400 text-sm">
                  Allow file uploads and downloads between agents
                </p>
              </div>
              <button
                onClick={() => updatePermission('fileTransfer', !permissions.fileTransfer)}
                disabled={permissionSaving === 'fileTransfer'}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  permissions.fileTransfer ? 'bg-blue-600' : 'bg-slate-600'
                } ${permissionSaving === 'fileTransfer' ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    permissions.fileTransfer ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Lock Local Settings */}
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <div>
                <div className="text-white font-medium">Lock Local Settings</div>
                <p className="text-slate-400 text-sm">
                  Prevent local user from changing settings via tray/menu app
                </p>
                {permissions.localSettingsLocked && permissions.lockedAt && (
                  <p className="text-yellow-400 text-xs mt-1">
                    Locked {permissions.lockedBy?.name || permissions.lockedBy?.email || 'by admin'} on {new Date(permissions.lockedAt).toLocaleString()}
                  </p>
                )}
              </div>
              <button
                onClick={() => updatePermission('localSettingsLocked', !permissions.localSettingsLocked)}
                disabled={permissionSaving === 'localSettingsLocked'}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  permissions.localSettingsLocked ? 'bg-yellow-600' : 'bg-slate-600'
                } ${permissionSaving === 'localSettingsLocked' ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    permissions.localSettingsLocked ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fingerprint Details */}
      {agent.fingerprintRaw && (
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-white font-medium mb-4">Hardware Fingerprint</h3>
          <div className="bg-slate-900 rounded p-3 font-mono text-sm text-slate-300 overflow-x-auto">
            <pre>{JSON.stringify(agent.fingerprintRaw, null, 2)}</pre>
          </div>
          {agent.machineFingerprint && (
            <p className="mt-2 text-slate-400 text-sm">
              Hash: <code className="text-slate-300">{agent.machineFingerprint}</code>
            </p>
          )}
        </div>
      )}

      {/* Reset Secret Confirmation Modal */}
      {showResetSecretModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold text-white mb-4">Reset Agent Secret?</h3>
            <p className="text-slate-300 mb-6">
              This will clear the stored API key for <strong>{agent.label || agent.hostname}</strong>.
              The agent will be able to re-register with a new API key on its next connection.
              Use this if the agent&apos;s API key has changed (e.g., after reinstallation).
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowResetSecretModal(false)}
                className="px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-500"
              >
                Cancel
              </button>
              <button
                onClick={handleResetSecret}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700"
              >
                Reset Secret
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold text-white mb-4">Delete Agent?</h3>
            <p className="text-slate-300 mb-6">
              Are you sure you want to delete <strong>{agent.label || agent.hostname}</strong>?
              This action cannot be undone. The agent will need to be re-registered if you want
              to use it again.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-500"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
