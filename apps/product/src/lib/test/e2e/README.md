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

| Product flow                                                                 | Existing test boundary                                                                                                | Real-flow prerequisite / gap                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| English/Japanese signup and password-reset navigation                        | `smoke.spec.ts`, `auth.spec.ts`                                                                                       | Public render; submitting signup/reset additionally needs scoped identity and email sink/links                                                |
| Protected calendar/report/settings routes and all settings categories        | `smoke.spec.ts` checks login redirect and retained destination                                                        | Public render, no DB mutation                                                                                                                 |
| Real login/logout and registration                                           | `auth.spec.ts`                                                                                                        | Verified synthetic identity; no real email delivery evidenced here                                                                            |
| Email confirmation, password recovery, MFA, recovery codes                   | Auth component/unit/integration tests                                                                                 | Browser delivery/TOTP/recovery cookie flow remains a real-environment gap                                                                     |
| Future Plan, past Record, past explicit Plan                                 | `critical-path.spec.ts`, `plan-record-timeblock.spec.ts`                                                              | Verified non-production DB; critical path checks exact persisted hour and no silent opposite-kind row                                         |
| Record → reload → review allocation                                          | `critical-path.spec.ts`, `mobile-critical-path.spec.ts`                                                               | Verified non-production DB and scoped fixture; both desktop and mobile already own the core journey                                           |
| Mobile long-press creation and Inspector drawer                              | `mobile-critical-path.spec.ts`, `plan-record-timeblock.spec.ts`                                                       | Verified non-production DB; touch-device project                                                                                              |
| Create activity/category, rename/archive, reorder                            | `critical-path.spec.ts` authors category/activity UI CRUD and archive/restore; activities/settings unit tests         | Authored browser category/activity editing remains unexecuted; admin seed alone is not UI CRUD proof                                          |
| Edit/move/resize/delete/copy and restore Plan/Record independently           | `derived-plan-record-flow.spec.ts`, `timeblock-drag-move.spec.ts`, `timeblock-conflict.spec.ts`, Inspector unit tests | Verified DB; browser undo/delete/export details still need a real run                                                                         |
| Inspector open/close/reopen, deep links                                      | `timeblock-inspector-toggle.spec.ts`, `deep-link.spec.ts`                                                             | Verified identity and fixture                                                                                                                 |
| Search activity/note and open matching block                                 | `block-search.spec.ts`                                                                                                | Verified non-production identity and seeded Plan/Record                                                                                       |
| Calendar dates/views, sidebar state, report tabs, back/reload                | `calendar-navigation.spec.ts`, `calendar-initial-load.spec.ts`                                                        | Authenticated verified target; existing navigation test owns the previously duplicated journey                                                |
| Legacy `/day`, `/week` and review query migration                            | `legacy-url-redirects.spec.ts`                                                                                        | Authenticated verified target                                                                                                                 |
| Mobile settings list, category pages and back; account shortcut              | `mobile-navigation.spec.ts`                                                                                           | Verified synthetic identity; touch case checks all five named categories and return to list                                                   |
| Display preferences, timezone/language/theme, account profile/password/email | `critical-path.spec.ts` authors profile + time-format UI/DB persistence; settings/auth unit/component tests           | Authored profile/time-format/timezone/language/theme persistence remains unexecuted; password re-login and email delivery still need coverage |
| Data export/import/backup                                                    | `critical-path.spec.ts` authors actual JSON + date-filtered CSV downloads; settings component/service tests           | Authored download checks compare owned DB IDs and exclude out-of-range Plan; real run pending. No import UI exists in current DataSettings    |
| Account deletion                                                             | `account-deletion.spec.ts`                                                                                            | Owned synthetic identity and verified non-production DB; do not delete existing users                                                         |
| Billing checkout, return, subscription, portal/webhook                       | `billing.spec.ts` includes simulated responses; billing unit/integration contracts                                    | Stripe test mode and verified webhook/sink; simulated responses do not prove Stripe flows                                                     |
| Google Calendar OAuth/sync/ghost/explicit Plan or Record conversion          | External-calendar unit/integration contracts                                                                          | Non-production OAuth account, configured provider and real sync/no-writeback evidence remain required                                         |
| iCal feed, MCP/OAuth consent and API workflows                               | MCP/API/OAuth unit/integration/conformance suites                                                                     | Verified scoped client and actual external application flow; browser smoke is not conformance proof                                           |
| CSRF/cross-user boundary, accessibility, offline/PWA                         | `http-csrf.spec.ts`, `a11y.spec.ts`, `pwa/pwa.spec.ts`; RLS integration tests                                         | Correct built-app/browser/DB environment for each boundary                                                                                    |

