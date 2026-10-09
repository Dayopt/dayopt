export const JOB_MAX_AGE_MINUTES = Object.freeze({
  'calendar-sync': 45,
  'external-connection-maintenance': 45,
  'calendar-account-deletion-settle': 180,
  'expire-calendar-revoke-outbox': 3,
  'cleanup-product-events': 4320,
  'cleanup-calendar-authority-retention': 180,
  'expire-calendar-revoke-authority': 180,
  'finalize-calendar-revoke-guards': 180,
  'billing-reconciliation': 1560,
});

/**
 * Expected production mode of jobs that can be intentionally inactive (#3010).
 * This reviewed declaration is the source of truth; missing env is never read as inactive.
 * Switch billing-reconciliation to 'enabled' in the production billing rollout (#2869).
 */
export const EXPECTED_JOB_MODES = Object.freeze({
  'billing-reconciliation': 'inactive',
});

const KNOWN_MODES = new Set(['enabled', 'inactive']);

function expectedMode(name, modes) {
  return Object.hasOwn(modes, name) ? modes[name] : 'enabled';
}

/** Jobs declared inactive, so audit output can show the skip as intentional. */
export function listInactiveJobs(modes = EXPECTED_JOB_MODES) {
  return Object.keys(JOB_MAX_AGE_MINUTES).filter(
    (name) => expectedMode(name, modes) === 'inactive',
  );
}

function isRecent(timestamp, now, maxAge) {
  const at = Date.parse(timestamp ?? '');
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= maxAge * 60_000;
}

function isOlderThan(timestamp, now, maxAge) {
  const at = Date.parse(timestamp ?? '');
  return Number.isFinite(at) && now - at > maxAge * 60_000;
}

/**
 * Enabled jobs need exactly one recent completion. An inactive job passes only without a row
 * or with a row whose start and completion are both stale: any newer run, including a failed
 * one that never completed, means the job really runs and the declaration is stale.
 */
export function evaluateHeartbeats(rows, now = Date.now(), modes = EXPECTED_JOB_MODES) {
  const failures = [];
  for (const [name, maxAge] of Object.entries(JOB_MAX_AGE_MINUTES)) {
    const mode = expectedMode(name, modes);
    if (!KNOWN_MODES.has(mode)) {
      failures.push(`${name}: unknown expected mode`);
      continue;
    }
    const matches = rows.filter((row) => row?.job_name === name);
    if (matches.length > 1 || (mode === 'enabled' && matches.length !== 1)) {
      failures.push(`${name}: missing or duplicate heartbeat`);
      continue;
    }
    if (matches.length === 0) continue;
    const row = matches[0];
    if (mode === 'enabled' && !isRecent(row.last_completed_at, now, maxAge)) {
      failures.push(`${name}: last completion exceeds ${maxAge} minutes or is invalid`);
    }
    const startedIsStale =
      row.last_started_at === undefined || isOlderThan(row.last_started_at, now, maxAge);
    if (
      mode === 'inactive' &&
      !(isOlderThan(row.last_completed_at, now, maxAge) && startedIsStale)
    ) {
      failures.push(`${name}: declared inactive but ran within ${maxAge} minutes`);
    }
  }
  return failures;
}
