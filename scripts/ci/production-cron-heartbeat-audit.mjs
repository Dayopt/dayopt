import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runReadOnlyQuery } from '../lib/production-db-readonly.mjs';

export const JOB_MAX_AGE_MINUTES = {
  'calendar-sync': 45,
  'external-connection-maintenance': 45,
  'calendar-account-deletion-settle': 180,
  'expire-calendar-revoke-outbox': 3,
  'cleanup-product-events': 4320,
  'cleanup-calendar-authority-retention': 180,
  'expire-calendar-revoke-authority': 180,
  'finalize-calendar-revoke-guards': 180,
};

export function evaluateHeartbeats(rows, now = Date.now()) {
  const failures = [];
  for (const [name, maxAge] of Object.entries(JOB_MAX_AGE_MINUTES)) {
    const matches = rows.filter((row) => row?.job_name === name);
    if (matches.length !== 1) {
      failures.push(`${name}: missing or duplicate heartbeat`);
      continue;
    }
    const completed = Date.parse(matches[0].last_completed_at);
    if (
      !Number.isFinite(completed) ||
      completed > now + 60_000 ||
      now - completed > maxAge * 60_000
    ) {
      failures.push(`${name}: last completion exceeds ${maxAge} minutes or is invalid`);
    }
  }
  return failures;
}

export async function auditHeartbeats(query = runReadOnlyQuery, now = Date.now()) {
  const rows = await query(
    'SELECT job_name, last_started_at, last_completed_at FROM public.cron_heartbeats ORDER BY job_name',
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
