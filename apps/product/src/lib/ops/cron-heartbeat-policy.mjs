// Production activation is a reviewed release decision, never inferred from missing credentials.
export const BILLING_RECONCILIATION_ACTIVATION = 'pending';

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

/** Require completion, except a fresh explicit skip before billing has ever run. */
export function evaluateHeartbeats(
  rows,
  now = Date.now(),
  billingActivation = BILLING_RECONCILIATION_ACTIVATION,
) {
  const failures = [];
  for (const [name, maxAge] of Object.entries(JOB_MAX_AGE_MINUTES)) {
    const matches = rows.filter((row) => row?.job_name === name);
    if (matches.length !== 1) {
      failures.push(`${name}: missing or duplicate heartbeat`);
      continue;
    }
    const row = matches[0];
    if (name === 'billing-reconciliation' && row.outcome === 'skipped_unconfigured') {
      const invoked = Date.parse(row.last_started_at ?? '');
      if (
        billingActivation !== 'pending' ||
        row.last_completed_at !== null ||
        !Number.isFinite(invoked) ||
        invoked > now + 60_000 ||
        now - invoked > maxAge * 60_000
      ) {
        failures.push(
          `${name}: unconfigured skip is unexpected, stale, or follows a prior completion`,
        );
      }
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
