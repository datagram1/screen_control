/**
 * Job Executor
 *
 * Executes scheduled jobs by sending prompts to agents and collecting results.
 * Uses the agentRegistry to communicate with agents.
 */

import { prisma } from '../prisma';
import { agentRegistry } from '../control-server/agent-registry';

export interface JobExecutionContext {
  jobRunId: string;
  prompt: string;
  agentIds: string[];
  runParallel: boolean;
}

export interface JobExecutionResult {
  agentId: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  output?: string;
  summary?: string;
  issuesFound?: string[];
  actionsTaken?: string[];
  errorMessage?: string;
  startedAt: Date;
  completedAt: Date;
}

/**
 * Execute a job across multiple agents
 */
export async function executeJob(context: JobExecutionContext): Promise<JobExecutionResult[]> {
  const { jobRunId, prompt, agentIds, runParallel } = context;

  console.log(`[JobExecutor] Executing job ${jobRunId} on ${agentIds.length} agent(s), parallel=${runParallel}`);

  // Create result records for each agent
  await prisma.jobRunResult.createMany({
    data: agentIds.map(agentId => ({
      jobRunId,
      agentId,
      status: 'PENDING',
    })),
  });

  const results: JobExecutionResult[] = [];

  if (runParallel) {
    // Execute on all agents in parallel
    const promises = agentIds.map(agentId => executeOnAgent(jobRunId, agentId, prompt));
    results.push(...await Promise.all(promises));
  } else {
    // Execute sequentially
    for (const agentId of agentIds) {
      const result = await executeOnAgent(jobRunId, agentId, prompt);
      results.push(result);
    }
  }

  return results;
}

/**
 * Execute job prompt on a single agent
 */
async function executeOnAgent(
  jobRunId: string,
  agentId: string,
  prompt: string
): Promise<JobExecutionResult> {
  const startedAt = new Date();

  // Find the result record
  const resultRecord = await prisma.jobRunResult.findFirst({
    where: { jobRunId, agentId },
  });

  if (!resultRecord) {
    return {
      agentId,
      status: 'FAILED',
      errorMessage: 'Result record not found',
      startedAt,
      completedAt: new Date(),
    };
  }

  // Update status to RUNNING
  await prisma.jobRunResult.update({
    where: { id: resultRecord.id },
    data: { status: 'RUNNING', startedAt },
  });

  try {
    // Check if agent is connected
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      console.log(`[JobExecutor] Agent ${agentId} not connected, skipping`);

      await prisma.jobRunResult.update({
        where: { id: resultRecord.id },
        data: {
          status: 'SKIPPED',
          errorMessage: 'Agent not connected',
          completedAt: new Date(),
        },
      });

      return {
        agentId,
        status: 'SKIPPED',
        errorMessage: 'Agent not connected',
        startedAt,
        completedAt: new Date(),
      };
    }

    console.log(`[JobExecutor] Executing on agent ${agent.machineName || agent.machineId}`);

    // Wake agent if sleeping
    if (agent.powerState === 'SLEEP') {
      agentRegistry.wakeAgent(agentId, 'scheduled_job');
      // Wait a moment for agent to wake
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Send the prompt to the agent using shell_exec to run commands
    // The prompt describes what to do, and we'll execute it as a script
    const response = await executePromptOnAgent(agent, prompt);

    // Parse the response for issues and actions
    const { output, summary, issuesFound, actionsTaken } = parseAgentResponse(response);

    const completedAt = new Date();

    // Update result record
    await prisma.jobRunResult.update({
      where: { id: resultRecord.id },
      data: {
        status: 'SUCCESS',
        completedAt,
        output,
        summary,
        issuesFound: issuesFound.length > 0 ? issuesFound : undefined,
        actionsTaken: actionsTaken.length > 0 ? actionsTaken : undefined,
      },
    });

    return {
      agentId,
      status: 'SUCCESS',
      output,
      summary,
      issuesFound,
      actionsTaken,
      startedAt,
      completedAt,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const completedAt = new Date();

    console.error(`[JobExecutor] Failed on agent ${agentId}:`, error);

    await prisma.jobRunResult.update({
      where: { id: resultRecord.id },
      data: {
        status: 'FAILED',
        completedAt,
        errorMessage,
      },
    });

    return {
      agentId,
      status: 'FAILED',
      errorMessage,
      startedAt,
      completedAt,
    };
  }
}

/**
 * Execute a prompt on an agent
 *
 * This interprets the prompt and executes appropriate commands.
 * For now, we'll use shell_exec to run commands described in the prompt.
 */
async function executePromptOnAgent(
  agent: { id: string; machineName?: string; machineId?: string },
  prompt: string
): Promise<string> {
  const outputs: string[] = [];

  // Extract commands from the prompt
  // Look for lines that start with ` or are marked as commands
  const commandPattern = /`([^`]+)`|(?:run|execute|check):\s*(.+)/gi;
  const matches = [...prompt.matchAll(commandPattern)];

  // Common health check commands to try
  const defaultCommands = extractHealthCheckCommands(prompt);

  const commandsToRun = matches.length > 0
    ? matches.map(m => m[1] || m[2]).filter(Boolean)
    : defaultCommands;

  if (commandsToRun.length === 0) {
    // If no specific commands found, try to infer from the prompt
    commandsToRun.push(...inferCommandsFromPrompt(prompt));
  }

  for (const command of commandsToRun) {
    try {
      console.log(`[JobExecutor] Running command on ${agent.machineName || agent.machineId}: ${command}`);

      const result = await agentRegistry.sendCommand(agent.id, 'tools/call', {
        name: 'shell_exec',
        arguments: { command, timeout_seconds: 30 },
      });

      if (result && typeof result === 'object') {
        const content = (result as any).content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text') {
              outputs.push(`$ ${command}\n${item.text}`);
            }
          }
        } else if (typeof content === 'string') {
          outputs.push(`$ ${command}\n${content}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      outputs.push(`$ ${command}\nERROR: ${errorMsg}`);
    }
  }

  return outputs.join('\n\n---\n\n');
}

