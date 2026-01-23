'use client';

import { useState, useEffect } from 'react';

interface UserSettings {
  id: string;
  email: string;
  name: string | null;
  companyName: string | null;
  billingEmail: string | null;
  vatNumber: string | null;
  createdAt: string;
  lastLogin: string | null;
}

interface Session {
  id: string;
  expires: string;
  current: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [vatNumber, setVatNumber] = useState('');

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchSessions();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      const data = await res.json();
      setSettings(data);
      setName(data.name || '');
      setCompanyName(data.companyName || '');
      setBillingEmail(data.billingEmail || '');
      setVatNumber(data.vatNumber || '');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/settings/sessions');
      if (!res.ok) throw new Error('Failed to fetch sessions');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      // Sessions are optional, don't show error
    }
  };

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, companyName, billingEmail, vatNumber }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      showMessage('success', 'Settings saved successfully');
      fetchSettings();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      showMessage('error', 'Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      showMessage('error', 'Password must be at least 8 characters');
      return;
    }

    setChangingPassword(true);

    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to change password');
      }

      showMessage('success', 'Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSignOutAll = async () => {
    if (!confirm('This will sign you out of all devices. Continue?')) return;

    try {
      const res = await fetch('/api/settings/sessions', {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to sign out');

      showMessage('success', 'Signed out of all other devices');
      fetchSessions();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to sign out');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 mt-1">
          Manage your account settings and preferences.
        </p>
      </div>

      {/* Message Banner */}
      {message && (
        <div className={`mb-6 p-4 rounded-lg ${
          message.type === 'success'
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-red-500/10 border border-red-500/20 text-red-400'
        }`}>
          {message.text}
        </div>
      )}

      {/* Profile Settings */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl mb-6">
        <div className="p-6 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Profile</h2>
          <p className="text-slate-400 text-sm mt-1">Your personal information and contact details.</p>
        </div>
        <form onSubmit={handleSaveProfile} className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={settings?.email || ''}
                disabled
                className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg text-slate-400 cursor-not-allowed"
              />
              <p className="text-slate-500 text-xs mt-1">Email cannot be changed</p>
            </div>

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-slate-300 mb-1">
                Full Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="John Doe"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-700">
            <h3 className="text-md font-medium text-white mb-4">Billing Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="companyName" className="block text-sm font-medium text-slate-300 mb-1">
                  Company Name
                </label>
                <input
                  id="companyName"
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Acme Inc."
                />
              </div>

              <div>
                <label htmlFor="billingEmail" className="block text-sm font-medium text-slate-300 mb-1">
                  Billing Email
                </label>
                <input
                  id="billingEmail"
                  type="email"
                  value={billingEmail}
                  onChange={(e) => setBillingEmail(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="billing@company.com"
                />
                <p className="text-slate-500 text-xs mt-1">Invoices will be sent to this email</p>
              </div>

              <div>
                <label htmlFor="vatNumber" className="block text-sm font-medium text-slate-300 mb-1">
                  VAT Number
                </label>
                <input
                  id="vatNumber"
                  type="text"
                  value={vatNumber}
                  onChange={(e) => setVatNumber(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="GB123456789"
                />
                <p className="text-slate-500 text-xs mt-1">For EU businesses</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-4">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white px-6 py-2 rounded-lg font-medium transition"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Password Change */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl mb-6">
        <div className="p-6 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Change Password</h2>
          <p className="text-slate-400 text-sm mt-1">Update your password to keep your account secure.</p>
        </div>
        <form onSubmit={handleChangePassword} className="p-6 space-y-4">
          <div>
            <label htmlFor="currentPassword" className="block text-sm font-medium text-slate-300 mb-1">
              Current Password
            </label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter current password"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-slate-300 mb-1">
                New Password
              </label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter new password"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300 mb-1">
                Confirm New Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Confirm new password"
              />
            </div>
          </div>

          <div className="flex justify-end pt-4">
            <button
              type="submit"
              disabled={changingPassword || !currentPassword || !newPassword}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-medium transition"
            >
              {changingPassword ? 'Changing...' : 'Change Password'}
            </button>
          </div>
        </form>
      </div>

      {/* Active Sessions */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl mb-6">
        <div className="p-6 border-b border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Active Sessions</h2>
            <p className="text-slate-400 text-sm mt-1">Devices where you&apos;re currently signed in.</p>
          </div>
          {sessions.length > 1 && (
            <button
              onClick={handleSignOutAll}
              className="text-red-400 hover:text-red-300 text-sm font-medium"
            >
              Sign out all other devices
            </button>
          )}
        </div>
        <div className="divide-y divide-slate-700">
          {sessions.length === 0 ? (
            <div className="p-6 text-center text-slate-400">
              No active sessions
            </div>
          ) : (
            sessions.map((sess) => (
              <div key={sess.id} className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-slate-700 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-medium">
                      {sess.current ? 'This device' : 'Other device'}
                    </p>
                    <p className="text-slate-400 text-sm">
                      Expires: {new Date(sess.expires).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {sess.current && (
                  <span className="text-green-400 text-xs font-medium bg-green-500/10 px-2 py-1 rounded">
                    Current
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Account Info */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl">
        <div className="p-6 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Account Information</h2>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex justify-between">
            <span className="text-slate-400">Account ID</span>
            <span className="text-white font-mono text-sm">{settings?.id || 'N/A'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Member Since</span>
            <span className="text-white">
              {settings?.createdAt
                ? new Date(settings.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })
                : 'N/A'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Last Login</span>
            <span className="text-white">
              {settings?.lastLogin
                ? new Date(settings.lastLogin).toLocaleString()
                : 'N/A'}
            </span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="mt-6 bg-red-500/5 border border-red-500/20 rounded-xl">
        <div className="p-6 border-b border-red-500/20">
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white font-medium">Delete Account</p>
              <p className="text-slate-400 text-sm">
                Permanently delete your account and all associated data.
              </p>
            </div>
            <button
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition"
              onClick={() => alert('Contact support to delete your account')}
            >
              Delete Account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
