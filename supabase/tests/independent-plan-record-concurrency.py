"""Run against a synthetic dayopt_derived_* DB only; never the shared postgres DB."""
import concurrent.futures
import subprocess
import sys
import uuid

name = sys.argv[1]
if not name.startswith('dayopt_derived_') or not name.replace('_', '').isalnum():
    raise SystemExit('Use an isolated dayopt_derived_* database')


def sql(statement):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_dayopt', 'psql', '-X',
                             '-U', 'supabase_admin', '-d', name, '-v', 'ON_ERROR_STOP=1', '-At'],
                            input=statement, text=True, capture_output=True, check=True)
    return result.stdout.strip().splitlines()


user_id = str(uuid.uuid4())
try:
    sql(f"INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('{user_id}','{user_id}@example.invalid','{{}}');"
        f"INSERT INTO public.plans(user_id,title,start_at,end_at) VALUES ('{user_id}','race','2025-02-01 09:00Z','2025-02-01 10:00Z');")
    statement = ("BEGIN; SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}';"
                 f"SELECT count(*) FROM public.confirm_day_plans_command_v1('{user_id}','2025-02-01 00:00Z','2025-02-02 00:00Z'); COMMIT;")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: sql(statement), range(2)))
    counts = sorted(int(line) for result in results for line in result if line.isdigit())
    assert counts == [0, 1], counts
    rows = sql(f"SELECT count(*) FROM public.records WHERE user_id='{user_id}';")
    assert rows == ['1'], rows
    print('concurrent batches: counts [0, 1], one persisted record')
# The disposable DB is removed by its owner; account deletion gates remain intact.
finally:
    sql(f"DELETE FROM public.records WHERE user_id='{user_id}'; DELETE FROM public.plans WHERE user_id='{user_id}';")
