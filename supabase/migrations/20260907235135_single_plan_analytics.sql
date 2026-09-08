BEGIN;
ALTER TABLE public.product_events DROP CONSTRAINT product_events_event_name_check;
ALTER TABLE public.product_events ADD CONSTRAINT product_events_event_name_check CHECK (
  event_name IN ('user_signed_up', 'plan_created', 'record_created', 'review_opened',
    'checkout_started', 'subscription_started', 'app_trial_started',
    'subscription_payment_succeeded', 'subscription_renewal_succeeded', 'subscription_ended')
);
COMMIT;
