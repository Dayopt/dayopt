-- Isolated validation database only. Real pg_cron commands run against its own fixtures.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'dayopt_mcp_monitoring_%'
    AND coalesce(current_setting('app.isolated_validation',true),'') <> 'on' THEN
    RAISE EXCEPTION 'Use an isolated validation database';
  END IF;
END $$;
SET LOCAL ROLE service_role;
INSERT INTO public.cron_heartbeats(job_name,last_started_at) VALUES
('calendar-sync',now()),('external-connection-maintenance',now()),('calendar-account-deletion-settle',now())
ON CONFLICT(job_name) DO UPDATE SET last_started_at=excluded.last_started_at;
UPDATE public.cron_heartbeats SET last_completed_at=clock_timestamp(),last_summary='{"succeeded":true}'
WHERE job_name IN ('calendar-sync','external-connection-maintenance','calendar-account-deletion-settle');
RESET ROLE;
DO $test$
DECLARE
  v_job RECORD;
  v_count INTEGER := 0;
BEGIN
  IF has_table_privilege('anon','public.cron_heartbeats','SELECT')
    OR has_table_privilege('authenticated','public.cron_heartbeats','UPDATE') THEN
    RAISE EXCEPTION 'User roles can access cron heartbeats';
  END IF;
  FOR v_job IN SELECT * FROM cron.job WHERE jobname IN (
    'expire-calendar-revoke-outbox','cleanup-product-events','cleanup-calendar-authority-retention',
    'expire-calendar-revoke-authority','finalize-calendar-revoke-guards'
  ) LOOP
    IF position('public.cron_heartbeats' IN v_job.command)=0 THEN RAISE EXCEPTION 'Missing heartbeat: %',v_job.jobname; END IF;
    EXECUTE v_job.command;
    IF NOT EXISTS(SELECT 1 FROM public.cron_heartbeats WHERE job_name=v_job.jobname
      AND last_completed_at >= last_started_at) THEN RAISE EXCEPTION 'Cron did not record completion: %',v_job.jobname; END IF;
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> 5 THEN RAISE EXCEPTION 'Expected 5 pg_cron jobs'; END IF;
  IF (SELECT count(*) FROM public.cron_heartbeats WHERE last_completed_at IS NOT NULL) <> 8 THEN
    RAISE EXCEPTION 'Expected completion evidence for all 8 jobs';
  END IF;
  RAISE NOTICE 'PASS service-role writes, user-role denial, and completion of 5 pg_cron commands';
END;
$test$;
ROLLBACK;
