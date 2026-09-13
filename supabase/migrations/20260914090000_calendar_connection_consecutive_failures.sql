-- #2687: 恒久的に失敗し続ける外部カレンダー接続を見分けられるようにする。
--
-- 1. calendar_connections.consecutive_failures を追加する（expand-only。既存列には触れない）。
--    前進した run（成功 / partial_timeout）で 0、前進しなかった失敗 run で +1。
--    authenticated には GRANT しない（UI は last_sync_error と last_synced_at だけを読む）。
-- 2. finish_calendar_sync_run_v1 を、前進しなかった run では last_synced_at を進めない形へ置き換える。
--    署名・権限・CAS（lock_calendar_sync_writer_v1 以下）は 20260820120000 から変えない。
--
-- 閾値を超えた接続を cron の due から外す判定は app 側（sync-dispatcher.ts）が持つ。
-- status は変えない（provider 障害や DB 障害でも数が積もるため、全ユーザーを再同意に
-- 追い込まない。encryption_key_invalid と同じ方針）。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.calendar_connections
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
    CONSTRAINT calendar_connections_consecutive_failures_non_negative
      CHECK (consecutive_failures >= 0);

COMMENT ON COLUMN public.calendar_connections.consecutive_failures IS
  'Consecutive sync runs that ended without progress. Reset to 0 by a run that synced at least one calendar (#2687). Not granted to authenticated.';

CREATE OR REPLACE FUNCTION public.finish_calendar_sync_run_v1(
  p_project_key TEXT,
  p_user_id UUID,
  p_connection_id UUID,
  p_expected_generation BIGINT,
  p_expected_authority_fence_id UUID,
  p_expected_authority_epoch BIGINT,
  p_expected_sync_sequence BIGINT,
  p_run_started_at TIMESTAMPTZ,
  p_last_sync_error TEXT,
  p_prune_window BOOLEAN,
  p_not_before TIMESTAMPTZ,
  p_not_after TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  v_writer_state TEXT;
  v_connection_last_synced_at TIMESTAMPTZ;
  v_now CONSTANT TIMESTAMPTZ := pg_catalog.clock_timestamp();
  -- 前進した run か。partial_timeout は 1 カレンダー以上を完走した run だけが書く
  -- （sync-service.ts。1 つも完走しなかった予算切れは finish を呼ばない）。
  v_progressed CONSTANT BOOLEAN :=
    p_last_sync_error IS NULL OR p_last_sync_error = 'partial_timeout';
BEGIN
  PERFORM private.assert_timeblock_service_role_request_v1();

  IF p_run_started_at IS NULL
    OR p_run_started_at > v_now + INTERVAL '1 minute'
    OR p_last_sync_error NOT IN (
      'encryption_key_invalid',
      'partial_failure',
      'partial_timeout',
      'provider_unavailable',
      'rate_limited',
      'reauth_required'
    )
      AND p_last_sync_error IS NOT NULL
    OR p_prune_window IS NULL
    OR (
      p_prune_window
      AND (
        p_not_before IS NULL
        OR p_not_after IS NULL
        OR p_not_after <= p_not_before
      )
    )
    OR (
      NOT p_prune_window
      AND (p_not_before IS NOT NULL OR p_not_after IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'Invalid Calendar sync completion input'
      USING ERRCODE = '22023';
  END IF;

  v_writer_state := private.lock_calendar_sync_writer_v1(
    p_project_key,
    p_user_id,
    p_connection_id,
    p_expected_generation,
    p_expected_authority_fence_id,
    p_expected_authority_epoch,
    p_expected_sync_sequence
  );

  IF v_writer_state IS DISTINCT FROM 'current' THEN
    RETURN v_writer_state;
  END IF;

  SELECT connection.last_synced_at
  INTO v_connection_last_synced_at
  FROM public.calendar_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id;

  IF v_connection_last_synced_at > p_run_started_at THEN
    RETURN 'superseded';
  END IF;

  IF p_prune_window THEN
    DELETE FROM public.external_calendar_events AS event
    WHERE event.user_id = p_user_id
      AND event.connection_id = p_connection_id
      AND event.last_synced_at <= p_run_started_at
      AND (
        event.end_at < p_not_before
        OR event.start_at > p_not_after
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.plans AS plan
        WHERE plan.user_id = p_user_id
          AND plan.external_calendar_event_id = event.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.records AS record
        WHERE record.user_id = p_user_id
          AND record.external_calendar_event_id = event.id
      );
  END IF;

  -- #2687: 前進しなかった run は last_synced_at を進めず、連続失敗数だけを積む。
  -- 恒久的に壊れた接続の「最終同期」が常に新しく見える状態を作らないため。
  -- 行は lock_calendar_sync_writer_v1 が FOR UPDATE 済みなので加算は競合しない。
  UPDATE public.calendar_connections AS connection
  SET last_sync_error = p_last_sync_error,
      last_synced_at = CASE
        WHEN v_progressed THEN p_run_started_at
        ELSE connection.last_synced_at
      END,
      consecutive_failures = CASE
        WHEN v_progressed THEN 0
        ELSE LEAST(connection.consecutive_failures, 2147483646) + 1
      END
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id;

  RETURN 'finished';
END;
$$;

REVOKE ALL ON FUNCTION public.finish_calendar_sync_run_v1(
  TEXT, UUID, UUID, BIGINT, UUID, BIGINT, BIGINT, TIMESTAMPTZ,
  TEXT, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_calendar_sync_run_v1(
  TEXT, UUID, UUID, BIGINT, UUID, BIGINT, BIGINT, TIMESTAMPTZ,
  TEXT, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

COMMENT ON FUNCTION public.finish_calendar_sync_run_v1(
  TEXT, UUID, UUID, BIGINT, UUID, BIGINT, BIGINT, TIMESTAMPTZ,
  TEXT, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Publishes connection status and optional anti-join window pruning only if no newer DB-issued sync run, purge, reconnect, selection change, or revoke superseded it; service role only. p_last_sync_error allowlist includes partial_timeout (#2078). Runs without progress keep last_synced_at and increment consecutive_failures (#2687).';

COMMIT;
