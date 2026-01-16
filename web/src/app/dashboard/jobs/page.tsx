'use client';

import { useState, useEffect } from 'react';
import { Toast, useToast } from '@/components/Toast';
import Link from 'next/link';

interface JobType {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  category: string;
  defaultPrompt: string;
  isSystem: boolean;
}

interface JobRun {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  successCount: number;
  failureCount: number;
  issuesFound: number;
}

interface ScheduledJob {
  id: string;
  name: string;
  description: string | null;
  cronExpression: string;
  timezone: string;
  targetAgentIds: string[];
  runParallel: boolean;
  customPrompt: string | null;
  notifyEmail: string | null;
  notifyOn: string;
  isEnabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  jobType: JobType | null;
  runs: JobRun[];
}

interface Agent {
  id: string;
  hostname: string | null;
  displayName: string | null;
  machineId: string;
  status: string;
}

const CRON_PRESETS = [
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 2 AM', value: '0 2 * * *' },
  { label: 'Daily at 6 AM', value: '0 6 * * *' },
  { label: 'Weekly (Sunday midnight)', value: '0 0 * * 0' },
  { label: 'Monthly (1st at midnight)', value: '0 0 1 * *' },
];

export default function JobsPage() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);
  const { messages: toastMessages, showToast, dismissToast } = useToast();

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    jobTypeId: '',
    cronExpression: '0 2 * * *',
    timezone: 'UTC',
    targetAgentIds: [] as string[],
    runParallel: true,
    customPrompt: '',
    notifyEmail: '',
    notifyOn: 'ISSUES',
    isEnabled: true,
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    await Promise.all([fetchJobs(), fetchJobTypes(), fetchAgents()]);
    setLoading(false);
  };

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to load jobs');
    }
  };

  const fetchJobTypes = async () => {
    try {
      const res = await fetch('/api/jobs/types');
      if (!res.ok) throw new Error('Failed to fetch job types');
      const data = await res.json();
      setJobTypes(data.jobTypes || []);
    } catch (err) {
      console.error('Failed to fetch job types:', err);
    }
  };

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents');
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  };

  const openCreateModal = () => {
    setEditingJob(null);
    setFormData({
      name: '',
      description: '',
      jobTypeId: jobTypes[0]?.id || '',
      cronExpression: '0 2 * * *',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      targetAgentIds: [],
      runParallel: true,
      customPrompt: '',
      notifyEmail: '',
      notifyOn: 'ISSUES',
      isEnabled: true,
    });
    setModalOpen(true);
  };

  const openEditModal = (job: ScheduledJob) => {
    setEditingJob(job);
    setFormData({
      name: job.name,
      description: job.description || '',
      jobTypeId: job.jobType?.id || '',
      cronExpression: job.cronExpression,
      timezone: job.timezone,
      targetAgentIds: job.targetAgentIds,
      runParallel: job.runParallel,
      customPrompt: job.customPrompt || '',
      notifyEmail: job.notifyEmail || '',
      notifyOn: job.notifyOn,
      isEnabled: job.isEnabled,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingJob(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const url = editingJob ? `/api/jobs/${editingJob.id}` : '/api/jobs';
      const method = editingJob ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save job');
      }

      showToast('success', editingJob ? 'Job updated' : 'Job created');
      closeModal();
      fetchJobs();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save job');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (jobId: string) => {
    if (!confirm('Are you sure you want to delete this job?')) return;

    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete job');
      showToast('success', 'Job deleted');
      fetchJobs();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete job');
    }
  };

  const handleTrigger = async (jobId: string) => {
    setTriggering(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/trigger`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to trigger job');
      showToast('success', 'Job triggered');
      fetchJobs();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to trigger job');
    } finally {
      setTriggering(null);
    }
  };

  const handleToggleEnabled = async (job: ScheduledJob) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !job.isEnabled }),
      });
      if (!res.ok) throw new Error('Failed to update job');
      fetchJobs();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update job');
    }
  };

  const updateForm = (field: string, value: unknown) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const toggleAgent = (agentId: string) => {
    setFormData(prev => ({
      ...prev,
      targetAgentIds: prev.targetAgentIds.includes(agentId)
        ? prev.targetAgentIds.filter(id => id !== agentId)
        : [...prev.targetAgentIds, agentId],
    }));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'text-green-400 bg-green-500/10';
      case 'FAILED': return 'text-red-400 bg-red-500/10';
      case 'PARTIAL': return 'text-yellow-400 bg-yellow-500/10';
      case 'RUNNING': return 'text-blue-400 bg-blue-500/10';
      default: return 'text-slate-400 bg-slate-500/10';
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'HEALTH': return 'text-green-400 bg-green-500/10';
      case 'MAINTENANCE': return 'text-blue-400 bg-blue-500/10';
      case 'SECURITY': return 'text-red-400 bg-red-500/10';
      case 'BACKUP': return 'text-purple-400 bg-purple-500/10';
      default: return 'text-slate-400 bg-slate-500/10';
    }
  };

  const getAgentName = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    return agent?.displayName || agent?.hostname || agent?.machineId || agentId;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  return (
    <>
      <Toast messages={toastMessages} onDismiss={dismissToast} />

      <div className="max-w-6xl mx-auto">
        {/* Page Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Scheduled Jobs</h1>
            <p className="text-slate-400 mt-1">
              Automate health checks, maintenance, and monitoring tasks across your agents.
            </p>
          </div>
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Job
          </button>
        </div>

        {/* Jobs List */}
        {jobs.length === 0 ? (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-12 text-center">
            <svg className="w-16 h-16 mx-auto mb-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 className="text-xl font-semibold text-white mb-2">No scheduled jobs yet</h2>
            <p className="text-slate-400 mb-6">
              Create your first job to automate health checks and maintenance tasks.
            </p>
            <button
              onClick={openCreateModal}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition"
            >
              Create Your First Job
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {jobs.map(job => (
              <div key={job.id} className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      {/* Enable toggle */}
                      <button
                        onClick={() => handleToggleEnabled(job)}
                        className={`mt-1 w-10 h-6 rounded-full transition-colors ${
                          job.isEnabled ? 'bg-green-500' : 'bg-slate-600'
                        }`}
                      >
                        <div className={`w-4 h-4 bg-white rounded-full transition-transform mx-1 ${
                          job.isEnabled ? 'translate-x-4' : ''
                        }`} />
                      </button>

                      <div>
                        <div className="flex items-center gap-3">
                          <h3 className="text-lg font-semibold text-white">{job.name}</h3>
                          {job.jobType && (
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${getCategoryColor(job.jobType.category)}`}>
                              {job.jobType.category}
                            </span>
                          )}
                        </div>
                        {job.description && (
                          <p className="text-slate-400 text-sm mt-1">{job.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
                          <span title="Schedule">
                            <code className="bg-slate-700 px-2 py-0.5 rounded">{job.cronExpression}</code>
                          </span>
                          <span>{job.targetAgentIds.length} agent(s)</span>
                          {job.runParallel && <span>Parallel</span>}
                          {job.nextRunAt && (
                            <span>Next: {new Date(job.nextRunAt).toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTrigger(job.id)}
                        disabled={triggering === job.id}
                        className="p-2 text-slate-400 hover:text-green-400 hover:bg-green-500/10 rounded-lg transition disabled:opacity-50"
                        title="Run now"
                      >
                        {triggering === job.id ? (
                          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => openEditModal(job)}
                        className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
                        title="Edit"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition"
                        title="Delete"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Recent runs */}
                  {job.runs.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-700">
                      <p className="text-sm text-slate-400 mb-2">Recent runs:</p>
                      <div className="flex flex-wrap gap-2">
                        {job.runs.slice(0, 5).map(run => (
                          <Link
                            key={run.id}
                            href={`/dashboard/jobs/${job.id}/runs/${run.id}`}
                            className={`px-3 py-1.5 rounded text-sm flex items-center gap-2 hover:opacity-80 transition ${getStatusColor(run.status)}`}
                          >
                            <span>{run.status}</span>
                            {run.issuesFound > 0 && (
                              <span className="bg-black/20 px-1.5 py-0.5 rounded text-xs">
                                {run.issuesFound} issues
                              </span>
                            )}
                            <span className="text-xs opacity-70">
                              {new Date(run.startedAt).toLocaleDateString()}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={closeModal} />

          <div className="relative bg-slate-800 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b border-slate-700">
              <h2 className="text-xl font-semibold text-white">
                {editingJob ? 'Edit Job' : 'Create New Job'}
              </h2>
              <button
                onClick={closeModal}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSave} className="overflow-y-auto max-h-[calc(90vh-140px)]">
              <div className="p-6 space-y-6">
                {/* Basic Info */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Job Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={e => updateForm('name', e.target.value)}
                      className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Daily Health Check"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Description (optional)</label>
                    <input
                      type="text"
                      value={formData.description}
                      onChange={e => updateForm('description', e.target.value)}
                      className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Check Docker containers and disk space"
                    />
                  </div>

                  {jobTypes.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Job Type</label>
                      <select
                        value={formData.jobTypeId}
                        onChange={e => {
                          updateForm('jobTypeId', e.target.value);
                          const type = jobTypes.find(t => t.id === e.target.value);
                          if (type && !formData.customPrompt) {
                            updateForm('customPrompt', type.defaultPrompt);
                          }
                        }}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Custom (no template)</option>
                        {jobTypes.map(type => (
                          <option key={type.id} value={type.id}>
                            {type.displayName} ({type.category})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Schedule */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-white">Schedule</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Cron Expression</label>
                      <input
                        type="text"
                        value={formData.cronExpression}
                        onChange={e => updateForm('cronExpression', e.target.value)}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="0 2 * * *"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Preset</label>
                      <select
                        value=""
                        onChange={e => {
                          if (e.target.value) updateForm('cronExpression', e.target.value);
                        }}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select a preset...</option>
                        {CRON_PRESETS.map(preset => (
                          <option key={preset.value} value={preset.value}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1">Timezone</label>
                    <input
                      type="text"
                      value={formData.timezone}
                      onChange={e => updateForm('timezone', e.target.value)}
                      className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="UTC"
                    />
                  </div>
                </div>

                {/* Target Agents */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Target Agents</h3>
                    <label className="flex items-center gap-2 text-sm text-slate-400">
                      <input
                        type="checkbox"
                        checked={formData.runParallel}
                        onChange={e => updateForm('runParallel', e.target.checked)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500"
                      />
                      Run in parallel
                    </label>
                  </div>

                  <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 max-h-48 overflow-y-auto">
                    {agents.length === 0 ? (
                      <p className="text-slate-400 text-sm">No agents available</p>
                    ) : (
                      <div className="space-y-2">
                        {agents.map(agent => (
                          <label
                            key={agent.id}
                            className="flex items-center gap-3 p-2 hover:bg-slate-800 rounded cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={formData.targetAgentIds.includes(agent.id)}
                              onChange={() => toggleAgent(agent.id)}
                              className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500"
                            />
                            <span className="text-white">
                              {agent.displayName || agent.hostname || agent.machineId}
                            </span>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              agent.status === 'ONLINE' ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-400'
                            }`}>
                              {agent.status}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-slate-500 text-xs">
                    {formData.targetAgentIds.length} agent(s) selected
                  </p>
                </div>

                {/* Custom Prompt */}
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Instructions (AI Prompt)
                  </label>
                  <textarea
                    value={formData.customPrompt}
                    onChange={e => updateForm('customPrompt', e.target.value)}
                    className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    placeholder="Check Docker containers with `docker ps -a` and `docker stats --no-stream`. Report any containers using >90% memory or that have restarted more than 3 times."
                    rows={5}
                  />
                  <p className="text-slate-500 text-xs mt-1">
                    Describe what commands to run and what to check. Use backticks for commands.
                  </p>
                </div>

                {/* Notifications */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-white">Notifications</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Email (optional)</label>
                      <input
                        type="email"
                        value={formData.notifyEmail}
                        onChange={e => updateForm('notifyEmail', e.target.value)}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="admin@example.com"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Notify When</label>
                      <select
                        value={formData.notifyOn}
                        onChange={e => updateForm('notifyOn', e.target.value)}
                        className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="NEVER">Never</option>
                        <option value="ISSUES">When issues found</option>
                        <option value="FAILURE">On failure</option>
                        <option value="ALWAYS">Always</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Enable */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isEnabled}
                    onChange={e => updateForm('isEnabled', e.target.checked)}
                    className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-blue-500"
                  />
                  <div>
                    <span className="text-white font-medium">Enable Job</span>
                    <p className="text-slate-400 text-sm">Run this job according to the schedule</p>
                  </div>
                </label>
              </div>

              <div className="flex justify-end gap-3 p-6 border-t border-slate-700">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || formData.targetAgentIds.length === 0}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg font-medium transition"
                >
                  {saving ? 'Saving...' : editingJob ? 'Save Changes' : 'Create Job'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
