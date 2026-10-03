-- pgbench script; run only against a disposable POC database.
-- Each pgbench client gets a distinct synthetic digest.
SELECT public.check_supabase_rate_limit_poc(
  'poc-benchmark',
  lpad(to_hex(:client_id), 64, '0'),
  10000,
  60
);
