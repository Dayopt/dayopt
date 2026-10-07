import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  evaluateHeartbeats,
  JOB_MAX_AGE_MINUTES,
} from '../../apps/product/src/lib/ops/cron-heartbeat-policy.mjs';
import { runReadOnlyQuery } from '../lib/production-db-readonly.mjs';

export { evaluateHeartbeats, JOB_MAX_AGE_MINUTES };

export async function auditHeartbeats(query = runReadOnlyQuery, now = Date.now()) {
  const rows = await query(
    "SELECT job_name, last_started_at, last_completed_at, CASE WHEN last_summary->>'outcome' = 'skipped_unconfigured' THEN 'skipped_unconfigured' ELSE NULL END AS outcome FROM public.cron_heartbeats ORDER BY job_name",
  );
  const failures = evaluateHeartbeats(rows, now);
  if (failures.length) throw new Error(failures.join('\n'));
  return rows.length;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    await auditHeartbeats();
    console.log('Production Cron Heartbeat Audit passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cron heartbeat audit failed');
    process.exitCode = 1;
  }
}
