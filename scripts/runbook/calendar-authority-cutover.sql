-- Configuration DML, not a schema migration. Target: Production only.
-- Public OAuth client identity verified in Google and confirmed by the owner.
-- Default is ROLLBACK. COMMIT requires reviewed dry-run, backup and explicit authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- Block legacy callback and maintenance writes through the preflight/cutover.
LOCK TABLE private.calendar_authority_projects,
  private.calendar_authority_fences,
  private.calendar_revoke_operations,
  private.calendar_revoke_outbox,
  private.user_data_controls,
  public.calendar_connections IN EXCLUSIVE MODE;

DO $cutover$
DECLARE
  v_project_key CONSTANT TEXT := '52921473418';
  v_client_id CONSTANT TEXT := '52921473418-gb3f8tb66kf7itic5r7ra32saojgmkfh.apps.googleusercontent.com';
  v_readiness RECORD;
  v_changed INTEGER;
  v_connection JSONB;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.provision_calendar_authority_project_v1(text,text)'::regprocedure)
      IS DISTINCT FROM '306d817b323f64c7ca042ecd1fd431ae'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.get_calendar_authority_readiness_v1(text,text)'::regprocedure)
      IS DISTINCT FROM '53b065dcb498575e668202d275865d31'
    OR EXISTS (SELECT 1 FROM private.calendar_authority_projects)
    OR EXISTS (SELECT 1 FROM private.calendar_authority_fences)
    OR EXISTS (SELECT 1 FROM private.calendar_revoke_operations)
    OR EXISTS (SELECT 1 FROM private.calendar_revoke_outbox)
    OR (SELECT count(*) FROM public.calendar_connections WHERE provider = 'google') <> 1
    OR (SELECT count(*) FROM public.calendar_connections
        WHERE provider = 'google' AND status = 'active'
          AND authority_fence_id IS NULL AND authority_epoch IS NULL) <> 1
    OR EXISTS (
      SELECT 1 FROM public.calendar_connections AS connection
      LEFT JOIN private.user_data_controls AS control ON control.user_id = connection.user_id
      WHERE connection.provider = 'google'
        AND connection.data_generation IS DISTINCT FROM COALESCE(control.generation, 0)
    ) THEN
    RAISE EXCEPTION 'Calendar cutover baseline changed; re-audit before retrying'
      USING ERRCODE = '55000';
  END IF;

  SELECT to_jsonb(connection) - 'authority_fence_id' - 'authority_epoch' - 'updated_at'
  INTO STRICT v_connection FROM public.calendar_connections AS connection
  WHERE provider = 'google';

  PERFORM public.provision_calendar_authority_project_v1(v_project_key, v_client_id);
  IF (SELECT to_jsonb(connection) - 'authority_fence_id' - 'authority_epoch' - 'updated_at'
      FROM public.calendar_connections AS connection WHERE provider = 'google')
      IS DISTINCT FROM v_connection THEN
    RAISE EXCEPTION 'Calendar provision changed protected connection data'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO STRICT v_readiness
  FROM public.get_calendar_authority_readiness_v1(v_project_key, v_client_id);
  IF v_readiness.activated OR v_readiness.project_state <> 'ready'
    OR v_readiness.pending_operations <> 0 OR v_readiness.unbound_connections <> 0
    OR v_readiness.unbound_outbox <> 0 THEN
    RAISE EXCEPTION 'Calendar authority is not ready for activation' USING ERRCODE = '55000';
  END IF;

  UPDATE private.calendar_authority_projects
  SET activation_version = 1, activated_at = pg_catalog.clock_timestamp()
  WHERE singleton AND project_key = v_project_key AND oauth_client_id = v_client_id
    AND activation_version = 0 AND activated_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'Calendar authority activation did not update exactly one row'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO STRICT v_readiness
  FROM public.get_calendar_authority_readiness_v1(v_project_key, v_client_id);
  IF NOT v_readiness.activated OR v_readiness.project_state <> 'ready'
    OR v_readiness.pending_operations <> 0 OR v_readiness.unbound_connections <> 0
    OR v_readiness.unbound_outbox <> 0 THEN
    RAISE EXCEPTION 'Calendar authority postcondition failed' USING ERRCODE = '55000';
  END IF;
END;
$cutover$;

-- Aggregates only: never emit user identifiers or token ciphertext.
SELECT activation_version = 1 AND activated_at IS NOT NULL AS activated,
  (SELECT count(*) FROM public.calendar_connections WHERE provider = 'google'
    AND authority_fence_id IS NULL) AS unbound_connections
FROM private.calendar_authority_projects WHERE singleton;
ROLLBACK;
