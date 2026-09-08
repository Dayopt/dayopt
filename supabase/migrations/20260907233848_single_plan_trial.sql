BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN app_trial_started_at timestamptz,
  ADD COLUMN app_trial_ends_at timestamptz,
  ADD COLUMN app_trial_consumed_at timestamptz,
  ADD CONSTRAINT profiles_app_trial_window CHECK (
    (app_trial_started_at IS NULL AND app_trial_ends_at IS NULL)
    OR (app_trial_started_at IS NOT NULL AND app_trial_ends_at IS NOT NULL
        AND app_trial_ends_at = app_trial_started_at + interval '1080 hours')
  );

-- Server-owned just like subscription_status; never extend client column grants.
REVOKE INSERT (app_trial_started_at, app_trial_ends_at, app_trial_consumed_at),
       UPDATE (app_trial_started_at, app_trial_ends_at, app_trial_consumed_at)
  ON public.profiles FROM PUBLIC, anon, authenticated;

-- Historical consumers are classified from paid invoices / promised Stripe trials by
-- the rollout preflight, never from incomplete or asynchronously active status alone.

CREATE FUNCTION private.consume_app_trial_on_subscription_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.subscription_status = 'trialing'
     AND NEW.app_trial_consumed_at IS NULL THEN
    NEW.app_trial_consumed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.consume_app_trial_on_subscription_v1() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER consume_app_trial_on_subscription
BEFORE INSERT OR UPDATE OF subscription_status ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.consume_app_trial_on_subscription_v1();

DO $$
BEGIN
  IF has_column_privilege('authenticated', 'public.profiles', 'app_trial_ends_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'app_trial_ends_at', 'INSERT') THEN
    RAISE EXCEPTION 'app trial columns must remain server-owned';
  END IF;
END;
$$;
COMMIT;
