-- Keep the first paid invoice identity beyond the 90-day product event window.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION public.has_prior_paid_invoice_event_v1(UUID, UUID);
DROP FUNCTION private.has_prior_paid_invoice_event_v1(UUID, UUID);

CREATE TABLE private.posthog_first_paid_invoices (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_event_id UUID NOT NULL
);

-- Preserve any paid invoice evidence still available in the bounded event log.
INSERT INTO private.posthog_first_paid_invoices (user_id, invoice_event_id)
SELECT DISTINCT ON (event.user_id)
  event.user_id,
  event.id
FROM public.product_events AS event
WHERE event.event_name IN (
  'subscription_payment_succeeded',
  'subscription_renewal_succeeded'
)
ORDER BY event.user_id, event.created_at, event.id
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE private.posthog_first_paid_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.posthog_first_paid_invoices
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.claim_posthog_first_paid_invoice_v1(
  p_user_id UUID,
  p_invoice_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  first_invoice_event_id UUID;
BEGIN
  INSERT INTO private.posthog_first_paid_invoices (user_id, invoice_event_id)
  VALUES (p_user_id, p_invoice_event_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT invoice.invoice_event_id
  INTO first_invoice_event_id
  FROM private.posthog_first_paid_invoices AS invoice
  WHERE invoice.user_id = p_user_id;

  RETURN first_invoice_event_id = p_invoice_event_id;
END;
$$;

REVOKE ALL ON FUNCTION private.claim_posthog_first_paid_invoice_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.claim_posthog_first_paid_invoice_v1(UUID, UUID)
  TO service_role;

CREATE FUNCTION public.claim_posthog_first_paid_invoice_v1(
  p_user_id UUID,
  p_invoice_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.claim_posthog_first_paid_invoice_v1(p_user_id, p_invoice_event_id);
$$;

REVOKE ALL ON FUNCTION public.claim_posthog_first_paid_invoice_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_posthog_first_paid_invoice_v1(UUID, UUID)
  TO service_role;

DO $assert_privileges$
BEGIN
  IF pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'INSERT')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'UPDATE')
    OR pg_catalog.has_table_privilege('service_role', 'private.posthog_first_paid_invoices', 'DELETE')
    OR pg_catalog.has_table_privilege('anon', 'private.posthog_first_paid_invoices', 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', 'private.posthog_first_paid_invoices', 'SELECT') THEN
    RAISE EXCEPTION 'first paid invoice marker must remain private';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.claim_posthog_first_paid_invoice_v1(uuid,uuid)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'first paid invoice claim RPC privileges are too broad';
  END IF;
END;
$assert_privileges$;

COMMENT ON TABLE private.posthog_first_paid_invoices IS
  'Lifetime first-paid invoice deduplication marker; removed with its auth.users row.';
COMMENT ON FUNCTION private.claim_posthog_first_paid_invoice_v1(UUID, UUID) IS
  'Claims the first invoice event for a user and returns true again only for that same invoice.';

COMMIT;
