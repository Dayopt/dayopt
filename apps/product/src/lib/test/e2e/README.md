# Product Playwright flow inventory

The existing Playwright suite is the browser test implementation. Use Node 24.
The public config extends the same desktop/mobile projects, selects only
`smoke.spec.ts`, requires an explicit running loopback server or pinned Product
Preview URL and starts no server/database itself:

```bash
E2E_PUBLIC_ORIGIN=http://127.0.0.1:3100 \
  pnpm --filter @dayopt/product exec playwright test --config playwright.public.config.ts
```

Public assertions prove locale-preserving signup/password reset navigation,
protected-route redirects and preservation of the post-login destination.
The `@mobile` touch case exercises the auth links in both locales. Protected
route checks run on desktop because that server contract is common to both
devices.

Authenticated checks keep their existing non-production service-role guards.
The verified Preview supervisor runs desktop/mobile critical-path specs,
with scoped user ownership, pinned SHA/deployment/DB identity, network fence,
private evidence and recovery. It does not execute every listed spec. Do not
pass an arbitrary remote service-role key to the local config as a substitute.
An environment without a DB cannot prove authentication, CRUD or provider
flows. `--list` proves collection only; skipped tests are not execution proof.

## Coverage and remaining real-flow prerequisites

| Product flow                                                                 | Existing test boundary                                                                                                | Real-flow prerequisite / gap                                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| English/Japanese signup and password-reset navigation                        | `smoke.spec.ts`, `auth.spec.ts`                                                                                       | Public render; submitting signup/reset additionally needs scoped identity and email sink/links        |
| Protected calendar/report/settings routes and all settings categories        | `smoke.spec.ts` checks login redirect and retained destination                                                        | Public render, no DB mutation                                                                         |
| Real login/logout and registration                                           | `auth.spec.ts`                                                                                                        | Verified synthetic identity; no real email delivery evidenced here                                    |
| Email confirmation, password recovery, MFA, recovery codes                   | Auth component/unit/integration tests                                                                                 | Browser delivery/TOTP/recovery cookie flow remains a real-environment gap                             |
| Future Plan, past Record, past explicit Plan                                 | `critical-path.spec.ts`, `plan-record-timeblock.spec.ts`                                                              | Verified non-production DB; critical path checks exact persisted hour and no silent opposite-kind row |
| Record → reload → review allocation                                          | `critical-path.spec.ts`, `mobile-critical-path.spec.ts`                                                               | Verified non-production DB and scoped fixture; both desktop and mobile already own the core journey   |
| Mobile long-press creation and Inspector drawer                              | `mobile-critical-path.spec.ts`, `plan-record-timeblock.spec.ts`                                                       | Verified non-production DB; touch-device project                                                      |
| Create activity/category, rename/archive, reorder                            | Activities/settings unit/component tests; critical path seeds its activity through admin API                          | Full browser activity/category editing remains unexecuted; admin seed is not UI CRUD proof            |
| Edit/move/resize/delete/copy and restore Plan/Record independently           | `derived-plan-record-flow.spec.ts`, `timeblock-drag-move.spec.ts`, `timeblock-conflict.spec.ts`, Inspector unit tests | Verified DB; browser undo/delete/export details still need a real run                                 |
| Inspector open/close/reopen, deep links                                      | `timeblock-inspector-toggle.spec.ts`, `deep-link.spec.ts`                                                             | Verified identity and fixture                                                                         |
| Search activity/note and open matching block                                 | `block-search.spec.ts`                                                                                                | Verified non-production identity and seeded Plan/Record                                               |
| Calendar dates/views, sidebar state, report tabs, back/reload                | `calendar-navigation.spec.ts`, `calendar-initial-load.spec.ts`                                                        | Authenticated verified target; existing navigation test owns the previously duplicated journey        |
| Legacy `/day`, `/week` and review query migration                            | `legacy-url-redirects.spec.ts`                                                                                        | Authenticated verified target                                                                         |
| Mobile settings list, category pages and back; account shortcut              | `mobile-navigation.spec.ts`                                                                                           | Verified synthetic identity; touch case checks all five named categories and return to list           |
| Display preferences, timezone/language/theme, account profile/password/email | Settings/auth unit/component tests                                                                                    | Authenticated persistence, re-login and email-change delivery remain unexecuted                       |
| Data export/import/backup                                                    | Settings component/service tests                                                                                      | Verified synthetic dataset and download/import run; no browser round-trip evidence here               |
| Account deletion                                                             | `account-deletion.spec.ts`                                                                                            | Owned synthetic identity and verified non-production DB; do not delete existing users                 |
| Billing checkout, return, subscription, portal/webhook                       | `billing.spec.ts` includes simulated responses; billing unit/integration contracts                                    | Stripe test mode and verified webhook/sink; simulated responses do not prove Stripe flows             |
| Google Calendar OAuth/sync/ghost/explicit Plan or Record conversion          | External-calendar unit/integration contracts                                                                          | Non-production OAuth account, configured provider and real sync/no-writeback evidence remain required |
| iCal feed, MCP/OAuth consent and API workflows                               | MCP/API/OAuth unit/integration/conformance suites                                                                     | Verified scoped client and actual external application flow; browser smoke is not conformance proof   |
| CSRF/cross-user boundary, accessibility, offline/PWA                         | `http-csrf.spec.ts`, `a11y.spec.ts`, `pwa/pwa.spec.ts`; RLS integration tests                                         | Correct built-app/browser/DB environment for each boundary                                            |

No assertion in this inventory claims that every flow has been executed.
Public local success, unit contracts and synthetic fixtures must remain
separate from actual Preview, DB, provider, billing and email evidence.
