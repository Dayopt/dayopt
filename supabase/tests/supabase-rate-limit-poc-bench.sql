-- pgbench script; run only against a disposable POC database.
-- All concurrent workers contend on one synthetic digest to measure the lock hot spot.
SELECT public.check_supabase_rate_limit_poc(
  'poc-benchmark',
  '0000000000000000000000000000000000000000000000000000000000000001',
  10000,
  60
);
