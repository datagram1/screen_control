/**
 * Job Scheduler Service
 *
 * Manages scheduled jobs that run AI prompts against agents.
 * Follows the same singleton pattern as EmailAgentService.
 */

import { prisma } from '../prisma';
import { executeJob, JobExecutionContext } from './executor';
import { parseCronExpression, getNextRunTime } from './cron-parser';

export class JobSchedulerService {
  private isRunning = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private activeJobs = new Map<string, Promise<void>>(); // jobRunId -> execution promise

  constructor() {
    // Service initialized but not started
  }

  /**
   * Start the job scheduler service
   */
  async start(): Promise<boolean> {
    if (this.isRunning) {
      console.log('[JobScheduler] Already running');
      return true;
    }

    try {
      // Update nextRunAt for all enabled jobs on startup
      await this.updateAllNextRunTimes();

      // Start periodic check (every 30 seconds)
      this.checkInterval = setInterval(() => {
        this.checkAndRunDueJobs().catch(err => {
          console.error('[JobScheduler] Check error:', err);
          this.lastError = err.message;
        });
      }, 30000);

      this.isRunning = true;
      this.lastError = null;

      console.log('[JobScheduler] Started successfully');

      // Run initial check
      this.checkAndRunDueJobs().catch(err => {
        console.error('[JobScheduler] Initial check error:', err);
      });

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.lastError = `Failed to start: ${errorMsg}`;
      console.error('[JobScheduler] Failed to start:', error);
      return false;
    }
  }

  /**
   * Stop the job scheduler service
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    console.log('[JobScheduler] Stopped');
  }

  /**
   * Update nextRunAt for all enabled jobs
   */
  private async updateAllNextRunTimes(): Promise<void> {
    const jobs = await prisma.scheduledJob.findMany({
      where: { isEnabled: true },
    });

    for (const job of jobs) {
      const nextRun = getNextRunTime(job.cronExpression, job.timezone);
      if (nextRun) {
        await prisma.scheduledJob.update({
          where: { id: job.id },
          data: { nextRunAt: nextRun },
        });
      }
    }

    console.log(`[JobScheduler] Updated next run times for ${jobs.length} jobs`);
  }

  /**
   * Check for due jobs and run them
   */
  private async checkAndRunDueJobs(): Promise<void> {
    const now = new Date();

    // Find jobs that are due
    const dueJobs = await prisma.scheduledJob.findMany({
      where: {
        isEnabled: true,
        nextRunAt: { lte: now },
      },
      include: {
        jobType: true,
      },
    });

    if (dueJobs.length === 0) return;

    console.log(`[JobScheduler] Found ${dueJobs.length} due job(s)`);

    for (const job of dueJobs) {
      // Skip if this job is already running
      if (this.activeJobs.has(job.id)) {
        console.log(`[JobScheduler] Job ${job.name} is already running, skipping`);
        continue;
      }

      // Start job execution
      const executionPromise = this.runJob(job);
      this.activeJobs.set(job.id, executionPromise);

      // Clean up when done
      executionPromise.finally(() => {
        this.activeJobs.delete(job.id);
      });
    }
  }

