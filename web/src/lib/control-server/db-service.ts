/**
 * Database Service for Control Server
 *
 * Handles database operations for agents, connections, and command logging.
 */

import { prisma } from '@/lib/db';
import {
  ConnectedAgent,
  AgentMessage,
  PowerState,
  AgentState,
  OSType,
} from './types';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

// ═══════════════════════════════════════════════════════════════════════════
// Agent Database Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find or create an agent record in the database
 */
export async function findOrCreateAgent(
  msg: AgentMessage,
  remoteAddress: string
): Promise<{
  agentDbId: string;
  licenseStatus: 'active' | 'pending' | 'expired' | 'blocked';
  licenseUuid: string | null;
  isNew: boolean;
  secretError?: string;  // Set if agent secret validation failed
}> {
  // First, try to find existing agent by customerId + machineId
  let agent = await prisma.agent.findFirst({
    where: {
      customerId: msg.customerId || undefined,
      machineId: msg.machineId || undefined,
    },
    include: {
      license: true,
    },
  });

  let isNew = false;

  // If existing agent has a stored secret, validate the provided one
  if (agent?.agentSecretHash && msg.agentSecret) {
    const secretValid = await bcrypt.compare(msg.agentSecret, agent.agentSecretHash);
    if (!secretValid) {
      console.log(`[DB] Agent secret validation failed for ${agent.hostname || agent.machineId}`);
      return {
        agentDbId: agent.id,
        licenseStatus: 'blocked',
        licenseUuid: agent.licenseUuid,
        isNew: false,
        secretError: 'Agent secret does not match stored secret',
      };
    }
    console.log(`[DB] Agent secret validated for ${agent.hostname || agent.machineId}`);
  } else if (agent?.agentSecretHash && !msg.agentSecret) {
    // Agent has a stored secret but client didn't provide one
    console.log(`[DB] Agent has stored secret but none provided for ${agent.hostname || agent.machineId}`);
    return {
      agentDbId: agent.id,
      licenseStatus: 'blocked',
      licenseUuid: agent.licenseUuid,
      isNew: false,
      secretError: 'Agent secret required but not provided',
    };
  }

  if (!agent) {
    // Create new agent - need a license first
    // For now, create a default license for the agent
    // In production, this would be tied to the customer's subscription

    // First, we need a user. For development, use or create a default user
    let defaultUser = await prisma.user.findFirst({
      where: { email: 'system@screencontrol.local' },
    });

    if (!defaultUser) {
      defaultUser = await prisma.user.create({
        data: {
          email: 'system@screencontrol.local',
          name: 'System User',
          accountStatus: 'ACTIVE',
        },
      });
    }

    // Create a license for the new agent
    const license = await prisma.license.create({
      data: {
        userId: defaultUser.id,
        licenseKey: generateLicenseKey(),
        productType: 'AGENT',
        status: 'ACTIVE',
        isTrial: true,
        trialStarted: new Date(),
        trialEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      },
    });

    // Hash agent secret if provided
    let agentSecretHash: string | null = null;
    if (msg.agentSecret) {
      agentSecretHash = await bcrypt.hash(msg.agentSecret, 10);
      console.log(`[DB] Hashing agent secret for new agent ${msg.machineName || msg.machineId}`);
    }

    // Create the agent
    // Use customerId as ownerUserId if provided (customerId IS the user's ID from stamped installer)
    agent = await prisma.agent.create({
      data: {
        licenseId: license.id,
        agentKey: `agent_${uuidv4()}`,
        ownerUserId: msg.customerId || defaultUser.id,
        customerId: msg.customerId,
        machineId: msg.machineId,
        machineFingerprint: computeFingerprint(msg.fingerprint),
        fingerprintRaw: msg.fingerprint as object,
        hostname: msg.machineName || msg.fingerprint?.hostname,
        localUsername: msg.fingerprint?.username,
        osType: parseOSType(msg.osType),
        osVersion: msg.osVersion,
        arch: msg.arch,
        agentVersion: msg.agentVersion,
        cpuModel: msg.fingerprint?.cpuModel,
        ipAddress: remoteAddress,
        status: 'ONLINE',
        state: 'PENDING',
        powerState: 'ACTIVE',
        hasDisplay: msg.hasDisplay !== false, // Default true unless explicitly false
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        agentSecretHash,  // Store hashed secret on creation
      },
      include: {
        license: true,
      },
    });

    isNew = true;
  } else {
    // If existing agent doesn't have a secret yet but provides one, store it
    let agentSecretHashUpdate: string | undefined = undefined;
    if (!agent.agentSecretHash && msg.agentSecret) {
      agentSecretHashUpdate = await bcrypt.hash(msg.agentSecret, 10);
      console.log(`[DB] Storing agent secret for existing agent ${agent.hostname || agent.machineId}`);
    }

    // Update existing agent with new connection info
    agent = await prisma.agent.update({
      where: { id: agent.id },
      data: {
        hostname: msg.machineName || msg.fingerprint?.hostname || agent.hostname,
        osVersion: msg.osVersion || agent.osVersion,
        arch: msg.arch || agent.arch,
        agentVersion: msg.agentVersion || agent.agentVersion,
        ipAddress: remoteAddress,
        status: 'ONLINE',
        lastSeenAt: new Date(),
        hasDisplay: msg.hasDisplay !== false, // Update hasDisplay on reconnect
        // Only set agentSecretHash if we're storing it for the first time
        ...(agentSecretHashUpdate ? { agentSecretHash: agentSecretHashUpdate } : {}),
      },
      include: {
        license: true,
      },
    });

    // Check for fingerprint changes
    const newFingerprint = computeFingerprint(msg.fingerprint);
    if (agent.machineFingerprint !== newFingerprint && newFingerprint) {
      await logFingerprintChange(agent.id, {
        changeType: 'hardware_change',
        previousValue: agent.machineFingerprint,
        newValue: newFingerprint,
        actionTaken: 'logged',
      });

      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          machineFingerprint: newFingerprint,
          fingerprintRaw: msg.fingerprint as object,
        },
      });
    }
  }

  // Determine license status
  let licenseStatus: 'active' | 'pending' | 'expired' | 'blocked' = 'pending';

  if (agent.state === 'BLOCKED') {
    licenseStatus = 'blocked';
  } else if (agent.state === 'EXPIRED') {
    licenseStatus = 'expired';
  } else if (agent.state === 'ACTIVE') {
    licenseStatus = 'active';
  } else if (agent.license) {
    // Check license validity
    if (agent.license.status === 'ACTIVE') {
      if (agent.license.validUntil && agent.license.validUntil < new Date()) {
        licenseStatus = 'expired';
      } else if (agent.license.isTrial && agent.license.trialEnds && agent.license.trialEnds < new Date()) {
        licenseStatus = 'expired';
      } else {
        licenseStatus = 'active';
      }
    } else if (agent.license.status === 'EXPIRED') {
      licenseStatus = 'expired';
    } else if (agent.license.status === 'SUSPENDED') {
      licenseStatus = 'blocked';
    }
  }

  return {
    agentDbId: agent.id,
    licenseStatus,
    licenseUuid: agent.licenseUuid,
    isNew,
  };
}

