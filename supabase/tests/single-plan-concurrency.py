"""Exercise two real DB transactions against a disposable *_test database only."""
import argparse
import concurrent.futures
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
parser.add_argument('--database', required=True)
args = parser.parse_args()
if not args.database.endswith('_test'):
    raise SystemExit('A disposable *_test database is required')
user_id = str(uuid.uuid4())

def sql(statement):
    return subprocess.run(['docker', 'exec', '-i', args.container, 'psql', '-U', 'supabase_admin', '-d', args.database, '-At', '-v', 'ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True, check=True).stdout

try:
    sql(f"INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('{user_id}','{user_id}@example.invalid','{{}}');")
    def start(offset):
        return sql(f"""BEGIN;
        UPDATE public.profiles SET app_trial_started_at='2026-09-08T00:00:00Z'::timestamptz + interval '{offset} seconds',
          app_trial_ends_at='2026-09-08T00:00:00Z'::timestamptz + interval '1080 hours {offset} seconds'
          WHERE id='{user_id}' AND subscription_status IN ('free','canceled')
          AND app_trial_started_at IS NULL AND app_trial_consumed_at IS NULL;
        SELECT pg_sleep(0.2); COMMIT;""")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(start, [0, 10]))
    assert sum('UPDATE 1' in result for result in results) == 1, results
    assert sum('UPDATE 0' in result for result in results) == 1, results
    assert sql(f"SELECT app_trial_ends_at-app_trial_started_at=interval '1080 hours' FROM public.profiles WHERE id='{user_id}';").strip() == 't'
    print('PASS: two concurrent starts produced one unchanged 45-day trial')
finally:
    sql(f"BEGIN; ALTER TABLE auth.users DISABLE TRIGGER USER; DELETE FROM auth.users WHERE id='{user_id}' AND email='{user_id}@example.invalid'; ALTER TABLE auth.users ENABLE TRIGGER USER; COMMIT;")
