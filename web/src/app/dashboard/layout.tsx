import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { authOptions } from '@/lib/auth-options';
import { prisma } from '@/lib/prisma';
import { isDebugMode } from '@/lib/debug';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/login');
  }

  // Fetch online agent count for the badge
  const onlineAgentCount = await prisma.agent.count({
    where: {
      status: 'ONLINE',
    },
  });

  return (
    <div className="min-h-screen bg-slate-900">
      {/* Top Navigation */}
      <nav className="bg-slate-800 border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">SC</span>
              </div>
              <span className="text-xl font-bold text-white">ScreenControl</span>
            </Link>

            {/* Navigation Links */}
            <div className="hidden md:flex items-center gap-6">
              <Link href="/dashboard" className="text-slate-300 hover:text-white transition">
                Dashboard
              </Link>
              <Link href="/dashboard/agents" className="text-slate-300 hover:text-white transition flex items-center gap-2">
                Agents
                {onlineAgentCount > 0 && (
                  <span className="bg-green-500 text-white text-xs font-medium px-2 py-0.5 rounded-full">
                    {onlineAgentCount}
                  </span>
                )}
              </Link>
              <Link href="/dashboard/connections" className="text-slate-300 hover:text-white transition">
                Connections
              </Link>
              <Link href="/dashboard/licenses" className="text-slate-300 hover:text-white transition">
                Licenses
              </Link>
              <Link href="/dashboard/email-agent" className="text-slate-300 hover:text-white transition">
                Email Agent
              </Link>
              <Link href="/dashboard/jobs" className="text-slate-300 hover:text-white transition">
                Jobs
              </Link>
              <Link href="/dashboard/settings" className="text-slate-300 hover:text-white transition">
                Settings
              </Link>
              <Link href="/dashboard/help" className="text-slate-300 hover:text-white transition">
                Help
              </Link>
              <Link href="/dashboard/downloads" className="text-slate-300 hover:text-white transition">
                Downloads
              </Link>
              {isDebugMode() && (
                <Link href="/dashboard/debug" className="text-orange-400 hover:text-orange-300 transition">
                  Debug
                </Link>
              )}
            </div>

            {/* User Menu */}
            <div className="flex items-center gap-4">
              <span className="text-slate-400 text-sm hidden sm:block">
                {session.user?.email}
              </span>
              <Link
                href="/api/auth/signout"
                className="text-slate-300 hover:text-white text-sm transition"
              >
                Sign out
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