  /**
   * Run a single scheduled job
   */
  private async runJob(job: {
    id: string;
    name: string;
    cronExpression: string;
    timezone: string;
    targetAgentIds: string[];
    runParallel: boolean;
    customPrompt: string | null;
    notifyEmail: string | null;
    notifyOn: string;
    jobType: {
      defaultPrompt: string;
      defaultTasks: unknown;
    } | null;
  }): Promise<void> {
    console.log(`[JobScheduler] Running job: ${job.name}`);

    // Create job run record
    const jobRun = await prisma.jobRun.create({
      data: {
        scheduledJobId: job.id,
        status: 'RUNNING',
        triggeredBy: 'SCHEDULE',
        totalAgents: job.targetAgentIds.length,
      },
    });

    try {
      // Build the prompt
      const prompt = job.customPrompt || job.jobType?.defaultPrompt || '';

      // Execute on each agent
      const context: JobExecutionContext = {
        jobRunId: jobRun.id,
        prompt,
        agentIds: job.targetAgentIds,
        runParallel: job.runParallel,
      };

      const results = await executeJob(context);

      // Update job run with results
      const successCount = results.filter(r => r.status === 'SUCCESS').length;
      const failureCount = results.filter(r => r.status === 'FAILED').length;
      const issuesFound = results.reduce((sum, r) => sum + (r.issuesFound?.length || 0), 0);

      await prisma.jobRun.update({
        where: { id: jobRun.id },
        data: {
          status: failureCount === 0 ? 'COMPLETED' : failureCount === results.length ? 'FAILED' : 'PARTIAL',
          completedAt: new Date(),
          successCount,
          failureCount,
          issuesFound,
        },
      });

      // Update last run time and calculate next run
      const nextRun = getNextRunTime(job.cronExpression, job.timezone);
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: nextRun,
        },
      });

      // Send notification if configured
      if (job.notifyEmail) {
        const shouldNotify =
          job.notifyOn === 'ALWAYS' ||
          (job.notifyOn === 'ISSUES' && issuesFound > 0) ||
          (job.notifyOn === 'FAILURE' && failureCount > 0);

        if (shouldNotify) {
          await this.sendNotification(job, jobRun.id, results);
        }
      }

      console.log(`[JobScheduler] Job ${job.name} completed: ${successCount} success, ${failureCount} failed, ${issuesFound} issues`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[JobScheduler] Job ${job.name} failed:`, error);

      await prisma.jobRun.update({
        where: { id: jobRun.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
        },
      });

      // Update next run time even on failure
      const nextRun = getNextRunTime(job.cronExpression, job.timezone);
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: nextRun,
        },
      });
    }
  }

  /**
   * Manually trigger a job
   */
  async triggerJob(jobId: string, triggeredBy: 'MANUAL' | 'ALERT' | 'EMAIL' = 'MANUAL'): Promise<string> {
    const job = await prisma.scheduledJob.findUnique({
      where: { id: jobId },
      include: { jobType: true },
    });

    if (!job) {
      throw new Error('Job not found');
    }

    console.log(`[JobScheduler] Manually triggered job: ${job.name}`);

    // Create job run record
    const jobRun = await prisma.jobRun.create({
      data: {
        scheduledJobId: job.id,
        status: 'RUNNING',
        triggeredBy,
        totalAgents: job.targetAgentIds.length,
      },
    });

    // Start execution (don't await - return immediately)
    this.runJobAsync(job, jobRun.id);

    return jobRun.id;
  }

  /**
   * Run job asynchronously (for manual triggers)
   */
  private async runJobAsync(job: {
    id: string;
    name: string;
    cronExpression: string;
    timezone: string;
    targetAgentIds: string[];
    runParallel: boolean;
    customPrompt: string | null;
    notifyEmail: string | null;
    notifyOn: string;
    jobType: {
      defaultPrompt: string;
      defaultTasks: unknown;
    } | null;
  }, jobRunId: string): Promise<void> {
    try {
      const prompt = job.customPrompt || job.jobType?.defaultPrompt || '';

      const context: JobExecutionContext = {
        jobRunId,
        prompt,
        agentIds: job.targetAgentIds,
        runParallel: job.runParallel,
      };

      const results = await executeJob(context);

      const successCount = results.filter(r => r.status === 'SUCCESS').length;
      const failureCount = results.filter(r => r.status === 'FAILED').length;
      const issuesFound = results.reduce((sum, r) => sum + (r.issuesFound?.length || 0), 0);

      await prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: failureCount === 0 ? 'COMPLETED' : failureCount === results.length ? 'FAILED' : 'PARTIAL',
          completedAt: new Date(),
          successCount,
          failureCount,
          issuesFound,
        },
      });

      if (job.notifyEmail) {
        const shouldNotify =
          job.notifyOn === 'ALWAYS' ||
          (job.notifyOn === 'ISSUES' && issuesFound > 0) ||
          (job.notifyOn === 'FAILURE' && failureCount > 0);

        if (shouldNotify) {
          await this.sendNotification(job, jobRunId, results);
        }
      }
    } catch (error) {
      console.error(`[JobScheduler] Async job ${job.name} failed:`, error);

      await prisma.jobRun.update({
        where: { id: jobRunId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Send notification email
   */
  private async sendNotification(
    job: { name: string; notifyEmail: string | null },
    jobRunId: string,
    results: Array<{ agentId: string; status: string; summary?: string; issuesFound?: string[] }>
  ): Promise<void> {
    if (!job.notifyEmail) return;

    // TODO: Implement email sending using existing email infrastructure
    console.log(`[JobScheduler] Would send notification to ${job.notifyEmail} for job ${job.name}`);
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    activeJobs: number;
    error: string | null;
  } {
    return {
      running: this.isRunning,
      activeJobs: this.activeJobs.size,
      error: this.lastError,
    };
  }
}

// Singleton instance
const globalForJobScheduler = globalThis as unknown as {
  jobSchedulerService: JobSchedulerService | undefined;
};

export const jobSchedulerService =
  globalForJobScheduler.jobSchedulerService ??
  new JobSchedulerService();

globalForJobScheduler.jobSchedulerService = jobSchedulerService;

/**
 * Start the job scheduler (called from server.ts)
 */
export async function startJobScheduler(): Promise<boolean> {
  return jobSchedulerService.start();
}

/**
 * Stop the job scheduler
 */
export function stopJobScheduler(): void {
  jobSchedulerService.stop();
}

export { executeJob } from './executor';
export { parseCronExpression, getNextRunTime } from './cron-parser';
