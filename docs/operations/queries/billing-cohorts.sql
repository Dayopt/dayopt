-- Read-only. Adjust this window explicitly; product_events retention is 90 days.
-- A cohort is mature only after its entire trial window has elapsed.
WITH cohort AS (
  SELECT id, app_trial_started_at AS started_at, app_trial_ends_at AS ends_at
  FROM public.profiles
  WHERE app_trial_started_at >= now() - interval '89 days'
), outcomes AS (
  SELECT c.*,
    EXISTS(SELECT 1 FROM public.product_events e WHERE e.user_id=c.id
      AND e.event_name IN ('plan_created','record_created','review_opened')
      AND e.created_at >= c.started_at + interval '7 days'
      AND e.created_at < c.started_at + interval '14 days') AS reused_next_week,
    (SELECT min(e.created_at) FROM public.product_events e WHERE e.user_id=c.id
      AND e.event_name='subscription_payment_succeeded' AND e.created_at>=c.started_at) AS first_paid_at,
    EXISTS(SELECT 1 FROM public.product_events e WHERE e.user_id=c.id
      AND e.event_name='subscription_ended' AND e.created_at>=c.started_at) AS ended
  FROM cohort c
)
SELECT date_trunc('week',started_at AT TIME ZONE 'UTC') AS cohort_week_utc,
  min(started_at) AS observed_from, now() AS observed_until,
  count(*) AS people, count(*) FILTER(WHERE ends_at<=now()) AS mature_trials,
  count(*) FILTER(WHERE ends_at>now()) AS immature_trials,
  count(*) FILTER(WHERE started_at+interval '14 days'<=now()) AS next_week_observable,
  count(*) FILTER(WHERE reused_next_week) AS next_week_reused,
  count(*) FILTER(WHERE first_paid_at IS NOT NULL) AS first_paid,
  count(*) FILTER(WHERE first_paid_at+interval '1 month'<=now()) AS renewal_observable,
  count(*) FILTER(WHERE EXISTS(SELECT 1 FROM public.product_events e WHERE e.user_id=outcomes.id
    AND e.event_name='subscription_renewal_succeeded' AND e.created_at>first_paid_at)) AS renewed,
  count(*) FILTER(WHERE ended) AS ended
FROM outcomes GROUP BY 1 ORDER BY 1;
-- Counts represent retained events, not lifetime revenue. For financial reconciliation,
-- use Stripe invoices. Trial start/expiry denominators use profiles, not best-effort events.