/**
 * Update agent status when connection is established
 */
export async function markAgentOnline(
  agentDbId: string,
  sessionInfo: {
    ipAddress: string;
    powerState?: PowerState;
  }
): Promise<string> {
  // Create a new session
  const session = await prisma.agentSession.create({
    data: {
      agentId: agentDbId,
      ipAddress: sessionInfo.ipAddress,
    },
  });

  // Update agent status
  await prisma.agent.update({
    where: { id: agentDbId },
    data: {
      status: 'ONLINE',
      powerState: sessionInfo.powerState || 'ACTIVE',
      lastSeenAt: new Date(),
    },
  });

  return session.id;
}

/**
 * Update agent status when connection is lost
 */
export async function markAgentOffline(
  agentDbId: string,
  sessionId?: string
): Promise<void> {
  // Update agent status
  await prisma.agent.update({
    where: { id: agentDbId },
    data: {
      status: 'OFFLINE',
      currentTask: null,
    },
  });

  // Close the session if we have one
  if (sessionId) {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
    });

    if (session) {
      const durationMs = Date.now() - session.sessionStart.getTime();
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: {
          sessionEnd: new Date(),
          durationMinutes: Math.round(durationMs / 60000),
        },
      });
    }
  }
}

/**
 * Update agent heartbeat
 */
