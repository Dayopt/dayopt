-- Preserve token, scope, resource, revocation and operation fencing; extend only access.
BEGIN;
CREATE OR REPLACE FUNCTION private.authorize_mcp_mutation_v1(
  p_connection_id UUID,
  p_access_token_id UUID,
  p_required_scope TEXT,
  p_operation_id UUID
)
RETURNS TABLE(
  user_id UUID,
  client_id TEXT,
  authorized_at TIMESTAMPTZ,
  authority_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_resource_uri TEXT;
  v_writes_enabled BOOLEAN;
  v_enabled_client_ids TEXT[];
  v_candidate_user_id UUID;
  v_connection public.oauth_connections%ROWTYPE;
  v_token public.oauth_tokens%ROWTYPE;
  v_subscription_status TEXT;
  v_trial_started_at timestamptz;
  v_trial_ends_at timestamptz;
  v_trial_consumed_at timestamptz;
  v_now TIMESTAMPTZ;
  v_authority_expires_at TIMESTAMPTZ;
BEGIN
  IF p_connection_id IS NULL
    OR p_access_token_id IS NULL
    OR p_required_scope IS NULL
    OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'MCP mutation authorization input is incomplete'
      USING ERRCODE = '22004';
  END IF;

  IF p_required_scope <> ALL (ARRAY[
    'write:plans',
    'delete:plans',
    'write:records',
    'delete:records'
  ]::TEXT[]) THEN
    RAISE EXCEPTION 'Unsupported MCP mutation scope'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_resource_uri := private.get_mcp_environment_resource_uri_v1();
  EXCEPTION WHEN SQLSTATE 'DI001' THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END;

  SELECT control.writes_enabled, control.enabled_client_ids
  INTO v_writes_enabled, v_enabled_client_ids
  FROM public.mcp_mutation_control AS control
  WHERE control.singleton_key = true
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP mutation control is missing'
      USING ERRCODE = 'DM002';
  END IF;

  IF NOT v_writes_enabled THEN
    RAISE EXCEPTION 'MCP writes are disabled'
      USING ERRCODE = 'DM003';
  END IF;

  SELECT connection.user_id
  INTO v_candidate_user_id
  FROM public.oauth_connections AS connection
  WHERE connection.id = p_connection_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  BEGIN
    PERFORM private.lock_timeblock_user_write_shared_v1(v_candidate_user_id);
  EXCEPTION WHEN SQLSTATE 'DT001' THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END;

  SELECT connection.*
  INTO v_connection
  FROM public.oauth_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = v_candidate_user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  IF NOT (v_connection.client_id = ANY (v_enabled_client_ids)) THEN
    RAISE EXCEPTION 'MCP writes are disabled for this client'
      USING ERRCODE = 'DM003';
  END IF;

  SELECT token.*
  INTO v_token
  FROM public.oauth_tokens AS token
  WHERE token.id = p_access_token_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  SELECT profile.subscription_status, profile.app_trial_started_at, profile.app_trial_ends_at, profile.app_trial_consumed_at
  INTO v_subscription_status, v_trial_started_at, v_trial_ends_at, v_trial_consumed_at
  FROM public.profiles AS profile
  WHERE profile.id = v_connection.user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Dayopt access is required'
      USING ERRCODE = 'DM005';
  END IF;

  PERFORM private.lock_mcp_mutation_operation_v1(
    v_connection.user_id,
    v_connection.client_id,
    p_operation_id
  );

  v_now := pg_catalog.clock_timestamp();
  v_authority_expires_at := LEAST(v_token.expires_at, v_connection.reauth_required_at);

  IF v_connection.client_id <> ALL (ARRAY['claude-ai', 'chatgpt', 'cursor']::TEXT[])
    OR v_connection.resource_uri IS DISTINCT FROM v_resource_uri
    OR v_connection.legacy_read_only
    OR v_connection.revoked_at IS NOT NULL
    OR v_connection.write_enabled_at IS NULL
    OR NOT (p_required_scope = ANY (v_connection.scopes))
    OR v_token.token_type IS DISTINCT FROM 'access'
    OR v_token.connection_id IS DISTINCT FROM v_connection.id
    OR v_token.user_id IS DISTINCT FROM v_connection.user_id
    OR v_token.client_id IS DISTINCT FROM v_connection.client_id
    OR v_token.resource_uri IS DISTINCT FROM v_resource_uri
    OR v_token.resource_uri IS DISTINCT FROM v_connection.resource_uri
    OR v_token.revoked_at IS NOT NULL
    OR NOT (p_required_scope = ANY (v_token.scopes))
    OR v_authority_expires_at <= v_now THEN
    RAISE EXCEPTION 'MCP authorization is no longer active'
      USING ERRCODE = 'DM004';
  END IF;

  IF v_subscription_status <> ALL (ARRAY['active', 'trialing', 'past_due']::TEXT[])
    AND NOT COALESCE(v_trial_consumed_at IS NULL AND v_trial_started_at <= v_now AND v_now < v_trial_ends_at, false) THEN
    RAISE EXCEPTION 'Active Dayopt access is required'
      USING ERRCODE = 'DM005';
  END IF;

  RETURN QUERY SELECT
    v_connection.user_id,
    v_connection.client_id,
    v_now,
    v_authority_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION private.authorize_mcp_mutation_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
COMMIT;
