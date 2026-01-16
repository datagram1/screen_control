// Simple Cron Expression Parser
//
// Parses cron expressions and calculates next run times.
// Format: minute hour day-of-month month day-of-week
//
// Examples:
// - "0 2 * * *" = Daily at 2:00 AM
// - "0 0 * * 0" = Weekly on Sunday at midnight
// - "*/15 * * * *" = Every 15 minutes
// - "0 9-17 * * 1-5" = Every hour from 9 AM to 5 PM, Monday to Friday

export interface CronParts {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/**
 * Parse a single cron field
 */
function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  // Handle comma-separated values
  const parts = field.split(',');

  for (const part of parts) {
    // Handle step values (*/5, 0-23/2)
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;

    // Handle wildcard
    if (range === '*') {
      for (let i = min; i <= max; i += step) {
        values.push(i);
      }
      continue;
    }

    // Handle range (1-5)
    const rangeMatch = range.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) {
          values.push(i);
        }
      }
      continue;
    }

    // Handle single value
    const value = parseInt(range, 10);
    if (!isNaN(value) && value >= min && value <= max) {
      values.push(value);
    }
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Parse a cron expression into its parts
 */
export function parseCronExpression(expression: string): CronParts | null {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    console.error('[CronParser] Invalid cron expression (expected 5 parts):', expression);
    return null;
  }

  const [minuteField, hourField, domField, monthField, dowField] = parts;

  try {
    return {
      minutes: parseField(minuteField, 0, 59),
      hours: parseField(hourField, 0, 23),
      daysOfMonth: parseField(domField, 1, 31),
      months: parseField(monthField, 1, 12),
      daysOfWeek: parseField(dowField, 0, 6), // 0 = Sunday
    };
  } catch (error) {
    console.error('[CronParser] Failed to parse cron expression:', expression, error);
    return null;
  }
}

/**
 * Get the next run time for a cron expression
 */
export function getNextRunTime(expression: string, timezone: string = 'UTC'): Date | null {
  const parts = parseCronExpression(expression);
  if (!parts) return null;

  // Start from current time + 1 minute
  const now = new Date();
  let candidate = new Date(now);
  candidate.setSeconds(0);
  candidate.setMilliseconds(0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 2 years ahead
  const maxDate = new Date(now);
  maxDate.setFullYear(maxDate.getFullYear() + 2);

  while (candidate < maxDate) {
    // Check if candidate matches all cron parts
    const month = candidate.getMonth() + 1; // JS months are 0-indexed
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    // Check month
    if (!parts.months.includes(month)) {
      // Move to first day of next matching month
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setDate(1);
      candidate.setHours(0);
      candidate.setMinutes(0);
      continue;
    }

    // Check day of month and day of week
    // Note: cron uses OR logic if both are specified (non-*)
    const domMatches = parts.daysOfMonth.includes(dayOfMonth);
    const dowMatches = parts.daysOfWeek.includes(dayOfWeek);

    // If both are restricted (not *), either can match
    // If only one is restricted, that one must match
    const domIsWildcard = parts.daysOfMonth.length === 31;
    const dowIsWildcard = parts.daysOfWeek.length === 7;

    let dayMatches: boolean;
    if (domIsWildcard && dowIsWildcard) {
      dayMatches = true;
    } else if (domIsWildcard) {
      dayMatches = dowMatches;
    } else if (dowIsWildcard) {
      dayMatches = domMatches;
    } else {
      // Both are restricted - OR logic
      dayMatches = domMatches || dowMatches;
    }

    if (!dayMatches) {
      // Move to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0);
      candidate.setMinutes(0);
      continue;
    }

    // Check hour
    if (!parts.hours.includes(hour)) {
      // Find next matching hour
      const nextHour = parts.hours.find(h => h > hour);
      if (nextHour !== undefined) {
        candidate.setHours(nextHour);
        candidate.setMinutes(parts.minutes[0]);
      } else {
        // Move to next day
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(parts.hours[0]);
        candidate.setMinutes(parts.minutes[0]);
      }
      continue;
    }

    // Check minute
    if (!parts.minutes.includes(minute)) {
      // Find next matching minute
      const nextMinute = parts.minutes.find(m => m > minute);
      if (nextMinute !== undefined) {
        candidate.setMinutes(nextMinute);
      } else {
        // Move to next hour
        candidate.setHours(candidate.getHours() + 1);
        candidate.setMinutes(parts.minutes[0]);
      }
      continue;
    }

    // All parts match!
    return candidate;
  }

  console.error('[CronParser] Could not find next run time within 2 years:', expression);
  return null;
}

/**
 * Validate a cron expression
 */
export function isValidCronExpression(expression: string): boolean {
  return parseCronExpression(expression) !== null;
}

/**
 * Get a human-readable description of a cron expression
 */
export function describeCronExpression(expression: string): string {
  const parts = parseCronExpression(expression);
  if (!parts) return 'Invalid cron expression';

  const descriptions: string[] = [];

  // Minutes
  if (parts.minutes.length === 60) {
    descriptions.push('Every minute');
  } else if (parts.minutes.length === 1) {
    descriptions.push(`At minute ${parts.minutes[0]}`);
  } else {
    descriptions.push(`At minutes ${parts.minutes.join(', ')}`);
  }

  // Hours
  if (parts.hours.length === 24) {
    descriptions.push('every hour');
  } else if (parts.hours.length === 1) {
    const hour = parts.hours[0];
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    descriptions.push(`at ${hour12}:00 ${ampm}`);
  } else {
    descriptions.push(`during hours ${parts.hours.join(', ')}`);
  }

  // Days
  if (parts.daysOfMonth.length < 31 || parts.daysOfWeek.length < 7) {
    if (parts.daysOfWeek.length < 7) {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      descriptions.push(`on ${parts.daysOfWeek.map(d => dayNames[d]).join(', ')}`);
    }
    if (parts.daysOfMonth.length < 31) {
      descriptions.push(`on day(s) ${parts.daysOfMonth.join(', ')}`);
    }
  }

  // Months
  if (parts.months.length < 12) {
    const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    descriptions.push(`in ${parts.months.map(m => monthNames[m]).join(', ')}`);
  }

  return descriptions.join(' ');
}

/**
 * Common cron presets
 */
export const CRON_PRESETS = {
  EVERY_MINUTE: '* * * * *',
  EVERY_5_MINUTES: '*/5 * * * *',
  EVERY_15_MINUTES: '*/15 * * * *',
  EVERY_30_MINUTES: '*/30 * * * *',
  EVERY_HOUR: '0 * * * *',
  EVERY_2_HOURS: '0 */2 * * *',
  EVERY_6_HOURS: '0 */6 * * *',
  EVERY_12_HOURS: '0 */12 * * *',
  DAILY_MIDNIGHT: '0 0 * * *',
  DAILY_2AM: '0 2 * * *',
  DAILY_6AM: '0 6 * * *',
  DAILY_NOON: '0 12 * * *',
  WEEKLY_SUNDAY: '0 0 * * 0',
  WEEKLY_MONDAY: '0 0 * * 1',
  MONTHLY_FIRST: '0 0 1 * *',
  WEEKDAYS_9AM: '0 9 * * 1-5',
} as const;
