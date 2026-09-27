BEGIN;

-- Browser consent is origin-local. Server-side analytics needs an account-level
-- decision that can be revoked from any authenticated Product device.
ALTER TABLE public.profiles
  ADD COLUMN analytics_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN analytics_consent_updated_at timestamptz;

-- Profiles exposes only approved writable columns to authenticated clients.
-- The existing own-profile RLS policy still limits which row can be updated.
GRANT UPDATE (analytics_consent, analytics_consent_updated_at)
  ON public.profiles TO authenticated;

COMMENT ON COLUMN public.profiles.analytics_consent IS
  'Explicit account-level permission for optional server-side PostHog analytics. False by default and after revocation.';
COMMENT ON COLUMN public.profiles.analytics_consent_updated_at IS
  'Time of the latest explicit account-level analytics decision; NULL means no decision.';

COMMIT;
