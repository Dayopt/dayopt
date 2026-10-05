# Integration trusted Playwright scope

This rollout depends on PR #3023 Phase A and starts from its Phase A
`1d953467cc608fb9210303e2cc62ce07226aa10e` source. It carries only the
reviewed Product critical-path coverage and sanitized report validation from
PR #3021 (`4190be61d2077d51618acb57df9f0730ecc848a4`). It does not run candidate
checkout scripts or imports with privileged credentials.

The trusted Preview config selects exactly these declarations:

| File                           | Project         | Count | Browser acceptance                                                                                                                                                                                                                                        |
| ------------------------------ | --------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical-path.spec.ts`        | `chromium`      |     9 | Independent Plan/Record creation and persistence, Report allocation, profile/time format persistence, actual JSON/date-filtered CSV download, activity rename/archive/restore, theme/timezone/language persistence, category/activity CRUD and membership |
| `mobile-critical-path.spec.ts` | `Mobile Chrome` |     3 | Touch Plan/Record creation, reload persistence and Report navigation/allocation                                                                                                                                                                           |

The reporter and publisher require all 12 to pass on their first attempt, with
unique positive safe source lines under the exact file/project pairs. An old
seven-case report, omissions, duplicate declarations or incorrect pairings fail.
Titles, passwords, errors, headers, cookies and response bodies remain excluded
from public evidence. The durable intent's workflow SHA identifies the trusted
source; the request binds the candidate SHA/deployment and nonproduction DB.

The desktop and mobile suites retain two separately planned synthetic identities.
The exact fixture/identity contract, run ownership journal, cleanup/readback,
private output, process group shutdown, retries=0, workers=1 and network fence
are unchanged. Browser requests remain limited to the pinned Product Preview,
selected Supabase and CAPTCHA providers. No auth-provider, notification or billing
workflow is added to this scope.

Before real execution, verify the live OPEN/non-Draft candidate PR and successful
pinned deployment, nonproduction branch/ref and fixture key, automation access,
health and the candidate's exact migration version set. Phase A retains the
applied POC version `20261003073817`; a main-based candidate without that version
does not match this DB. Do not skip readiness or edit/drop migration history to
make it pass. The owning DB lane must reconcile the accepted schema/history first.

Use the existing verified Preview runner after these prerequisites and the
trusted Integration rollout are confirmed. This checkout preserves the current
305 migration files, including the original POC SQL. Phase A remains an
intermediate Staging state and is not a Production release candidate. Phase B
retirement is a separate reviewed dependency.

Local unit success, typechecking and `playwright --list` establish code contracts
and collection only. These added browser cases have not yet been executed against
a verified cloud DB/Preview. Playwright has a five-minute global limit and the
supervisor seven minutes; the CRUD case's 120-second timeout does not extend them.
Measure actual duration during the first approved run and report timeout failures
rather than claiming complete coverage from collection.
