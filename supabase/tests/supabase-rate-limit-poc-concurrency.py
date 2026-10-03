"""Concurrent correctness test. Refuses remote and non-POC databases."""

import concurrent.futures
import hashlib
import os
import subprocess
import uuid


host = os.environ.get("PGHOST", "")
database = os.environ.get("PGDATABASE", "")
if host not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("PGHOST must point to a local disposable PostgreSQL instance")
if not database.startswith("dayopt_rate_limit_poc_"):
    raise SystemExit("PGDATABASE must start with dayopt_rate_limit_poc_")

command = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]


def query(sql: str) -> str:
    result = subprocess.run(
        command,
        input=sql,
        text=True,
        capture_output=True,
        check=True,
        timeout=15,
        env=os.environ.copy(),
    )
    return result.stdout.strip()


def concurrently(sql: str, count: int = 24) -> list[str]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
        return list(executor.map(lambda _: query(sql), range(count)))


rate_hash = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
rate_sql = (
    "SELECT public.check_supabase_rate_limit_poc('poc-concurrency', "
    f"'{rate_hash}', 7, 3600) ->> 'allowed';"
)
rate_results = concurrently(rate_sql)
allowed = sum(value == "true" for value in rate_results)
denied = sum(value == "false" for value in rate_results)
if allowed != 7 or denied != len(rate_results) - 7:
    raise AssertionError(
        f"same-key race allowed={allowed}, denied={denied}; expected 7/{len(rate_results) - 7}"
    )

event_hash = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
tokens = [str(uuid.uuid4()) for _ in range(24)]
with concurrent.futures.ThreadPoolExecutor(max_workers=len(tokens)) as executor:
    futures = [
        executor.submit(
            query,
            f"SELECT public.claim_supabase_webhook_event_poc('{event_hash}', '{token}');",
        )
        for token in tokens
    ]
    claim_results = [future.result() for future in futures]

claimed = claim_results.count("claimed")
in_progress = claim_results.count("in_progress")
if claimed != 1 or in_progress != len(tokens) - 1:
    raise AssertionError(
        f"same-event race claimed={claimed}, in_progress={in_progress}; expected 1/{len(tokens) - 1}"
    )

print(f"PASS concurrent limiter: {allowed} allowed, {denied} denied")
print(f"PASS concurrent webhook claim: {claimed} owner, {in_progress} in progress")
