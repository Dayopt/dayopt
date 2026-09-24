-- Narrow server-only analytics lookups. The service-role client can record events, but it
-- cannot SELECT product_events or access the claim table directly.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE private.posthog_signup_claims (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE private.posthog_signup_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.posthog_signup_claims
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.has_prior_paid_invoice_event_v1(
  p_user_id UUID,
  p_current_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.product_events AS event
    WHERE event.user_id = p_user_id
      AND event.event_name IN (
        'subscription_payment_succeeded',
        'subscription_renewal_succeeded'
      )
      AND event.id <> p_current_event_id
  );
$$;

REVOKE ALL ON FUNCTION private.has_prior_paid_invoice_event_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.has_prior_paid_invoice_event_v1(UUID, UUID)
  TO service_role;

CREATE FUNCTION public.has_prior_paid_invoice_event_v1(
  p_user_id UUID,
  p_current_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.has_prior_paid_invoice_event_v1(p_user_id, p_current_event_id);
$$;

REVOKE ALL ON FUNCTION public.has_prior_paid_invoice_event_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_prior_paid_invoice_event_v1(UUID, UUID)
  TO service_role;

CREATE FUNCTION private.claim_posthog_signup_v1(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claimed BOOLEAN := FALSE;
BEGIN
  INSERT INTO private.posthog_signup_claims (user_id)
  SELECT profile.id
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.analytics_consent IS TRUE
  ON CONFLICT (user_id) DO NOTHING
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION private.claim_posthog_signup_v1(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.claim_posthog_signup_v1(UUID)
  TO service_role;

CREATE FUNCTION public.claim_posthog_signup_v1(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.claim_posthog_signup_v1(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.claim_posthog_signup_v1(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_posthog_signup_v1(UUID)
  TO service_role;

DO $assert_privileges$
BEGIN
  IF pg_catalog.has_table_privilege('service_role', 'private.posthog_signup_claims', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_signup_claims', 'INSERT')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_signup_claims', 'UPDATE')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_signup_claims', 'DELETE') THEN
    RAISE EXCEPTION 'service_role must use the signup claim RPC, not the private table';
  END IF;

  IF pg_catalog.has_table_privilege('service_role', 'public.product_events', 'SELECT') THEN
    RAISE EXCEPTION 'service_role product_events must remain write-only';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.has_prior_paid_invoice_event_v1(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.has_prior_paid_invoice_event_v1(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.has_prior_paid_invoice_event_v1(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.claim_posthog_signup_v1(uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.claim_posthog_signup_v1(uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'PostHog analytics RPC privileges are too broad';
  END IF;
END;
$assert_privileges$;

COMMIT;
