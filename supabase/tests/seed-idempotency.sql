-- Run after the normal local Supabase start has applied seed.sql once.
-- Re-applying a branch seed must keep the fixture stable and preserve edits.
BEGIN;

CREATE TEMP TABLE seed_fixture_before ON COMMIT DROP AS
SELECT
  (SELECT array_agg(id::TEXT ORDER BY id::TEXT)
   FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001') AS auth_user_ids,
  (SELECT array_agg(id::TEXT || ':' || provider || ':' || provider_id ORDER BY id::TEXT, provider_id)
   FROM auth.identities WHERE user_id = '00000000-0000-0000-0000-000000000001') AS identity_keys,
  (SELECT array_agg(user_id::TEXT ORDER BY user_id::TEXT)
   FROM public.user_settings WHERE user_id = '00000000-0000-0000-0000-000000000001') AS setting_user_ids,
  (SELECT array_agg(id::TEXT ORDER BY id::TEXT)
   FROM public.categories WHERE user_id = '00000000-0000-0000-0000-000000000001') AS category_ids,
  (SELECT array_agg(id::TEXT ORDER BY id::TEXT)
   FROM public.activities WHERE user_id = '00000000-0000-0000-0000-000000000001') AS activity_ids,
  (SELECT array_agg(id::TEXT ORDER BY id::TEXT)
   FROM public.plans WHERE user_id = '00000000-0000-0000-0000-000000000001') AS plan_ids,
  (SELECT array_agg(id::TEXT ORDER BY id::TEXT)
   FROM public.records WHERE user_id = '00000000-0000-0000-0000-000000000001') AS record_ids;

-- Conflict-safe fixture inserts must preserve existing user edits.
UPDATE public.user_settings
SET timezone = 'Etc/UTC'
WHERE user_id = '00000000-0000-0000-0000-000000000001';

UPDATE public.categories
SET name = '手動編集済み'
WHERE id = 'c0000000-0000-0000-0000-000000000001';

\ir ../seed.sql
\ir ../seed.sql

DO $$
DECLARE
  before_state RECORD;
BEGIN
  SELECT * INTO STRICT before_state FROM seed_fixture_before;

  IF before_state.auth_user_ids IS DISTINCT FROM (
    SELECT array_agg(id::TEXT ORDER BY id::TEXT)
    FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture Auth users';
  END IF;
  IF before_state.identity_keys IS DISTINCT FROM (
    SELECT array_agg(id::TEXT || ':' || provider || ':' || provider_id ORDER BY id::TEXT, provider_id)
    FROM auth.identities WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture Auth identities';
  END IF;
  IF before_state.setting_user_ids IS DISTINCT FROM (
    SELECT array_agg(user_id::TEXT ORDER BY user_id::TEXT)
    FROM public.user_settings WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture settings rows';
  END IF;
  IF before_state.category_ids IS DISTINCT FROM (
    SELECT array_agg(id::TEXT ORDER BY id::TEXT)
    FROM public.categories WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture categories';
  END IF;
  IF before_state.activity_ids IS DISTINCT FROM (
    SELECT array_agg(id::TEXT ORDER BY id::TEXT)
    FROM public.activities WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture activities';
  END IF;
  IF before_state.plan_ids IS DISTINCT FROM (
    SELECT array_agg(id::TEXT ORDER BY id::TEXT)
    FROM public.plans WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture plans';
  END IF;
  IF before_state.record_ids IS DISTINCT FROM (
    SELECT array_agg(id::TEXT ORDER BY id::TEXT)
    FROM public.records WHERE user_id = '00000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'seed re-run changed fixture records';
  END IF;
  IF (SELECT timezone FROM public.user_settings
      WHERE user_id = '00000000-0000-0000-0000-000000000001') IS DISTINCT FROM 'Etc/UTC' THEN
    RAISE EXCEPTION 'seed re-run overwrote a user settings edit';
  END IF;
  IF (SELECT name FROM public.categories
      WHERE id = 'c0000000-0000-0000-0000-000000000001') IS DISTINCT FROM '手動編集済み' THEN
    RAISE EXCEPTION 'seed re-run overwrote a category edit';
  END IF;
END $$;

ROLLBACK;