/**
 * Extract health check commands from prompt
 */
function extractHealthCheckCommands(prompt: string): string[] {
  const commands: string[] = [];
  const lowerPrompt = prompt.toLowerCase();

  // Docker checks
  if (lowerPrompt.includes('docker')) {
    commands.push('docker ps -a');
    if (lowerPrompt.includes('stats') || lowerPrompt.includes('resource') || lowerPrompt.includes('memory') || lowerPrompt.includes('cpu')) {
      commands.push('docker stats --no-stream');
    }
  }

  // Disk checks
  if (lowerPrompt.includes('disk') || lowerPrompt.includes('storage') || lowerPrompt.includes('space')) {
    commands.push('df -h');
  }

  // Memory checks
  if (lowerPrompt.includes('memory') || lowerPrompt.includes('ram')) {
    commands.push('free -h 2>/dev/null || vm_stat');
  }

  // Process checks
  if (lowerPrompt.includes('process') || lowerPrompt.includes('cpu')) {
    commands.push('ps aux --sort=-%cpu | head -10');
  }

  // Log checks
  if (lowerPrompt.includes('log')) {
    if (lowerPrompt.includes('auth') || lowerPrompt.includes('ssh')) {
      commands.push('tail -50 /var/log/auth.log 2>/dev/null || tail -50 /var/log/secure 2>/dev/null || echo "No auth logs found"');
    }
    if (lowerPrompt.includes('system') || lowerPrompt.includes('syslog')) {
      commands.push('tail -50 /var/log/syslog 2>/dev/null || tail -50 /var/log/messages 2>/dev/null || log show --last 5m 2>/dev/null | tail -50');
    }
  }

  // Network checks
  if (lowerPrompt.includes('network') || lowerPrompt.includes('port') || lowerPrompt.includes('connection')) {
    commands.push('netstat -tuln 2>/dev/null || ss -tuln');
  }

  // Service checks
  if (lowerPrompt.includes('service') || lowerPrompt.includes('systemd')) {
    commands.push('systemctl list-units --type=service --state=failed 2>/dev/null || echo "systemctl not available"');
  }

  return commands;
}

/**
 * Infer commands from prompt keywords
 */
function inferCommandsFromPrompt(prompt: string): string[] {
  const commands: string[] = [];
  const lowerPrompt = prompt.toLowerCase();

  // Default to basic system health
  if (lowerPrompt.includes('health') || lowerPrompt.includes('status')) {
    commands.push('uptime');
    commands.push('df -h');
    commands.push('free -h 2>/dev/null || vm_stat');
  }

  // If still no commands, do basic checks
  if (commands.length === 0) {
    commands.push('uptime');
    commands.push('df -h');
  }

  return commands;
}

/**
 * Parse agent response to extract structured data
 */
function parseAgentResponse(response: string): {
  output: string;
  summary: string;
  issuesFound: string[];
  actionsTaken: string[];
} {
  const issuesFound: string[] = [];
  const actionsTaken: string[] = [];

  // Look for common issue indicators
  const lines = response.split('\n');

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    // Detect issues
    if (lowerLine.includes('error') || lowerLine.includes('failed') || lowerLine.includes('critical')) {
      if (!issuesFound.includes(line.trim()) && line.trim().length > 0) {
        issuesFound.push(line.trim());
      }
    }

    // Detect high resource usage
    if (lowerLine.match(/\b(9\d|100)%/) && (lowerLine.includes('cpu') || lowerLine.includes('mem') || lowerLine.includes('disk'))) {
      issuesFound.push(`High resource usage: ${line.trim()}`);
    }

    // Docker container issues
    if (lowerLine.includes('exited') || lowerLine.includes('unhealthy') || lowerLine.includes('restarting')) {
      issuesFound.push(`Container issue: ${line.trim()}`);
    }

    // Disk space warnings
    if (lowerLine.match(/\b(8\d|9\d|100)%/) && (lowerLine.includes('/') || lowerLine.includes('disk'))) {
      issuesFound.push(`Low disk space: ${line.trim()}`);
    }
  }

  // Generate summary
  let summary = '';
  if (issuesFound.length > 0) {
    summary = `Found ${issuesFound.length} potential issue(s)`;
  } else {
    summary = 'Health check completed - no issues detected';
  }

  return {
    output: response,
    summary,
    issuesFound,
    actionsTaken,
  };
}

/**
 * Get job execution status
 */
export async function getJobRunStatus(jobRunId: string): Promise<{
  status: string;
  results: Array<{
    agentId: string;
    status: string;
    summary?: string;
    issuesFound?: string[];
  }>;
} | null> {
  const jobRun = await prisma.jobRun.findUnique({
    where: { id: jobRunId },
    include: {
      results: true,
    },
  });

  if (!jobRun) return null;

  return {
    status: jobRun.status,
    results: jobRun.results.map(r => ({
      agentId: r.agentId,
      status: r.status,
      summary: r.summary || undefined,
      issuesFound: r.issuesFound as string[] | undefined,
    })),
  };
}
