---
status: current
last_verified: 2026-10-03
code: apps/product/src/features/external-calendar/server/sync-rate-limit.ts
---

# Supabase atomic rate-limit and webhook-claim POC

## Purpose

Compare a small Supabase Postgres implementation with the existing Upstash-backed limiter before moving operational traffic. The additive migration creates two private tables and service-role-only RPCs. The experiment previously had opt-in Calendar and webhook adapters for fixed Integration; Phase A of #3022 retires these adapters. Historical remote exercises are recorded below.

- A two-bucket weighted sliding window, updated under a transaction-scoped advisory lock per hashed scope and identity.
- A five-minute webhook processing lease and 35-day processed marker, with token-owned completion and release.
- A bounded batch cleanup RPC for expired state.

The POC accepts only a lowercase 64-character SHA-256/HMAC digest for identities and event IDs. Hashing remains in the server application. It stores no raw user ID, IP, provider event ID, or payload. Only `service_role` can call the RPCs or access the unexposed `rate_limit_poc` schema; `anon` and `authenticated` have neither schema access nor table/function privileges. RPCs run as their caller (`SECURITY INVOKER`) and therefore do not elevate privileges.

This POC only evaluates the Calendar manual-sync limiter and webhook duplicate claims. It does not replace general tRPC/MCP rate limits and does not satisfy Issue [#2979](https://github.com/Dayopt/dayopt/issues/2979), whose current acceptance path requires the dedicated Redis connection and real MCP OAuth/tool checks. Do not use this experiment to unblock that issue.

## Semantics and limits

- Rate-limit checks fail closed in the Supabase adapter: transport errors, PostgREST errors, and unexpected replies all become an unavailable error. Calendar sync maps these to its existing unavailable response and does not proceed with the protected operation.
- The rate algorithm mirrors the checked-in `@upstash/ratelimit` 2.2.0 script: floor the weighted previous bucket, check before increment, and leave denied requests out of the counter. Reset metadata and transaction/timeout behavior still differ and need comparison before rollout.
- The current identifier hash uses the Upstash REST token as an HMAC secret when configured. Before any cutover, replace that with an independent, stable HMAC key shared by both backends or preserve the old key through a controlled overlap. Otherwise a backend change resets all hashed rate-limit identities.
- Webhook claims are atomic per digest. Only the current token can complete or release. Expired leases can be claimed again; an expired owner cannot complete after takeover.
- A lease cannot make an external side effect exactly once. A crash after the webhook handler changes another system but before it records completion can still cause a retry. The current handler's suppression write is itself idempotent; preserve that property and keep terminal markers before observable side effects.
- Existing processed webhook markers live in Upstash for 35 days. During cutover, retain a compatible old-marker read/claim path until those markers expire and old Vercel deployments can no longer process retries. Do not remove Upstash at the same time as switching new claims to the DB.
- Expired rows need a scheduled caller for `prune_supabase_rate_limit_poc`. The POC does not schedule cleanup yet.
- PostgreSQL statement and lock timeouts are 2 seconds and 1.5 seconds. Size them against real Integration latency and ensure caller timeout is not shorter than the server cutoff.

## Correctness checks

The standalone fixture is retained at `supabase/poc/rate-limit-idempotency.sql`. Phase A also retains the byte-identical applied migration at its original active path to preserve the existing Integration history. Hold Production candidates until Phase B replaces the active experimental SQL with the audited retirement marker and forward retirement. Apply the standalone fixture only to an explicitly selected disposable POC database, then run:

```sh
psql "$POC_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/poc/rate-limit-idempotency.sql
psql "$POC_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/supabase-rate-limit-idempotency-poc.sql
```

The SQL test wraps all state changes in a transaction and rolls it back. It covers limit boundaries, stale buckets, claim ownership, duplicate deliveries, failed-attempt release, expired lease takeover, processed-marker expiry, cleanup, and grants.

For real cross-session concurrency, run the pgbench script against a disposable database with only the migration applied:

```sh
pgbench -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -n -M simple -f supabase/tests/supabase-rate-limit-poc-bench.sql -c 1 -j 1 -T 60 -P 10 -r
pgbench -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -n -M simple -f supabase/tests/supabase-rate-limit-poc-bench.sql -c 10 -j 10 -T 60 -P 10 -r
pgbench -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -n -M simple -f supabase/tests/supabase-rate-limit-poc-bench.sql -c 50 -j 10 -T 60 -P 10 -r
```

For exact concurrent correctness, configure libpq connection variables for a local disposable database named `dayopt_rate_limit_poc_*` (use `.pgpass` or the normal local trust setup for credentials) and run:

```sh
python3 supabase/tests/supabase-rate-limit-poc-concurrency.py
```

The script refuses non-local hosts and databases without the POC prefix. It launches 24 independent PostgreSQL sessions and requires exactly 7 permits and exactly 1 owner for the same synthetic webhook event. Use `.pgpass` for the password. Repeat with `supabase-rate-limit-poc-bench-distinct.sql` to separate single-key lock contention from aggregate database throughput. Do not run these writes against Production or the shared Calendar Integration database.

Record throughput and p50/p95/p99 latency for both workloads. Also capture table tuple updates/inserts/deletes, dead tuples, database CPU, and connection pressure before and after. `pgbench` measures the SQL/database lower bound; the final comparison must include the real app-to-Supabase RPC round trip and the current app-to-Upstash round trip.

## Local PostgreSQL results (2026-10-03)

PostgreSQL 17.11 ran locally on loopback with 128 MB `shared_buffers`. Each `pgbench` run lasted 5 seconds and called the RPC in simple query mode. Runs used 1, 8, and 24 clients; 8/24 clients used 4 worker threads. These are local SQL-only lower bounds: they do not include PostgREST, Supabase pooling, remote network latency, or the Upstash REST request.

| Workload         | Clients |    TPS |      p50 |      p95 |      p99 |  Average |
| ---------------- | ------: | -----: | -------: | -------: | -------: | -------: |
| One hot digest   |       1 | 16,982 | 0.056 ms | 0.082 ms | 0.089 ms | 0.058 ms |
| One hot digest   |       8 | 28,495 | 0.274 ms | 0.311 ms | 0.351 ms | 0.280 ms |
| One hot digest   |      24 | 27,638 | 0.853 ms | 0.937 ms | 0.992 ms | 0.868 ms |
| Distinct digests |       1 | 16,063 | 0.057 ms | 0.085 ms | 0.095 ms | 0.062 ms |
| Distinct digests |       8 | 55,063 | 0.138 ms | 0.220 ms | 0.258 ms | 0.144 ms |
| Distinct digests |      24 | 74,119 | 0.270 ms | 0.502 ms | 0.863 ms | 0.300 ms |

The test database also reported 25 estimated live rate-limit rows, 0 estimated dead rows, 242,728 row updates, and 360 KB total relation size after the runs. The tuple counters include the correctness/concurrency fixtures; these figures are not a sustained-growth or hosted-Supabase result.

Correctness checks passed on this PostgreSQL instance: the transactional SQL/security suite; 24-session same-key races (exactly 7 allowed, 17 denied); 24-session webhook races (one claim owner, 23 in progress); and a forced advisory-lock conflict that failed after 1.518 seconds with PostgreSQL's configured lock-timeout error. The TypeScript adapter's 5 unit tests, Product typecheck, ESLint, and Prettier checks also passed.

## Decision gates

1. Correctness test passes, including concurrent same-key requests where exactly the configured count is allowed.
2. Database failures stop the protected action, and webhook failure returns a retryable error rather than acknowledging the event.
3. Expired rows are deleted in bounded batches and table/dead-tuple growth remains controlled under sustained synthetic traffic.
4. Compare end-to-end p95/p99 and DB load with the current Upstash path. Pick explicit acceptable limits before moving any Integration traffic.
5. The Calendar adapter was opted into the fixed Integration deployment during the POC. Phase A of #3022 retires the application runtime adapter; do not enable the old switches again. A future replacement for Upstash needs a new decision and isolated latency, load, and rollback evidence.

## Runtime retirement and migration sequence (#3022)

Phase A retires the Calendar and Resend POC runtime adapters. Calendar keeps the existing Upstash limiter; Product webhooks keep the existing Upstash claim/processed markers. Legacy POC environment switches cannot select Supabase RPCs anymore. The experiment and its historical evidence remain in Git and this document.

The applied migration `20261003073817_supabase_rate_limit_idempotency_poc.sql` remains byte-identical in the active migration directory during Phase A. Its removal was rejected by the upgrade check. Keeping it establishes the real existing Integration schema for the upgrade rehearsal. **This intermediate staging tree is not a Production release candidate.** Candidate promotion must hold until Phase B is complete.

Phase B is a separate database retirement PR, after the fixed Integration deployment is proven to serve Phase A and legacy workers are drained. It preserves the original SQL in an immutable archive and the applied version in migration history. A documented retirement marker handles fresh databases without replaying the experimental SQL. A forward migration removes only the retired RPC interfaces and preserves the POC state for recovery. It must rehearse both the original applied-schema path and the fresh Production path and compare their application contracts. Unrelated migration edits/removals remain errors.

No linked/remote DB reset, migration-history repair, POC data deletion, or Production migration was performed. Applying Phase B requires the deployment evidence, backup/recovery, dry-run, independent review and explicit external-operation authority. Upstash stays in place throughout the transition.

## Hosted Integration state (2026-10-03)

- PR #3012 merged only into `integration` as `2d50351d604d20f1c5649a4cad7d8f428220cb25`. PR #3013 then merged only into `integration` as `dc79762f1980b81fde2e2b60b9e3f2f1497d8b7b`. The fixed Integration URL now resolves to READY deployment `dpl_9PZzwv4d3XDV8jDHqhG47S5kJeNq` at that SHA. `/api/health` returned HTTP 200 with `healthy`, and `/api/health/version` reported the same SHA and Supabase ref `tilwaprottpyhlfoggbb`.
- Supabase has one persistent nonproduction Integration branch, ref `tilwaprottpyhlfoggbb`, with `with_data=false`; the migration was applied there directly, not through a temporary branch. The separate Supabase Preview branch generated by PR #3013 CI is not used for the fixed Integration browser test. Before the POC schema was applied, Integration migration history had 297 entries and ended at `20260930014002_prevent_duplicate_external_calendar_conversion`. A read-only aggregate query returned zero duplicate groups and zero excess active external-event references in both Plans and Records.
- The POC migration was applied only to that existing Integration branch. Supabase recorded it as version `20261003073817`, name `supabase_rate_limit_idempotency_poc`; the repository migration filename now matches that version. The migration adds isolated POC tables and RPCs. A post-migration contract query confirmed both tables exist, RLS is enabled, `anon` and `authenticated` have no private-schema usage or RPC execution, and `service_role` has the needed access. During PR #3013, the Calendar switch was later stored only for the Vercel Preview `integration` branch; the webhook switch remains unset. Production configuration and data were not changed.
- Hosted SQL-function exercise on Integration: 24 concurrent calls for one synthetic rate-limit identity left exactly 7 permitted increments at a budget of 7; a follow-up call was denied with `remaining=0`. Eight concurrent calls for one synthetic webhook event returned exactly one `claimed` and seven `in_progress`. The webhook state-machine exercise verified completion and duplicate suppression, release/retry, expired processed-event reclaim, expired lease takeover, stale-owner completion rejection, and current-owner completion. The bounded prune RPC deleted the 2 synthetic rate rows and 4 synthetic webhook rows; a follow-up query found zero remaining rows. All identifiers were synthetic. The 8-call batch took 13.7 seconds through the Supabase MCP SQL tool; this measures the tool round trip, not Product/PostgREST request latency.
- Supabase Security Advisor reports only expected RLS-enabled/no-policy INFO findings for the two private POC tables; the seven existing SECURITY DEFINER WARN findings are unrelated and unchanged. A direct Production query found no `rate_limit_poc` schema, and Production migration history has no POC migration.
- Production ref `yvglwblxrnrenfifsnje` still reports 304 migrations, ending at `20261001083000_allow_billing_reconciliation_heartbeat`.
- Git main is `47f5d7c` and Integration is `dc79762f`. Their histories remain divergent from merge base `4d74a6ec`: main has 308 commits not in Integration, and Integration has 84 commits not in main. Keep follow-up work based on Integration; do not merge this POC into Production as part of this experiment.
- The earlier manual-sync failure remains unidentified: the previous Integration deployment's runtime logs were outside retention, and a missing Upstash limiter alone did not explain the failure. The current deployment's retained eight-hour Vercel logs show auth pages and health/version checks but no Calendar sync request, so the deployed Product route has not yet exercised the Supabase-backed limiter.
- At 2026-10-03 10:21 UTC, the two POC tables each occupied 48 kB and had zero estimated live tuples; estimated dead tuples were 16 and 15. This is a small post-fixture snapshot, not sustained-load or hosted latency evidence.
- No Integration Resend sink was configured for this run, so the webhook-claim route still has no live Resend webhook test; its hosted coverage is synthetic SQL only.

## Current execution status

- PR #3013 merged only into `integration` as `dc79762f1980b81fde2e2b60b9e3f2f1497d8b7b`. The fixed Integration deployment `dpl_9PZzwv4d3XDV8jDHqhG47S5kJeNq` is READY, and health/version checks confirm it runs against Supabase ref `tilwaprottpyhlfoggbb`. The Calendar flag is configured only for Vercel Preview branch `integration`; the webhook flag remains unset.
- Local PostgreSQL 17.11 transactional SQL/security coverage, 24-session same-key correctness races, lock-timeout failure check, and local `pgbench` measurements passed in the disposable POC database; these are SQL lower bounds, not hosted Supabase measurements.
- Focused Product tests passed for the Supabase adapter, Calendar limiter, and Resend webhook route. Product and Web unit suites passed. The full repository `pnpm check` reached the script suite after passing typecheck, lint, static/dead-code, formatting, docs, license, localization, Product, and Web checks, but exited nonzero on seven failures in unchanged script tests (`check-glossary.test.ts` and `session-start.test.ts`). The focused POC tests and `docs:check` / `architecture:check` pass on the Integration-based worktree.
- The POC migration is present on Integration and the Calendar adapter is deployed behind the Integration-only selector. No user data was changed by the migration. Production configuration and data remain untouched.
- Real Integration webhook delivery still needs a configured nonproduction Resend sink. The Calendar OAuth/sync and ghost-conversion path still needs a user-driven browser pass; the dedicated Google test account must complete OAuth before we can run manual sync against this deployment.
- Next gate: finish OAuth with the dedicated Google test account, run manual sync, confirm imported events remain ghosts until explicitly converted to Plan or Record, and verify Dayopt does not write back to Google. Capture the Product-to-Supabase request latency and database impact; one manual sync is a smoke sample, not p95/p99 or sustained-load evidence. Keep the Resend switch unset until an isolated nonproduction sink is available. Production migration and Upstash removal remain later decisions.
