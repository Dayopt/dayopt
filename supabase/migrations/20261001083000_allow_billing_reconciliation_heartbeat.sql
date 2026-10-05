-- #2864: expand the heartbeat allowlist together with the billing cron writer/audit.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.cron_heartbeats
  DROP CONSTRAINT cron_heartbeats_job_name_check,
  ADD CONSTRAINT cron_heartbeats_job_name_check CHECK (job_name IN (
    'calendar-sync', 'external-connection-maintenance', 'calendar-account-deletion-settle',
    'expire-calendar-revoke-outbox', 'cleanup-product-events',
    'cleanup-calendar-authority-retention', 'expire-calendar-revoke-authority',
    'finalize-calendar-revoke-guards', 'billing-reconciliation'
  ));

COMMIT;
