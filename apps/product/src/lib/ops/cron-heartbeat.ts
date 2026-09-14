import { captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

type CronJob =
  'calendar-sync' | 'external-connection-maintenance' | 'calendar-account-deletion-settle';

/** Telemetry failure must not prevent retention/deletion work. Two calls cost at most 3 seconds. */
export async function writeCronHeartbeat(
  job: CronJob,
  phase: 'started' | 'completed',
  startedAt: string,
) {
  try {
    const client = createServiceRoleClient();
    const query =
      phase === 'started'
        ? client.from('cron_heartbeats').upsert({ job_name: job, last_started_at: startedAt })
        : client
            .from('cron_heartbeats')
            .update({
              last_completed_at: new Date().toISOString(),
              last_summary: { succeeded: true, duration_ms: Date.now() - Date.parse(startedAt) },
            })
            .eq('job_name', job)
            .eq('last_started_at', startedAt);
    const { error } = await query.abortSignal(AbortSignal.timeout(1_500));
    if (error) throw new Error('Cron heartbeat persistence failed');
  } catch {
    captureUnexpectedError(new Error('Cron heartbeat persistence failed'), {
      feature: 'operations',
      operation: `cron_heartbeat_${phase}`,
      route: `/api/cron/${job}`,
    });
  }
}
