"""Isolated DB only: two sessions sharing one operation must create one resource.
Run with DIGEST_TEST_DATABASE_URL; discard the dedicated DB after this fixture.
"""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlparse

url = os.environ["DIGEST_TEST_DATABASE_URL"]
parsed = urlparse(url)
if parsed.hostname not in ("127.0.0.1", "localhost") or not parsed.path.startswith("/dayopt_mcp_digest_"):
    raise SystemExit("Use a local isolated dayopt_mcp_digest_* database")
command = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", url]

def query(sql):
    return subprocess.run(command, input=sql, text=True, capture_output=True, check=True, timeout=15)

# Reuse the exact authorization fixture from the SQL suite, committed only in this DB.
source = Path(__file__).with_name("mcp-create-digest.sql").read_text()
setup = source[:source.index("  FOREACH tool")]
setup += "RAISE NOTICE 'FIXTURE % % %', app_user_id, connection_id, access_token_id; END; $test$; COMMIT;"
seed = query(setup)
match = re.search(r"FIXTURE ([a-f0-9-]{36}) ([a-f0-9-]{36}) ([a-f0-9-]{36})", seed.stderr)
if not match:
    raise RuntimeError("Fixture identifiers missing")
user, connection, token = match.groups()

for kind in ("plan", "record"):
    operation = str(uuid.uuid4())
    link = "NULL," if kind == "record" else ""
    call = (
        f"public.apply_mcp_{kind}_create_v1('{connection}','{token}','{operation}',"
        f"'concurrent digest',NULL,{link}'2025-01-01 09:00Z','2025-01-01 10:00Z')"
    )
    auth = "SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"
    # READY is emitted only after the first apply has acquired its operation lock.
    first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
    try:
        first.stdin.write(f"BEGIN; {auth} SELECT row_to_json(r) FROM {call} r; SELECT 'READY'; SELECT pg_sleep(1); COMMIT;")
        first.stdin.close()
        lines = []
        while True:
            line = first.stdout.readline()
            if not line:
                raise RuntimeError("First writer exited before READY: " + first.stderr.read())
            if line.strip() == "READY":
                break
            lines.append(line)
        second = query(f"BEGIN; {auth} SELECT row_to_json(r) FROM {call} r; COMMIT;")
        first.wait(timeout=10)
        if first.returncode:
            raise RuntimeError(first.stderr.read())
        left = [json.loads(x) for x in lines if '"replayed"' in x][0]
        right = [json.loads(x) for x in second.stdout.splitlines() if '"replayed"' in x][0]
        if left["replayed"] or not right["replayed"] or left["resource_id"] != right["resource_id"]:
            raise AssertionError("Concurrent operation did not replay one result")
        count = query(f"SELECT count(*) FROM public.{kind}s WHERE user_id='{user}' AND title='concurrent digest';").stdout.strip()
        if count != "1":
            raise AssertionError("Duplicate resource created")
        print(f"PASS {kind}: concurrent calls returned one resource and one replay")
    finally:
        if first.poll() is None:
            first.kill()
            first.wait()
