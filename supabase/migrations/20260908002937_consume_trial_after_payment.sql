-- Existing trial promises consume an intro. active/past_due alone is not proof of payment.
BEGIN;
CREATE OR REPLACE FUNCTION private.consume_app_trial_on_subscription_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.subscription_status = 'trialing' AND NEW.app_trial_consumed_at IS NULL THEN
    NEW.app_trial_consumed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.consume_app_trial_on_subscription_v1() FROM PUBLIC, anon, authenticated;
COMMIT;
