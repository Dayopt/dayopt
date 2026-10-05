-- Phase B: apply only after Phase A deployment and old-worker retirement evidence.
-- Preserve migration ledger and private POC state; never delete data or use CASCADE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $retirement$
DECLARE
  signature TEXT;
  signatures TEXT[] := ARRAY[
    'public.check_supabase_rate_limit_poc(text,text,integer,integer)',
    'public.claim_supabase_webhook_event_poc(text,uuid)',
    'public.complete_supabase_webhook_event_poc(text,uuid)',
    'public.release_supabase_webhook_event_poc(text,uuid)',
    'public.prune_supabase_rate_limit_poc(integer)'
  ];
  existing_count INTEGER;
BEGIN
  SELECT count(*) INTO existing_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[
    'check_supabase_rate_limit_poc', 'claim_supabase_webhook_event_poc',
    'complete_supabase_webhook_event_poc', 'release_supabase_webhook_event_poc',
    'prune_supabase_rate_limit_poc'
  ]);
  IF to_regnamespace('rate_limit_poc') IS NULL THEN
    IF existing_count <> 0 THEN
      RAISE EXCEPTION 'POC RPCs exist without expected private schema; stop retirement';
    END IF;
    RETURN; -- Fresh install: same-version tombstone did not create experimental objects.
  END IF;
  IF existing_count <> 5 THEN
    RAISE EXCEPTION 'Unexpected POC RPC inventory; stop retirement';
  END IF;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'rate_limit_poc' AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))
      IS DISTINCT FROM ARRAY['supabase_rate_limit_state_poc', 'supabase_webhook_claims_poc']::TEXT[] THEN
    RAISE EXCEPTION 'Unexpected POC state inventory; stop retirement';
  END IF;
  FOREACH signature IN ARRAY signatures LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Expected POC RPC signature missing: %', signature;
    END IF;
    EXECUTE 'DROP FUNCTION ' || signature || ' RESTRICT';
  END LOOP;
END;
$retirement$;
COMMIT;