export async function updateAgentHeartbeat(
  agentDbId: string,
  status: {
    powerState?: PowerState;
    isScreenLocked?: boolean;
    hasDisplay?: boolean;
    currentTask?: string | null;
  }
): Promise<void> {
  await prisma.agent.update({
    where: { id: agentDbId },
    data: {
      lastSeenAt: new Date(),
      lastActivity: new Date(),
      powerState: status.powerState,
      isScreenLocked: status.isScreenLocked,
      hasDisplay: status.hasDisplay,
      currentTask: status.currentTask,
    },
  });
}

/**
 * Activate an agent (move from PENDING to ACTIVE)
 */
export async function activateAgent(agentDbId: string): Promise<string> {
  const licenseUuid = `lic_${uuidv4()}`;

  await prisma.agent.update({
    where: { id: agentDbId },
    data: {
      state: 'ACTIVE',
      licenseUuid,
      activatedAt: new Date(),
    },
  });

  return licenseUuid;
}

// ═══════════════════════════════════════════════════════════════════════════
// Command Logging
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Log a command being sent to an agent
 */
export async function logCommand(data: {
  agentId: string;
  aiConnectionId?: string;
  method: string;
  params?: Record<string, unknown>;
  toolName?: string;
  ipAddress?: string;
}): Promise<string> {
  const log = await prisma.commandLog.create({
    data: {
      agentId: data.agentId,
      aiConnectionId: data.aiConnectionId,
      method: data.method,
      params: data.params as object,
      toolName: data.toolName,
      status: 'SENT',
      ipAddress: data.ipAddress,
    },
  });

  return log.id;
}

/**
 * Update command log with result
 */
