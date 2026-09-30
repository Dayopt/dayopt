export const JOB_MAX_AGE_MINUTES: Readonly<{
  'calendar-sync': 45;
  'external-connection-maintenance': 45;
  'calendar-account-deletion-settle': 180;
  'expire-calendar-revoke-outbox': 3;
  'cleanup-product-events': 4320;
  'cleanup-calendar-authority-retention': 180;
  'expire-calendar-revoke-authority': 180;
  'finalize-calendar-revoke-guards': 180;
}>;

export type CronHeartbeatJobName = keyof typeof JOB_MAX_AGE_MINUTES;

export interface CronHeartbeatStatusRow {
  job_name: string;
  last_completed_at: string | null;
}

export function evaluateHeartbeats(rows: readonly CronHeartbeatStatusRow[], now?: number): string[];
