-- #2681: payload-free completion evidence for Vercel and pg_cron maintenance.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE public.cron_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ NOT NULL,
  last_completed_at TIMESTAMPTZ,
  last_summary JSONB,
  CONSTRAINT cron_heartbeats_job_name_check CHECK (job_name IN (
    'calendar-sync', 'external-connection-maintenance', 'calendar-account-deletion-settle',
    'expire-calendar-revoke-outbox', 'cleanup-product-events',
    'cleanup-calendar-authority-retention', 'expire-calendar-revoke-authority',
    'finalize-calendar-revoke-guards'
  ))
);
ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_heartbeats FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.cron_heartbeats TO service_role;
COMMENT ON TABLE public.cron_heartbeats IS
  'Maintenance liveness metadata. No user identifiers, tokens, or provider payloads. pg_cron failures roll back heartbeat writes with the job transaction.';

-- Preserve deployed schedules and commands; refuse missing, duplicate, or foreign-owned jobs.
-- pg_cron executes each multi-statement command atomically: failed runs retain the last success.
DO $migration$
DECLARE
  v_name TEXT;
  v_job RECORD;
  v_count INTEGER;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'expire-calendar-revoke-outbox', 'cleanup-product-events',
    'cleanup-calendar-authority-retention', 'expire-calendar-revoke-authority',
    'finalize-calendar-revoke-guards'
  ] LOOP
    SELECT count(*) INTO v_count FROM cron.job WHERE jobname=v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one cron job for %, found %', v_name, v_count;
    END IF;
    SELECT * INTO STRICT v_job FROM cron.job WHERE jobname=v_name;
    IF v_job.username <> current_user OR v_job.database <> current_database() OR NOT v_job.active THEN
      RAISE EXCEPTION 'Cron job % is disabled or belongs to another role/database; reconcile before migration', v_name;
    END IF;
    PERFORM cron.alter_job(v_job.jobid, command :=
      format('INSERT INTO public.cron_heartbeats(job_name,last_started_at) VALUES (%L,clock_timestamp()) ON CONFLICT(job_name) DO UPDATE SET last_started_at=EXCLUDED.last_started_at;
',v_name)
      || v_job.command || E'
;
'
      || format('UPDATE public.cron_heartbeats SET last_completed_at=clock_timestamp(),last_summary=jsonb_build_object(''succeeded'',true) WHERE job_name=%L;',v_name)
    );
  END LOOP;
END;
$migration$;
COMMIT;
