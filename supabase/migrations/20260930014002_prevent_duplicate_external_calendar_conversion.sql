-- Prevent stale tabs, moved conversions, and restores from producing duplicate
-- active references. Plan and Record remain independent; soft-deleted rows do
-- not consume the slot. No existing user data is deleted or rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Hold the same writer-blocking lock as CREATE INDEX before the preflight so
-- a concurrent write cannot introduce a duplicate between the check and build.
LOCK TABLE public.plans, public.records IN SHARE MODE;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.plans
    WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL
    GROUP BY user_id, external_calendar_event_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM public.records
    WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL
    GROUP BY user_id, external_calendar_event_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Active external calendar references contain duplicates'
      USING ERRCODE = '23505',
            HINT = 'Review existing duplicate references before retrying; do not automatically delete or merge them.';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX plans_active_external_event_unique
  ON public.plans (user_id, external_calendar_event_id)
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL;

CREATE UNIQUE INDEX records_active_external_event_unique
  ON public.records (user_id, external_calendar_event_id)
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL;

COMMENT ON INDEX public.plans_active_external_event_unique IS
  'At most one active Plan per external event; deleted references may be reimported.';
COMMENT ON INDEX public.records_active_external_event_unique IS
  'At most one active Record per external event; Plan and Record may coexist.';

COMMIT;
