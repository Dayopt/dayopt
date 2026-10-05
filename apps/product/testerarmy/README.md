# Product TesterArmy tests

The public suite uses `e2e` and `@e2e-dev/web` without an AI provider. Desktop and
390 × 844 Chromium targets exercise the same English and Japanese auth flows.
They do not create users or send emails. Supply a pinned Product Preview URL,
or an explicitly running loopback server:

```bash
E2E_TELEMETRY_DISABLED=1 E2E_PRODUCT_ORIGIN=http://127.0.0.1:3100 \
  pnpm exec e2e run --config apps/product/e2e.config.ts
```

No server or database is started by the config, no `.env` file is loaded,
and traces/video are disabled. Ignored artifacts are under `apps/product/.e2e/`.
Preview protection must be resolved through the existing verified runner;
the config does not attach privileged bypass credentials to arbitrary requests.

`journey.e2e.ts` is an authored, **unexecuted against a real Preview** authenticated
suite. Normal public discovery excludes it. Run it only through the staged
supervisor after the harness is committed and the verified candidate is ready:

```bash
node scripts/runbook/testerarmy-preview-e2e.mjs --sha COMMITTED_SHA --deployment DEPLOYMENT_ID \
  --branch codex/BRANCH --pr PR_NUMBER --db-ref NONPRODUCTION_REF \
  --db-branch BRANCH_UUID --db-mode ephemeral
```

The CLI accepts the same identity arguments as the existing Preview runner
(`--sha`, `--deployment`, `--branch`, `--pr`, `--db-ref`, `--db-branch`, `--db-mode`).
The supervisor verifies readiness/SHA/DB, stages the clean committed harness in
its private directory, declares two scoped synthetic identities, and removes
raw SDK output after bounded process execution. Its recovery and sanitized
report gates remain required. Direct authenticated config execution outside
that private stage fails, even if service-role environment values are present.
The single authenticated browser target uses Asia/Tokyo. Each test signs in
through UI in a fresh context; mobile settings uses the second owned identity.

The one-hop transport permits only the pinned Preview, declared Supabase and
Cloudflare CAPTCHA origins. It injects bypass only on the pinned origin and
never follows redirects in Node. Response bodies are bounded to 16 MiB and
30 seconds, requests to 2 MiB. Cookie handling preserves separate Set-Cookie
values and rejects unsupported/duplicate attributes, broader domains,
invalid paths and lifetimes beyond 400 days. Explicit Expires requires a
response Date within one second; clock skew or high latency fails closed.
Synthetic native-vs-SDK tests prove supported cookie values/paths/flags,
session expiry, deletion, expiry rounding below one second, binary bytes,
status/headers and the actual three-test reporter schema. This proves the
adapter mechanics; it does not establish real authentication, provider or
billing success.

## Flow inventory and evidence boundary

| Flow                                                                | TesterArmy                            | Existing Playwright coverage                                                                      | Execution prerequisite                                                |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| English/Japanese login → signup                                     | Public navigation test                | `smoke.spec.ts`, `auth.spec.ts`                                                                   | Rendered application                                                  |
| Login → password reset → login                                      | Public navigation test, no email sent | `auth.spec.ts`                                                                                    | Rendered application                                                  |
| Signed-out calendar/report/settings and all five categories         | Public redirect tests                 | `smoke.spec.ts`                                                                                   | Rendered application                                                  |
| Actual signup, email confirmation, password recovery, login         | Journey includes synthetic login only | `auth.spec.ts`                                                                                    | Verified non-production DB, email sink/confirmation links             |
| Future Plan, past Record, past explicit Plan and reload persistence | Authored journey, unexecuted          | `critical-path.spec.ts`, `plan-record-timeblock.spec.ts`                                          | Verified supervisor and scoped identity                               |
| Record → review one-hour allocation                                 | Authored journey, unexecuted          | `critical-path.spec.ts`, `mobile-critical-path.spec.ts`                                           | Verified supervisor and scoped identity                               |
| Date/view/report navigation and browser-back                        | Authored journey, unexecuted          | `calendar-navigation.spec.ts`, `deep-link.spec.ts`, `legacy-url-redirects.spec.ts`                | Authenticated verified target                                         |
| Mobile settings category navigation                                 | Authored journey, unexecuted          | `mobile-navigation.spec.ts`                                                                       | Authenticated verified target                                         |
| Editing, drag/move, conflicts, Inspector reopen                     | No new TesterArmy execution           | `timeblock-drag-move.spec.ts`, `timeblock-conflict.spec.ts`, `timeblock-inspector-toggle.spec.ts` | Authenticated verified target                                         |
| Search and deep-linked Inspector                                    | No new TesterArmy execution           | `block-search.spec.ts`, `deep-link.spec.ts`                                                       | Authenticated verified target                                         |
| Derived Plan/Record operations                                      | No new TesterArmy execution           | `derived-plan-record-flow.spec.ts`                                                                | Authenticated verified target                                         |
| Billing checkout, subscription, portal and webhook                  | No new real-flow execution            | `billing.spec.ts` includes simulated responses                                                    | Stripe test mode and verified webhook/sink; mocks are not billing E2E |
| Google Calendar OAuth/sync/ghost/explicit conversion                | No new real-flow execution            | No complete browser flow evidenced here                                                           | Non-production OAuth account and provider credentials                 |
| Account deletion/data export/import/MFA                             | No new real-flow execution            | `account-deletion.spec.ts`; unit/integration tests cover other boundaries                         | Synthetic identity, verified DB and explicit destructive-flow scope   |
| CSRF, accessibility, PWA and offline                                | No new TesterArmy execution           | `http-csrf.spec.ts`, `a11y.spec.ts`, `pwa/pwa.spec.ts`                                            | Relevant application/browser environment                              |

Route access tests establish redirects and navigation, not authenticated CRUD,
provider delivery, billing, mobile gestures, or all product flows. A collected
test and an existing spec are not execution evidence.
