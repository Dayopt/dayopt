import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  evaluateHeartbeats,
  EXPECTED_JOB_MODES,
  JOB_MAX_AGE_MINUTES,
  listInactiveJobs,
} from '../../apps/product/src/lib/ops/cron-heartbeat-policy.mjs';
import { runReadOnlyQuery } from '../lib/production-db-readonly.mjs';

export { evaluateHeartbeats, EXPECTED_JOB_MODES, JOB_MAX_AGE_MINUTES, listInactiveJobs };

/** @param {Readonly<Record<string, string | undefined>>} [modes] */
export async function auditHeartbeats(
  query = runReadOnlyQuery,
  now = Date.now(),
  modes = EXPECTED_JOB_MODES,
) {
  const rows = await query(
    'SELECT job_name, last_started_at, last_completed_at FROM public.cron_heartbeats ORDER BY job_name',
  );
  const failures = evaluateHeartbeats(rows, now, modes);
  if (failures.length) throw new Error(failures.join('\n'));
  return rows.length;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    await auditHeartbeats();
    console.log('Production Cron Heartbeat Audit passed');
    for (const name of listInactiveJobs()) {
      console.log(`${name}: declared inactive, heartbeat not required (intentional skip)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cron heartbeat audit failed');
    process.exitCode = 1;
  }
}
