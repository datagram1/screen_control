/**
 * Seed Default Job Types
 *
 * Run with: npx tsx prisma/seed-job-types.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_JOB_TYPES = [
  {
    name: 'docker_health',
    displayName: 'Docker Health Check',
    description: 'Check Docker containers for health issues, restarts, and resource usage',
    category: 'HEALTH',
    defaultPrompt: `Check the health of Docker containers on this system:

1. Run \`docker ps -a\` to list all containers and their status
2. Run \`docker stats --no-stream\` to check resource usage

Report any issues found:
- Containers in Exited or Restarting state
- Containers using more than 80% memory
- Containers using more than 90% CPU
- Containers that have restarted more than 3 times recently

If you find unhealthy containers, try to restart them with \`docker restart <container_name>\`.`,
    defaultTasks: [
      'List all containers',
      'Check resource usage',
      'Identify unhealthy containers',
      'Restart unhealthy containers if safe',
    ],
    isSystem: true,
  },
  {
    name: 'disk_cleanup',
    displayName: 'Disk Cleanup',
    description: 'Check disk usage and clean up temporary files, old logs, and unused Docker resources',
    category: 'MAINTENANCE',
    defaultPrompt: `Check disk usage and perform cleanup if needed:

1. Run \`df -h\` to check disk usage on all partitions
2. If any partition is above 85% full, perform cleanup:
   - Remove old log files: \`find /var/log -type f -name "*.log" -mtime +30 -delete\`
   - Clean Docker: \`docker system prune -f\` (removes unused containers, networks, images)
   - Clear temp files: \`rm -rf /tmp/*\` (if safe)

Report:
- Current disk usage for each partition
- Space freed by cleanup operations
- Any partitions still above 90% after cleanup (requires attention)`,
    defaultTasks: [
      'Check disk usage',
      'Clean old logs',
      'Prune Docker resources',
      'Clear temp files',
      'Report space freed',
    ],
    isSystem: true,
  },
  {
    name: 'security_scan',
    displayName: 'Security Scan',
    description: 'Check for failed login attempts, suspicious processes, and open ports',
    category: 'SECURITY',
    defaultPrompt: `Perform a basic security scan:

1. Check for failed SSH login attempts:
   \`grep "Failed password" /var/log/auth.log 2>/dev/null | tail -20\` (Linux)
   \`log show --predicate 'eventMessage contains "authentication failure"' --last 1h\` (macOS)

2. Check for unusual processes:
   \`ps aux --sort=-%cpu | head -15\`

3. Check open network ports:
   \`netstat -tuln 2>/dev/null || ss -tuln\`

4. Check for recent sudo commands:
   \`grep "sudo:" /var/log/auth.log 2>/dev/null | tail -10\`

Report any suspicious findings:
- Multiple failed login attempts from the same IP
- Unknown processes consuming resources
- Unexpected open ports
- Unusual sudo activity`,
    defaultTasks: [
      'Check failed logins',
      'Review running processes',
      'Check open ports',
      'Review sudo activity',
    ],
    isSystem: true,
  },
  {
    name: 'backup_verify',
    displayName: 'Backup Verification',
    description: 'Verify that backups are running and recent',
    category: 'BACKUP',
    defaultPrompt: `Verify backup status:

1. Check if backup directory exists and has recent files:
   \`ls -la /backup 2>/dev/null || ls -la ~/backups 2>/dev/null\`

2. Find the most recent backup file:
   \`find /backup -type f -mtime -1 2>/dev/null | head -5\`

3. Check backup file sizes (should be reasonable, not 0):
   \`du -sh /backup/* 2>/dev/null | tail -10\`

Report:
- Whether backup directory exists
- Date of most recent backup
- Size of recent backups
- Alert if no backup in last 24 hours`,
    defaultTasks: [
      'Check backup directory',
      'Find recent backups',
      'Verify backup sizes',
      'Alert if outdated',
    ],
    isSystem: true,
  },
  {
    name: 'system_health',
    displayName: 'System Health Check',
    description: 'General system health including uptime, load, memory, and services',
    category: 'HEALTH',
    defaultPrompt: `Perform a general system health check:

1. Check system uptime and load:
   \`uptime\`

2. Check memory usage:
   \`free -h 2>/dev/null || vm_stat\`

3. Check disk usage:
   \`df -h\`

4. Check for failed systemd services (Linux):
   \`systemctl list-units --type=service --state=failed 2>/dev/null || echo "systemctl not available"\`

5. Check recent system errors:
   \`dmesg | tail -20 2>/dev/null || log show --last 5m --predicate 'messageType == error' 2>/dev/null | tail -20\`

Report:
- System uptime
- Load average (flag if > number of CPUs)
- Memory usage (flag if > 90%)
- Disk usage (flag if any partition > 85%)
- Failed services
- Recent errors`,
    defaultTasks: [
      'Check uptime and load',
      'Check memory',
      'Check disk space',
      'Check services',
      'Review error logs',
    ],
    isSystem: true,
  },
  {
    name: 'log_rotation',
    displayName: 'Log Rotation & Cleanup',
    description: 'Rotate and compress large log files, delete old compressed logs',
    category: 'MAINTENANCE',
    defaultPrompt: `Manage log files:

1. Find large log files (>100MB):
   \`find /var/log -type f -size +100M 2>/dev/null\`

2. Compress logs older than 7 days:
   \`find /var/log -name "*.log" -type f -mtime +7 -exec gzip {} \\; 2>/dev/null\`

3. Delete compressed logs older than 30 days:
   \`find /var/log -name "*.gz" -type f -mtime +30 -delete 2>/dev/null\`

4. Check current log directory size:
   \`du -sh /var/log\`

Report:
- Large log files found
- Logs compressed
- Old logs deleted
- Current log directory size`,
    defaultTasks: [
      'Find large logs',
      'Compress old logs',
      'Delete ancient logs',
      'Report space saved',
    ],
    isSystem: true,
  },
];

async function main() {
  console.log('Seeding default job types...');

  for (const jobType of DEFAULT_JOB_TYPES) {
    const existing = await prisma.jobType.findUnique({
      where: { name: jobType.name },
    });

    if (existing) {
      console.log(`  Updating: ${jobType.displayName}`);
      await prisma.jobType.update({
        where: { name: jobType.name },
        data: {
          displayName: jobType.displayName,
          description: jobType.description,
          category: jobType.category as any,
          defaultPrompt: jobType.defaultPrompt,
          defaultTasks: jobType.defaultTasks,
          isSystem: jobType.isSystem,
        },
      });
    } else {
      console.log(`  Creating: ${jobType.displayName}`);
      await prisma.jobType.create({
        data: {
          name: jobType.name,
          displayName: jobType.displayName,
          description: jobType.description,
          category: jobType.category as any,
          defaultPrompt: jobType.defaultPrompt,
          defaultTasks: jobType.defaultTasks,
          isSystem: jobType.isSystem,
        },
      });
    }
  }

  console.log(`\nSeeded ${DEFAULT_JOB_TYPES.length} job types.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
