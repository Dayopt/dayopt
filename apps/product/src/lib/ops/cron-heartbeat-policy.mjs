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

/**
 * Enabled jobs need exactly one recent completion. Inactive jobs must not have one:
 * a recent completion means the job really runs and the declaration is stale.
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
    const completed = Date.parse(matches[0].last_completed_at ?? '');
    const recent =
      Number.isFinite(completed) && completed <= now + 60_000 && now - completed <= maxAge * 60_000;
    if (mode === 'enabled' && !recent) {
      failures.push(`${name}: last completion exceeds ${maxAge} minutes or is invalid`);
    }
    if (mode === 'inactive' && recent) {
      failures.push(`${name}: declared inactive but completed within ${maxAge} minutes`);
    }
  }
  return failures;
}
