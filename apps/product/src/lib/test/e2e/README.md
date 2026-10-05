# Integration trusted Playwright scope

This rollout targets the existing `integration` branch. The original nine desktop
and three mobile cases were reviewed in PR #3021; this follow-up expands that same
trusted harness to sixteen desktop and four mobile declarations. No schema
change or POC retirement PR is required. Existing migration history is intact.

| File                           | Project         | Count | Browser acceptance                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical-path.spec.ts`        | `chromium`      |    16 | Plan/Record creation and persistence; week/month/year/empty Report allocation; profile/time format/theme/timezone/language persistence; actual JSON/date-filtered CSV download; activity/category CRUD; Inspector note edit and search reopen; same-ID Plan drag with unchanged Record readback; concurrent writer conflict; template save/rename/apply/overlap rejection/delete |
| `mobile-critical-path.spec.ts` | `Mobile Chrome` |     4 | Touch Plan/Record creation and reload; Report header navigation/allocation; settings overview → display preference persistence → overview → Calendar                                                                                                                                                                                                                             |

The reporter and publisher require all 20 declarations to pass on their first
attempt, with unique positive safe source lines under these exact file/project
pairs. Old seven- and twelve-case reports, omissions, duplicates and incorrect
pairings fail. For failed declarations, public evidence may include at most 40
failed-step rows, each limited to category, allowlisted spec file, positive
source line and capped duration. Titles, passwords, error messages, headers,
cookies, screenshots and bodies remain excluded. The intent's workflow SHA
identifies the trusted source; the request binds the candidate SHA/deployment
and nonproduction DB.

The suites retain exactly two synthetic identities. Fixture/identity contracts,
durable ownership journal, cleanup/readback, network fence, private output,
process shutdown, workers=1 and retries=0 are unchanged. New DB reads are scoped
to the owned user and known IDs. The competing writer updates only that user's
Plan through the existing RPC. Templates and blocks already cascade with the
owned Auth identity; successful template deletion also confirms applied Plans
remain. No additional account is seeded.

Before execution, the existing verified runner checks the live eligible candidate
PR, pinned deployment SHA, automation access, nonproduction DB ref, fixture key,
health and exact candidate migration versions. A mismatch fails closed. Never
relax readiness or alter applied migration history to run. Candidate code cannot
replace privileged trusted-checkout imports.

Auth confirmation/recovery/password-change/MFA need a dedicated reviewed provider
lane with an owned account, confirmed test mail sink and authenticator/recovery
code handling. OAuth Calendar needs approved synthetic provider consent and
separate sync/ghost/conversion/no-writeback evidence. Billing needs Stripe test
mode, test checkout/webhook/portal evidence and scoped provider cleanup. Account
deletion needs a separate explicitly approved destructive test lane. These flows
are outside this pinned-origin/Supabase/CAPTCHA network fence and are not proved
by this suite. Import has no current Product UI. Template drag/edit is not wired
in the current sidebar; this suite exercises save, rename, click apply and delete.
These boundaries do not claim all flows passed.

Local unit checks, typechecking and Playwright collection prove contracts and
collection only. A verified cloud run must pass all 20 cases on their first
attempt, confirm cleanup and preserve post-readiness identity. Existing
five-minute Playwright / seven-minute supervisor limits are unchanged because
no expanded-run duration has been measured. A timeout is a failed run;
collection evidence cannot replace it.