Cloud success requires the reviewed declaration matrix: nine desktop checks from `critical-path.spec.ts` and three mobile checks from `mobile-critical-path.spec.ts`, with no missing or duplicate declarations. A successful old seven-check run cannot establish this expanded coverage. The public Cloud artifact retains the intent's trusted workflow SHA; that harness must contain these declarations before execution. This matrix covers the two guarded core specs, not every Product or provider flow. Changes to the declarations require updating the reviewed matrix and its regression checks together.

The desktop critical path now declares nine tests: its existing four core checks plus profile/display persistence, JSON/CSV downloads, activity rename/archive/restore preservation, theme/timezone/language persistence and category/activity create, rename, move and delete. These added tests reuse the same owned scoped identity and require the reviewed trusted harness to include their exact declarations before Preview execution. Category color/icon and archive/restore assertions are also authored, including the invariant that category archival leaves member activities active; activity order selection is local presentation, not a persisted manual reorder contract. MFA enrollment/recovery needs a scoped authenticator and recovery-code fixture; email recovery needs a sink, and neither is proven by rendering forms.

No assertion in this inventory claims that every flow has been executed.
Public local success, unit contracts and synthetic fixtures must remain
separate from actual Preview, DB, provider, billing and email evidence.

## Authentication acceptance boundaries

The separate `auth-lifecycle.manual.ts` case changes only its owned synthetic account's
password. It requires `E2E_AUTH_LIFECYCLE_APPROVED=1`,
`E2E_AUTH_NOTIFICATION_SINK_READY=1`, an explicit running loopback app origin
and a loopback Supabase target; unmet
prerequisites fail before account creation. It is outside the mandatory Preview
critical-path selection and cannot execute against a remote target. It checks server rejection of an incorrect current password, then the
real update, logout, rejection of the old credential, success with the new one,
and a protected-route redirect after final logout. It requires GoTrue's
`security_update_password_require_current_password` policy, a nonproduction
password-change notification sink, and reviewed network access to HIBP
`https://api.pwnedpasswords.com/range/<five-hex-prefix>`. The current Preview
network fence excludes HIBP, so this separate local case is authored and cannot be presented as
validated by the existing trusted harness. Do not bypass the fence or substitute
an accepted password-update mock. Cookie/session revocation on another device
remains a distinct acceptance gap.

Email change needs secure confirmation enabled, a sink that exposes links for
both the old and new scoped addresses, and approved callback origins. Password
recovery needs the real sink-delivered recovery link, recovery-session callback,
new password entry and rejection of the former credential. Signup verification
needs the real confirmation link and resulting confirmed session. Form rendering
or a "sent" success message proves none of these delivery/confirmation paths.

The current `auth.spec.ts` deliberately leaves TOTP/recovery-code login out of
browser E2E under decision #1873. Keep that boundary until a new product decision:
real enrollment, factor verification, AAL2 cookie transfer, one-use recovery-code
consumption and regeneration/disable remain acceptance checks requiring a scoped
authenticator/recovery fixture and clock alignment. Existing unit/integration
coverage is not real-browser acceptance evidence. OAuth consent with an external
client and offline/PWA recovery also remain separate unexecuted boundaries.

The manual filename deliberately stays outside the default Playwright discovery,
so the normal suite neither runs nor reports it as skipped. Its dedicated config
extends the existing desktop project, starts no services and accepts loopback
only. After the prerequisites are independently confirmed, use:

```bash
E2E_AUTH_LIFECYCLE_ORIGIN=http://127.0.0.1:3100 \
E2E_AUTH_LIFECYCLE_APPROVED=1 E2E_AUTH_NOTIFICATION_SINK_READY=1 \
  pnpm --filter @dayopt/product exec playwright test --config playwright.auth-lifecycle.config.ts
```

This command additionally needs the approved local Supabase URL/key through the
existing secret boundary. Do not use it as a remote Preview harness or proof of
email delivery/HIBP operation; the currently authored assertions verify credential
state and session navigation only.
