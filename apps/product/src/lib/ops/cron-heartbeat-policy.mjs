export const JOB_MAX_AGE_MINUTES = Object.freeze({
  'calendar-sync': 45,
  'external-connection-maintenance': 45,
  'calendar-account-deletion-settle': 180,
  'expire-calendar-revoke-outbox': 3,
  'cleanup-product-events': 4320,
  'cleanup-calendar-authority-retention': 180,
  'expire-calendar-revoke-authority': 180,
  'finalize-calendar-revoke-guards': 180,
});

/** A heartbeat is healthy only when each allowlisted job has one recent completion. */
export function evaluateHeartbeats(rows, now = Date.now()) {
  const failures = [];
  for (const [name, maxAge] of Object.entries(JOB_MAX_AGE_MINUTES)) {
    const matches = rows.filter((row) => row?.job_name === name);
    if (matches.length !== 1) {
      failures.push(`${name}: missing or duplicate heartbeat`);
      continue;
    }
    const completed = Date.parse(matches[0].last_completed_at ?? '');
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