export async function updateCommandLog(
  logId: string,
  result: {
    status: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
    result?: unknown;
    errorMessage?: string;
  }
): Promise<void> {
  const log = await prisma.commandLog.findUnique({
    where: { id: logId },
  });

  if (log) {
    const durationMs = Date.now() - log.startedAt.getTime();

    await prisma.commandLog.update({
      where: { id: logId },
      data: {
        status: result.status,
        result: result.result as object,
        errorMessage: result.errorMessage,
        completedAt: new Date(),
        durationMs,
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Connection Tracking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create or update an AI connection
 */
export async function trackAIConnection(data: {
  sessionId: string;
  userId?: string;
  clientName?: string;
  clientVersion?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<string> {
  // Find existing by session ID
  let connection = await prisma.aIConnection.findUnique({
    where: { sessionId: data.sessionId },
  });

  if (connection) {
    // Update existing
    await prisma.aIConnection.update({
      where: { id: connection.id },
      data: {
        lastActivityAt: new Date(),
        isActive: true,
      },
    });
    return connection.id;
  }

  // Need a user ID - for now use system user
  let userId = data.userId;
  if (!userId) {
    const systemUser = await prisma.user.findFirst({
      where: { email: 'system@screencontrol.local' },
    });
    userId = systemUser?.id;
  }

  if (!userId) {
    throw new Error('No user available for AI connection');
  }

  // Create new connection
  connection = await prisma.aIConnection.create({
    data: {
      sessionId: data.sessionId,
      userId,
      clientName: data.clientName,
      clientVersion: data.clientVersion,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      isAuthorized: true, // Auto-authorize for now
      authorizedAt: new Date(),
    },
  });

  return connection.id;
}

/**
 * Mark AI connection as disconnected
 */
export async function closeAIConnection(sessionId: string): Promise<void> {
  await prisma.aIConnection.updateMany({
    where: { sessionId },
    data: {
      isActive: false,
      disconnectedAt: new Date(),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Fingerprint Change Logging
// ═══════════════════════════════════════════════════════════════════════════

async function logFingerprintChange(
  agentId: string,
  data: {
    changeType: string;
    previousValue?: string;
    newValue?: string;
    actionTaken: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  await prisma.fingerprintChange.create({
    data: {
      agentId,
      changeType: data.changeType,
      previousValue: data.previousValue,
      newValue: data.newValue,
      actionTaken: data.actionTaken,
      details: data.details as object,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

function generateLicenseKey(): string {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(
      crypto.randomBytes(2).toString('hex').toUpperCase()
    );
  }
  return `SC-${segments.join('-')}`;
}

function computeFingerprint(data?: AgentMessage['fingerprint']): string {
  if (!data) return '';

  const parts = [
    data.cpuModel || '',
    data.diskSerial || '',
    data.motherboardUuid || '',
    ...(data.macAddresses || []).sort(),
  ].filter(Boolean);

  if (parts.length === 0) return '';

  return crypto
    .createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');
}

function parseOSType(osType?: string): 'WINDOWS' | 'MACOS' | 'LINUX' {
  if (!osType) return 'MACOS';

  const lower = osType.toLowerCase();
  if (lower.includes('windows') || lower === 'win32') return 'WINDOWS';
  if (lower.includes('linux')) return 'LINUX';
  return 'MACOS';
}

// ═══════════════════════════════════════════════════════════════════════════
// License Status Check (1.2.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check current license status for an agent (fast DB query for heartbeat)
 */
export async function checkLicenseStatus(agentDbId: string): Promise<{
  licenseStatus: 'active' | 'pending' | 'expired' | 'blocked';
  changed: boolean;
  message?: string;
  defaultBrowser?: string;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    select: {
      state: true,
      defaultBrowser: true,
      license: {
        select: {
          status: true,
          validUntil: true,
          isTrial: true,
          trialEnds: true,
        },
      },
    },
  });

  if (!agent) {
    return { licenseStatus: 'blocked', changed: true, message: 'Agent not found' };
  }

  // Check blocked/expired state first
  if (agent.state === 'BLOCKED') {
    return { licenseStatus: 'blocked', changed: false };
  }
  if (agent.state === 'EXPIRED') {
    return { licenseStatus: 'expired', changed: false };
  }

  // Check license validity
  let newStatus: 'active' | 'pending' | 'expired' | 'blocked' = 'pending';
  let changed = false;
  let message: string | undefined;

  if (agent.license) {
    if (agent.license.status === 'SUSPENDED') {
      newStatus = 'blocked';
      message = 'License suspended';
    } else if (agent.license.status === 'EXPIRED') {
      newStatus = 'expired';
      message = 'License expired';
    } else if (agent.license.status === 'ACTIVE') {
      // Check expiry dates
      const now = new Date();
      if (agent.license.validUntil && agent.license.validUntil < now) {
        newStatus = 'expired';
        message = 'License validity period ended';
        changed = true;
        // Update the agent state in DB
        await prisma.agent.update({
          where: { id: agentDbId },
          data: { state: 'EXPIRED' },
        });
      } else if (agent.license.isTrial && agent.license.trialEnds && agent.license.trialEnds < now) {
        newStatus = 'expired';
        message = 'Trial period ended';
        changed = true;
        await prisma.agent.update({
          where: { id: agentDbId },
          data: { state: 'EXPIRED' },
        });
      } else {
        newStatus = 'active';
      }
    }
  }

  // Check if status changed from what agent has
  if (agent.state === 'ACTIVE' && newStatus !== 'active') {
    changed = true;
  } else if (agent.state === 'PENDING' && newStatus === 'active') {
    changed = true;
  }

  return {
    licenseStatus: newStatus,
    changed,
    message,
    defaultBrowser: agent.defaultBrowser?.toLowerCase() || undefined,
  };
}

/**
 * Check pre-conditions before forwarding a command (1.2.6)
 */
export async function checkCommandPreConditions(
  agentDbId: string,
  method: string
): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    select: {
      state: true,
      powerState: true,
      isScreenLocked: true,
      license: {
        select: { status: true },
      },
    },
  });

  if (!agent) {
    return { allowed: false, reason: 'Agent not found' };
  }

  // Check agent state
  if (agent.state === 'BLOCKED') {
    return { allowed: false, reason: 'Agent is blocked' };
  }
  if (agent.state === 'EXPIRED') {
    return { allowed: false, reason: 'License expired' };
  }

  // Check license
  if (agent.license?.status !== 'ACTIVE') {
    return { allowed: false, reason: 'License not active' };
  }

  // Allow PENDING agents for basic operations
  if (agent.state === 'PENDING') {
    const allowedForPending = ['ping', 'status', 'getInfo'];
    if (!allowedForPending.includes(method)) {
      return { allowed: false, reason: 'Agent awaiting activation - limited commands only' };
    }
  }

  // Screen lock check removed - the service handles all commands regardless of
  // screen lock state. The Credential Provider (ScreenControlCP.dll) handles
  // unlocking the screen when needed via stored credentials.

  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Activity Pattern Tracking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Record activity for power state prediction
 */
export async function recordActivity(userId: string): Promise<void> {
  const hour = new Date().getHours();

  // Find or create pattern record
  let pattern = await prisma.customerActivityPattern.findUnique({
    where: { userId },
  });

  if (!pattern) {
    pattern = await prisma.customerActivityPattern.create({
      data: { userId },
    });
  }

  // Increment the hour counter
  const hourlyActivity = [...pattern.hourlyActivity];
  hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;

  // Update and recalculate quiet hours
  const quietHours = detectQuietHours(hourlyActivity);

  await prisma.customerActivityPattern.update({
    where: { userId },
    data: {
      hourlyActivity,
      quietHoursStart: quietHours.start,
      quietHoursEnd: quietHours.end,
    },
  });
}

/**
 * Detect quiet hours from activity pattern
 */
function detectQuietHours(hourlyActivity: number[]): {
  start: number | null;
  end: number | null;
} {
  const total = hourlyActivity.reduce((a, b) => a + b, 0);
  if (total < 100) {
    // Not enough data yet
    return { start: null, end: null };
  }

  // Find the longest consecutive stretch of low activity
  const threshold = total / 24 / 4; // 25% of average
  let longestStart = -1;
  let longestEnd = -1;
  let longestLength = 0;

  let currentStart = -1;
  let currentLength = 0;

  for (let i = 0; i < 48; i++) {
    // Loop twice to handle wrap-around
    const hour = i % 24;
    if (hourlyActivity[hour] < threshold) {
      if (currentStart === -1) {
        currentStart = hour;
      }
      currentLength++;
    } else {
      if (currentLength > longestLength) {
        longestStart = currentStart;
        longestEnd = (currentStart + currentLength - 1) % 24;
        longestLength = currentLength;
      }
      currentStart = -1;
      currentLength = 0;
    }
  }

  // Check final stretch
  if (currentLength > longestLength) {
    longestStart = currentStart;
    longestEnd = (currentStart + currentLength - 1) % 24;
  }

  if (longestLength >= 4) {
    // At least 4 hours of quiet time
    return { start: longestStart, end: longestEnd };
  }

  return { start: null, end: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// Schedule Override Functions (I.2.1)
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduleInfo {
  scheduleMode: 'ALWAYS_ACTIVE' | 'AUTO_DETECT' | 'CUSTOM' | 'SLEEP_OVERNIGHT';
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  isInQuietHours: boolean;
  desiredPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
  heartbeatInterval: number; // milliseconds
}

/**
 * Get schedule information for an agent via its owner
 */
export async function getAgentSchedule(agentDbId: string): Promise<ScheduleInfo | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    include: {
      owner: {
        include: {
          activityPattern: true,
        },
      },
    },
  });

  if (!agent?.owner) {
    // No owner, default to PASSIVE
    return {
      scheduleMode: 'AUTO_DETECT',
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'UTC',
      isInQuietHours: false,
      desiredPowerState: 'PASSIVE',
      heartbeatInterval: 30000, // 30 seconds for PASSIVE
    };
  }

  const pattern = agent.owner.activityPattern;

  if (!pattern) {
    // No activity pattern yet, default to PASSIVE
    return {
      scheduleMode: 'AUTO_DETECT',
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: 'UTC',
      isInQuietHours: false,
      desiredPowerState: 'PASSIVE',
      heartbeatInterval: 30000,
    };
  }

  const { isQuiet, currentHour } = isInQuietHours(
    pattern.scheduleMode as ScheduleInfo['scheduleMode'],
    pattern.quietHoursStart,
    pattern.quietHoursEnd,
    pattern.timezone
  );

  const desiredPowerState = getDesiredPowerState(
    pattern.scheduleMode as ScheduleInfo['scheduleMode'],
    isQuiet
  );

  const heartbeatInterval = getHeartbeatInterval(desiredPowerState);

  return {
    scheduleMode: pattern.scheduleMode as ScheduleInfo['scheduleMode'],
    quietHoursStart: pattern.quietHoursStart,
    quietHoursEnd: pattern.quietHoursEnd,
    timezone: pattern.timezone,
    isInQuietHours: isQuiet,
    desiredPowerState,
    heartbeatInterval,
  };
}

/**
 * Check if current time is in quiet hours
 */
function isInQuietHours(
  scheduleMode: ScheduleInfo['scheduleMode'],
  quietHoursStart: number | null,
  quietHoursEnd: number | null,
  timezone: string
): { isQuiet: boolean; currentHour: number } {
  // Get current hour in the specified timezone
  let currentHour: number;
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    });
    currentHour = parseInt(formatter.format(now), 10);
  } catch {
    // Fallback to UTC if timezone is invalid
    currentHour = new Date().getUTCHours();
  }

  switch (scheduleMode) {
    case 'ALWAYS_ACTIVE':
      return { isQuiet: false, currentHour };

    case 'SLEEP_OVERNIGHT':
      // Default overnight: 11pm (23) to 7am (7)
      const overnightStart = 23;
      const overnightEnd = 7;
      const isOvernight =
        currentHour >= overnightStart || currentHour < overnightEnd;
      return { isQuiet: isOvernight, currentHour };

    case 'CUSTOM':
    case 'AUTO_DETECT':
      if (quietHoursStart === null || quietHoursEnd === null) {
        return { isQuiet: false, currentHour };
      }

      // Handle wrap-around (e.g., 23 to 6)
      let isQuiet: boolean;
      if (quietHoursStart <= quietHoursEnd) {
        // Same day range (e.g., 1 to 6)
        isQuiet = currentHour >= quietHoursStart && currentHour <= quietHoursEnd;
      } else {
        // Wrap-around range (e.g., 23 to 6)
        isQuiet = currentHour >= quietHoursStart || currentHour <= quietHoursEnd;
      }
      return { isQuiet, currentHour };

    default:
      return { isQuiet: false, currentHour };
  }
}

/**
 * Determine desired power state based on schedule
 */
function getDesiredPowerState(
  scheduleMode: ScheduleInfo['scheduleMode'],
  isQuiet: boolean
): 'ACTIVE' | 'PASSIVE' | 'SLEEP' {
  if (scheduleMode === 'ALWAYS_ACTIVE') {
    return 'ACTIVE';
  }

  if (isQuiet) {
    return 'SLEEP';
  }

  return 'PASSIVE';
}

/**
 * Get heartbeat interval for power state
 */
function getHeartbeatInterval(powerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP'): number {
  switch (powerState) {
    case 'ACTIVE':
      return 5000; // 5 seconds
    case 'PASSIVE':
      return 30000; // 30 seconds
    case 'SLEEP':
      return 300000; // 5 minutes
    default:
      return 30000;
  }
}

/**
 * Get all agents that need schedule-based power state updates
 * Called periodically to check for transitions
 */
export async function getAgentsNeedingScheduleUpdate(): Promise<
  Array<{
    agentDbId: string;
    currentPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
    desiredPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
    heartbeatInterval: number;
  }>
> {
  // Get all online agents with their owner's activity patterns
  const agents = await prisma.agent.findMany({
    where: {
      status: 'ONLINE',
    },
    include: {
      owner: {
        include: {
          activityPattern: true,
        },
      },
    },
  });

  const updates: Array<{
    agentDbId: string;
    currentPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
    desiredPowerState: 'ACTIVE' | 'PASSIVE' | 'SLEEP';
    heartbeatInterval: number;
  }> = [];

  for (const agent of agents) {
    if (!agent.owner?.activityPattern) continue;

    const pattern = agent.owner.activityPattern;
    const { isQuiet } = isInQuietHours(
      pattern.scheduleMode as ScheduleInfo['scheduleMode'],
      pattern.quietHoursStart,
      pattern.quietHoursEnd,
      pattern.timezone
    );

    const desiredPowerState = getDesiredPowerState(
      pattern.scheduleMode as ScheduleInfo['scheduleMode'],
      isQuiet
    );

    // Only include if state needs to change
    if (agent.powerState !== desiredPowerState) {
      updates.push({
        agentDbId: agent.id,
        currentPowerState: agent.powerState as 'ACTIVE' | 'PASSIVE' | 'SLEEP',
        desiredPowerState,
        heartbeatInterval: getHeartbeatInterval(desiredPowerState),
      });
    }
  }

  return updates;
}

// ═══════════════════════════════════════════════════════════════════════════
// License Validation Functions (I.2.2, I.2.3)
// ═══════════════════════════════════════════════════════════════════════════

export interface LicenseValidationResult {
  agentDbId: string;
  licenseId: string;
  isValid: boolean;
  newState: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';
  reason?: string;
  trialDaysRemaining?: number;
  validUntil?: Date | null;
}

/**
 * Check license validity for an agent (I.2.2)
 */
export async function checkAgentLicense(agentDbId: string): Promise<LicenseValidationResult | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentDbId },
    include: {
      license: true,
    },
  });

  if (!agent?.license) {
    return null;
  }

  const license = agent.license;
  const now = new Date();

  // Check license status
  if (license.status === 'SUSPENDED') {
    return {
      agentDbId,
      licenseId: license.id,
      isValid: false,
      newState: 'BLOCKED',
      reason: 'License suspended',
    };
  }

  if (license.status === 'CANCELLED') {
    return {
      agentDbId,
      licenseId: license.id,
      isValid: false,
      newState: 'BLOCKED',
      reason: 'License cancelled',
    };
  }

  if (license.status === 'EXPIRED') {
    return {
      agentDbId,
      licenseId: license.id,
      isValid: false,
      newState: 'EXPIRED',
      reason: 'License expired',
    };
  }

  // Check trial expiry
  if (license.isTrial && license.trialEnds) {
    if (now > license.trialEnds) {
      // Trial has expired, update the license
      await prisma.license.update({
        where: { id: license.id },
        data: { status: 'EXPIRED' },
      });

      return {
        agentDbId,
        licenseId: license.id,
        isValid: false,
        newState: 'EXPIRED',
        reason: 'Trial period ended',
      };
    }

    // Calculate trial days remaining
    const trialDaysRemaining = Math.ceil(
      (license.trialEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    return {
      agentDbId,
      licenseId: license.id,
      isValid: true,
      newState: 'ACTIVE',
      trialDaysRemaining,
      validUntil: license.trialEnds,
    };
  }

  // Check validUntil expiry (for paid licenses)
  if (license.validUntil && now > license.validUntil) {
    // License has expired, update it
    await prisma.license.update({
      where: { id: license.id },
      data: { status: 'EXPIRED' },
    });

    return {
      agentDbId,
      licenseId: license.id,
      isValid: false,
      newState: 'EXPIRED',
      reason: 'License validity period ended',
    };
  }

  // License is valid
  return {
    agentDbId,
    licenseId: license.id,
    isValid: true,
    newState: 'ACTIVE',
    validUntil: license.validUntil,
  };
}

/**
 * Get all agents that need license state updates (I.2.2)
 * Returns agents whose license has expired or been suspended
 */
export async function getAgentsWithLicenseChanges(): Promise<LicenseValidationResult[]> {
  // Get all online agents
  const agents = await prisma.agent.findMany({
    where: {
      status: 'ONLINE',
    },
    include: {
      license: true,
    },
  });

  const updates: LicenseValidationResult[] = [];
  const now = new Date();

  for (const agent of agents) {
    if (!agent.license) continue;

    const license = agent.license;
    let needsUpdate = false;
    let newState: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'BLOCKED' = agent.state as 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'BLOCKED';
    let reason: string | undefined;

    // Check for status changes
    if (license.status === 'SUSPENDED' && agent.state !== 'BLOCKED') {
      newState = 'BLOCKED';
      reason = 'License suspended';
      needsUpdate = true;
    } else if (license.status === 'CANCELLED' && agent.state !== 'BLOCKED') {
      newState = 'BLOCKED';
      reason = 'License cancelled';
      needsUpdate = true;
    } else if (license.status === 'EXPIRED' && agent.state !== 'EXPIRED') {
      newState = 'EXPIRED';
      reason = 'License expired';
      needsUpdate = true;
    }

    // Check trial expiry
    if (!needsUpdate && license.isTrial && license.trialEnds && now > license.trialEnds) {
      if (agent.state !== 'EXPIRED') {
        newState = 'EXPIRED';
        reason = 'Trial period ended';
        needsUpdate = true;

        // Also update the license status
        await prisma.license.update({
          where: { id: license.id },
          data: { status: 'EXPIRED' },
        });
      }
    }

    // Check validUntil expiry
    if (!needsUpdate && license.validUntil && now > license.validUntil) {
      if (agent.state !== 'EXPIRED') {
        newState = 'EXPIRED';
        reason = 'License validity period ended';
        needsUpdate = true;

        await prisma.license.update({
          where: { id: license.id },
          data: { status: 'EXPIRED' },
        });
      }
    }

    if (needsUpdate) {
      // Update agent state in database
      await prisma.agent.update({
        where: { id: agent.id },
        data: { state: newState },
      });

      updates.push({
        agentDbId: agent.id,
        licenseId: license.id,
        isValid: newState === 'ACTIVE' || newState === 'PENDING',
        newState,
        reason,
      });
    }
  }

  return updates;
}

/**
 * Update agent state due to license change (I.2.3)
 */
export async function updateAgentLicenseState(
  agentDbId: string,
  newState: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'BLOCKED',
  reason?: string
): Promise<void> {
  await prisma.agent.update({
    where: { id: agentDbId },
    data: { state: newState },
  });

  // Log the state change
  await prisma.auditLog.create({
    data: {
      agentId: agentDbId,
      action: 'LICENSE_STATE_CHANGE',
      details: { newState, reason },
    },
  });
}
