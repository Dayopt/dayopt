# System Surface（自動生成）

> **生成元**: `scripts/tasks/generate-architecture-map.ts`（`pnpm architecture:generate`）。
> 実装（`apps/*` / `supabase` / `.github` / `scripts`）から自動発見した運用面の snapshot。
> **手で編集しない**。drift は `pnpm architecture:check`（docs-guard からも常時実行）が検出する。

実装から自動発見した「外部との接点・権限・設定」と、実装どうしの関係。概念との対応は
[`architecture-inventory.md`](./architecture-inventory.md) を見る。

## 外部との接点

### HTTP route（31）

tRPC の `/api/trpc` を含む、Next.js の route handler 全件。method は export から取る。

| app     | path                                         | method             | runtime | maxDuration | file                                                                      |
| ------- | -------------------------------------------- | ------------------ | ------- | ----------- | ------------------------------------------------------------------------- |
| product | `/.well-known/oauth-authorization-server`    | GET                | —       | 15          | `apps/product/src/app/.well-known/oauth-authorization-server/route.ts`    |
| product | `/.well-known/oauth-protected-resource`      | GET                | —       | 15          | `apps/product/src/app/.well-known/oauth-protected-resource/route.ts`      |
| product | `/[locale]/auth/callback`                    | GET                | —       | 60          | `apps/product/src/app/[locale]/(auth)/auth/callback/route.ts`             |
| product | `/[locale]/auth/confirm`                     | GET                | —       | 60          | `apps/product/src/app/[locale]/(auth)/auth/confirm/route.ts`              |
| product | `/api/cron/billing-reconciliation`           | GET                | nodejs  | 60          | `apps/product/src/app/api/cron/billing-reconciliation/route.ts`           |
| product | `/api/cron/calendar-account-deletion-settle` | GET                | nodejs  | 60          | `apps/product/src/app/api/cron/calendar-account-deletion-settle/route.ts` |
| product | `/api/cron/calendar-sync`                    | GET                | nodejs  | 60          | `apps/product/src/app/api/cron/calendar-sync/route.ts`                    |
| product | `/api/cron/external-connection-maintenance`  | GET                | nodejs  | 60          | `apps/product/src/app/api/cron/external-connection-maintenance/route.ts`  |
| product | `/api/csp-report`                            | POST, HEAD         | —       | 30          | `apps/product/src/app/api/csp-report/route.ts`                            |
| product | `/api/health`                                | GET                | —       | 30          | `apps/product/src/app/api/health/route.ts`                                |
| product | `/api/health/version`                        | GET                | —       | 15          | `apps/product/src/app/api/health/version/route.ts`                        |
| product | `/api/integrations/google-calendar/callback` | GET                | nodejs  | 90          | `apps/product/src/app/api/integrations/google-calendar/callback/route.ts` |
| product | `/api/integrations/google-calendar/start`    | GET                | nodejs  | 60          | `apps/product/src/app/api/integrations/google-calendar/start/route.ts`    |
| product | `/api/mcp`                                   | GET, POST, DELETE  | —       | 120         | `apps/product/src/app/api/mcp/route.ts`                                   |
| product | `/api/oauth/token`                           | POST               | —       | 60          | `apps/product/src/app/api/oauth/token/route.ts`                           |
| product | `/api/trpc/[trpc]`                           | GET, POST          | nodejs  | 60          | `apps/product/src/app/api/trpc/[trpc]/route.ts`                           |
| product | `/api/v1/calendar/[token]`                   | GET                | —       | 60          | `apps/product/src/app/api/v1/calendar/[token]/route.ts`                   |
| product | `/api/v1/system/[...retired]`                | GET, POST, OPTIONS | —       | 5           | `apps/product/src/app/api/v1/system/[...retired]/route.ts`                |
| product | `/api/webhooks/resend`                       | POST               | nodejs  | 30          | `apps/product/src/app/api/webhooks/resend/route.ts`                       |
| product | `/api/webhooks/stripe`                       | POST               | —       | 30          | `apps/product/src/app/api/webhooks/stripe/route.ts`                       |
| product | `/maintenance`                               | GET                | —       | 15          | `apps/product/src/app/maintenance/route.ts`                               |
| product | `/mcp`                                       | GET, POST, DELETE  | —       | 120         | `apps/product/src/app/mcp/route.ts`                                       |
| product | `/oauth/token`                               | POST               | —       | 60          | `apps/product/src/app/oauth/token/route.ts`                               |
| web     | `/api/compass-docs`                          | GET                | —       | 30          | `apps/web/src/app/api/compass-docs/route.ts`                              |
| web     | `/api/contact`                               | POST               | —       | 30          | `apps/web/src/app/api/contact/route.ts`                                   |
| web     | `/api/csp-report`                            | POST, HEAD         | —       | 30          | `apps/web/src/app/api/csp-report/route.ts`                                |
| web     | `/api/search`                                | GET                | —       | 30          | `apps/web/src/app/api/search/route.ts`                                    |
| web     | `/api/v1/system/[...retired]`                | GET, POST, OPTIONS | —       | 5           | `apps/web/src/app/api/v1/system/[...retired]/route.ts`                    |
| web     | `/api/webhooks/resend`                       | POST               | nodejs  | 15          | `apps/web/src/app/api/webhooks/resend/route.ts`                           |
| web     | `/blog/feed.xml`                             | GET                | —       | 30          | `apps/web/src/app/blog/feed.xml/route.ts`                                 |
| web     | `/ja/blog/feed.xml`                          | GET                | —       | 30          | `apps/web/src/app/ja/blog/feed.xml/route.ts`                              |

### 定期実行（16）

| source         | 対象                                         | schedule       | 発見元                                          |
| -------------- | -------------------------------------------- | -------------- | ----------------------------------------------- |
| vercel         | `/api/cron/calendar-sync`                    | `*/15 * * * *` | `apps/product/vercel.json`                      |
| vercel         | `/api/cron/external-connection-maintenance`  | `*/15 * * * *` | `apps/product/vercel.json`                      |
| vercel         | `/api/cron/calendar-account-deletion-settle` | `5 * * * *`    | `apps/product/vercel.json`                      |
| vercel         | `/api/cron/billing-reconciliation`           | `15 2 * * *`   | `apps/product/vercel.json`                      |
| github-actions | `nightly.yml`                                | `30 19 * * *`  | `.github/workflows/nightly.yml`                 |
| github-actions | `nightly.yml`                                | `30 21 * * *`  | `.github/workflows/nightly.yml`                 |
| github-actions | `nightly.yml`                                | `0 22 * * *`   | `.github/workflows/nightly.yml`                 |
| github-actions | `production-config-audit.yml`                | `0 21 * * *`   | `.github/workflows/production-config-audit.yml` |
| github-actions | `production-config-audit.yml`                | `*/15 * * * *` | `.github/workflows/production-config-audit.yml` |

**pg_cron（7）**: 下表は migration 上の定義を schedule / unschedule の順に畳んだもの。
production の pg_cron は Supabase Dashboard 側が正本なので、ここは参考値として読む。
job 名を変数で渡す schedule と、jobid で消す unschedule は追えない（実在確認は `cron.job` を引く）。

| job                                    | schedule     | 最後に定義した migration                                                               |
| -------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `cleanup-notifications`                | `20 3 * * *` | `supabase/migrations/00000000000000_baseline.sql`                                      |
| `check-reminders`                      | `* * * * *`  | `supabase/migrations/20260319000003_vault_invoke_edge_function.sql`                    |
| `expire-calendar-revoke-outbox`        | `* * * * *`  | `supabase/migrations/20260730090003_harden_calendar_revoke_expiry.sql`                 |
| `cleanup-product-events`               | `40 3 * * *` | `supabase/migrations/20260802013954_add_product_events.sql`                            |
| `cleanup-calendar-authority-retention` | `50 * * * *` | `supabase/migrations/20260812041309_schedule_calendar_authority_retention_cleanup.sql` |
| `expire-calendar-revoke-authority`     | `10 * * * *` | `supabase/migrations/20260813130000_schedule_calendar_revoke_authority_lifecycle.sql`  |
| `finalize-calendar-revoke-guards`      | `15 * * * *` | `supabase/migrations/20260813130000_schedule_calendar_revoke_authority_lifecycle.sql`  |

### Supabase（Edge Function / auth hook / storage bucket）

| 種別           | 名前                  | 補足     |
| -------------- | --------------------- | -------- |
| storage-bucket | `avatars`             | —        |
| auth-hook      | `custom_access_token` | enabled  |
| auth-hook      | `send_email`          | disabled |
| edge-function  | `send-auth-email`     | —        |

## 権限と上限

### OAuth scope（8）

| scope              | MCP tool                                                                 | tRPC procedure                                                   |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `read:entries`     | `entries.list`, `plans.get`, `plans.list`, `records.get`, `records.list` | `plans.list`, `plans.getById`, `records.list`, `records.getById` |
| `read:activities`  | `activities.list`, `categories.list`                                     | `activities.listActivities`, `activities.listCategories`         |
| `read:constraints` | `constraints.get`                                                        | `timeblockContext.getConstraints`                                |
| `read:stats`       | `review.get`                                                             | `statistics.getMcpReview`                                        |
| `write:plans`      | `plans.create`, `plans.update`                                           | —                                                                |
| `delete:plans`     | `plans.delete`, `plans.restore`, `plans.trash.list`                      | —                                                                |
| `write:records`    | `records.create`, `records.update`                                       | —                                                                |
| `delete:records`   | `records.delete`, `records.restore`, `records.trash.list`                | —                                                                |

### procedure builder

| builder              | 使っている procedure 数 | 定義                                      |
| -------------------- | ----------------------- | ----------------------------------------- |
| `protectedProcedure` | 79                      | `apps/product/src/lib/trpc/procedures.ts` |
| `entitledProcedure`  | 4                       | `apps/product/src/lib/trpc/procedures.ts` |

### rate limit（21）

| limiter                        | 上限 | 窓     | 利用箇所                                                                                                                                          |
| ------------------------------ | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contactRateLimit`             | 5    | `1 h`  | `apps/product/src/features/contact/server/router.ts`                                                                                              |
| `contactGlobalRateLimit`       | 60   | `1 h`  | `apps/product/src/features/contact/server/router.ts`                                                                                              |
| `trpcUserRateLimit`            | 300  | `1 m`  | `apps/product/src/lib/trpc/procedures.ts`                                                                                                         |
| `reauthRateLimit`              | 5    | `10 m` | `apps/product/src/features/auth/server/password-reauthentication.ts`                                                                              |
| `mcpPreAuthRateLimit`          | 1200 | `1 m`  | `apps/product/src/lib/mcp/request-rate-limit.ts`                                                                                                  |
| `mcpUserRateLimit`             | 120  | `1 m`  | `apps/product/src/lib/mcp/request-rate-limit.ts`                                                                                                  |
| `oauthTokenIpRateLimit`        | 10   | `1 m`  | `apps/product/src/lib/oauth-server/token-rate-limit.ts`                                                                                           |
| `oauthTokenPreBodyIpRateLimit` | 600  | `1 m`  | `apps/product/src/lib/oauth-server/token-rate-limit.ts`                                                                                           |
| `oauthTokenRefreshRateLimit`   | 30   | `1 m`  | `apps/product/src/lib/oauth-server/token-rate-limit.ts`                                                                                           |
| `oauthTokenRefreshIpRateLimit` | 120  | `1 m`  | `apps/product/src/lib/oauth-server/token-rate-limit.ts`                                                                                           |
| `oauthTokenGlobalRateLimit`    | 120  | `1 m`  | `apps/product/src/lib/oauth-server/token-rate-limit.ts`                                                                                           |
| `timeblockCreateRateLimit`     | 500  | `24 h` | 利用箇所なし                                                                                                                                      |
| `icalFeedRateLimit`            | 10   | `1 m`  | `apps/product/src/app/api/v1/calendar/[token]/route.ts`                                                                                           |
| `icalFeedIpRateLimit`          | 60   | `1 m`  | `apps/product/src/app/api/v1/calendar/[token]/route.ts`                                                                                           |
| `trpcPreAuthIpRateLimit`       | 600  | `1 m`  | `apps/product/src/lib/trpc/context.ts`                                                                                                            |
| `healthCheckGlobalRateLimit`   | 120  | `1 m`  | `apps/product/src/app/api/health/route.ts`                                                                                                        |
| `icalFeedGlobalRateLimit`      | 600  | `1 m`  | `apps/product/src/app/api/v1/calendar/[token]/route.ts`                                                                                           |
| `calendarConnectRateLimit`     | 10   | `1 h`  | `apps/product/src/app/api/integrations/google-calendar/callback/route.ts`, `apps/product/src/app/api/integrations/google-calendar/start/route.ts` |
| `calendarSyncNowRateLimit`     | 6    | `1 h`  | `apps/product/src/features/external-calendar/server/router.ts`                                                                                    |
| `cspReportRateLimit`           | 20   | `1 m`  | `apps/product/src/app/api/csp-report/route.ts`                                                                                                    |
| `cspReportGlobalRateLimit`     | 120  | `1 m`  | `apps/product/src/app/api/csp-report/route.ts`                                                                                                    |

## DB エラーコード（13）

migration の `RAISE EXCEPTION ... USING ERRCODE` と、app 側でその文字列を参照する file。
message は migration 履歴の重複排除なので、撤去した旧規則の文言が混ざる（現在の規則は
[`invariants.md`](../invariants.md) §時刻 を見る）。

| code    | message                                                                                                   | raise する migration | app 側の参照                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DT001` | Activity not found / External calendar event not found / Linked Plan not found                            | 16                   | `apps/product/src/features/external-calendar/server/token-rotation.ts`, `apps/product/src/features/timeblock/server/timeblock-command-client.ts` |
| `DT002` | Plan version conflict / Record version conflict                                                           | 8                    | —                                                                                                                                                |
| `DT003` | Confirm day range end must be after start / Plan end must be after start / Record end must be after start | 8                    | —                                                                                                                                                |
| `DT004` | Plans must end in the future                                                                              | 7                    | —                                                                                                                                                |
| `DT005` | Future Plans cannot have linked Records / Records cannot end in the future                                | 1                    | —                                                                                                                                                |
| `DT006` | Past plan time is locked                                                                                  | 1                    | —                                                                                                                                                |
| `DT007` | Future Plans cannot be skipped                                                                            | 2                    | —                                                                                                                                                |
| `DT008` | Skipped Plans cannot have linked Records                                                                  | 5                    | —                                                                                                                                                |
| `DT009` | Migrated Record is immutable                                                                              | 8                    | —                                                                                                                                                |
| `DT011` | Plan already has an active Record                                                                         | 5                    | —                                                                                                                                                |
| `DT012` | Invalid Plan source shape / Invalid Record fulfillment value / Invalid Record source shape                | 8                    | —                                                                                                                                                |
| `DT013` | Future Plans cannot have linked Records                                                                   | 3                    | —                                                                                                                                                |
| `DT014` | Activity is archived / Tag is archived                                                                    | 2                    | —                                                                                                                                                |

## 分析イベント（10）

TS の `PRODUCT_EVENT_NAMES` と DB の CHECK 制約の両方で定義される。両者の不一致は
`pnpm architecture:check` が止める。

| event                            | DB の CHECK 制約 |
| -------------------------------- | ---------------- |
| `user_signed_up`                 | 許可             |
| `plan_created`                   | 許可             |
| `record_created`                 | 許可             |
| `review_opened`                  | 許可             |
| `checkout_started`               | 許可             |
| `subscription_started`           | 許可             |
| `app_trial_started`              | 許可             |
| `subscription_payment_succeeded` | 許可             |
| `subscription_renewal_succeeded` | 許可             |
| `subscription_ended`             | 許可             |

## 設定

### env 変数（59）

名前と所在だけを載せる（値は 1Password にあり、この生成物は触らない）。

| env                                      | 必須 | visibility | environment         | 1Password item                  | apps/product の env schema |
| ---------------------------------------- | ---- | ---------- | ------------------- | ------------------------------- | -------------------------- |
| `CALENDAR_TOKEN_ENCRYPTION_KEY`          | no   | secret     | staging, production | google-calendar                 | —                          |
| `CRON_SECRET`                            | no   | secret     | staging, production | supabase                        | —                          |
| `GOOGLE_CALENDAR_CLIENT_ID`              | no   | public     | staging, production | google-calendar                 | —                          |
| `GOOGLE_CALENDAR_CLIENT_SECRET`          | no   | secret     | staging, production | google-calendar                 | —                          |
| `GOOGLE_CALENDAR_PROJECT_NUMBER`         | no   | public     | staging, production | google-calendar                 | —                          |
| `GOOGLE_CALENDAR_REDIRECT_URIS`          | no   | public     | staging, production | google-calendar                 | —                          |
| `MCP_CANONICAL_RESOURCE_URI`             | no   | public     | staging, production | app                             | —                          |
| `MCP_OAUTH_ENVIRONMENT`                  | no   | public     | staging, production | app                             | —                          |
| `MCP_OAUTH_PREVIEW_BRANCH`               | no   | public     | staging             | app                             | —                          |
| `MCP_OAUTH_PREVIEW_UPSTASH_HOST`         | no   | public     | staging             | app                             | —                          |
| `MCP_WRITE_ENABLED_CLIENTS`              | no   | public     | staging, production | app                             | —                          |
| `NEXT_PUBLIC_APP_URL`                    | yes  | public     | local, production   | app                             | —                          |
| `NEXT_PUBLIC_SENTRY_DSN`                 | yes  | public     | production          | sentry, sentry-web              | —                          |
| `NEXT_PUBLIC_SITE_URL`                   | no   | public     | staging, production | app                             | —                          |
| `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`        | no   | public     | staging, production | stripe-test, stripe-live        | —                          |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`   | yes  | public     | production          | supabase                        | —                          |
| `NEXT_PUBLIC_SUPABASE_URL`               | yes  | public     | production          | supabase                        | —                          |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`         | no   | public     | shared              | turnstile                       | —                          |
| `OAUTH_AUTHORIZATION_SERVER_URI`         | no   | public     | staging, production | app                             | —                          |
| `OAUTH_CHATGPT_REDIRECT_URIS`            | no   | public     | staging, production | app                             | —                          |
| `OAUTH_CLAUDE_REDIRECT_URIS`             | no   | public     | staging, production | app                             | —                          |
| `OAUTH_CURSOR_REDIRECT_URIS`             | no   | public     | staging, production | app                             | —                          |
| `RCLONE_CONFIG_DEST_ACCESS_KEY_ID`       | yes  | secret     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_DEST_ENDPOINT`            | yes  | public     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_DEST_PROVIDER`            | yes  | public     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_DEST_REGION`              | yes  | public     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY`   | yes  | secret     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_DEST_TYPE`                | yes  | public     | production          | Cloudflare-R2-storagebackup     | —                          |
| `RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID`     | yes  | secret     | production          | Supabase-StorageS3-backupsource | —                          |
| `RCLONE_CONFIG_SOURCE_ENDPOINT`          | yes  | public     | production          | Supabase-StorageS3-backupsource | —                          |
| `RCLONE_CONFIG_SOURCE_PROVIDER`          | yes  | public     | production          | Supabase-StorageS3-backupsource | —                          |
| `RCLONE_CONFIG_SOURCE_REGION`            | yes  | public     | production          | Supabase-StorageS3-backupsource | —                          |
| `RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY` | yes  | secret     | production          | Supabase-StorageS3-backupsource | —                          |
| `RCLONE_CONFIG_SOURCE_TYPE`              | yes  | public     | production          | Supabase-StorageS3-backupsource | —                          |
| `RECOVERY_CODE_PEPPER`                   | no   | secret     | staging, production | app                             | —                          |
| `RESEND_API_KEY`                         | no   | secret     | production          | resend-send                     | —                          |
| `RESEND_FROM_EMAIL`                      | no   | public     | production          | resend-send                     | —                          |
| `RESEND_WEBHOOK_SECRET`                  | no   | secret     | production          | resend, resend-web              | —                          |
| `SEND_EMAIL_HOOK_SECRET`                 | no   | secret     | staging, production | supabase                        | —                          |
| `SENTRY_AUTH_TOKEN`                      | yes  | secret     | production          | sentry-release-token            | —                          |
| `SENTRY_DSN`                             | yes  | secret     | staging, production | supabase, sentry, sentry-web    | —                          |
| `SENTRY_ORG`                             | yes  | public     | production          | sentry, sentry-web              | —                          |
| `SENTRY_PROJECT`                         | yes  | public     | production          | sentry, sentry-web              | —                          |
| `STRIPE_ACCOUNT_ID`                      | no   | public     | staging, production | stripe-test, stripe-live        | —                          |
| `STRIPE_LIVEMODE`                        | no   | public     | staging, production | stripe-test, stripe-live        | —                          |
| `STRIPE_SECRET_KEY`                      | no   | secret     | staging, production | stripe-test, stripe-live        | —                          |
| `STRIPE_WEBHOOK_SECRET`                  | no   | secret     | staging, production | stripe-test, stripe-live        | —                          |
| `SUPABASE_ACCESS_TOKEN`                  | no   | secret     | production          | supabase-cli                    | —                          |
| `SUPABASE_AUTH_AUDIT_TOKEN`              | yes  | secret     | production          | supabase-auth-audit             | —                          |
| `SUPABASE_DB_PASSWORD`                   | yes  | secret     | production          | supabase                        | —                          |
| `SUPABASE_SECRET_KEY`                    | yes  | secret     | production          | supabase                        | —                          |
| `SUPABASE_STORAGE_RLS_AUDIT_TOKEN`       | yes  | secret     | production          | supabase-storage-rls-audit      | —                          |
| `TURNSTILE_SECRET_KEY`                   | no   | secret     | shared              | turnstile                       | —                          |
| `UPSTASH_REDIS_REST_TOKEN`               | no   | secret     | staging, production | upstash                         | —                          |
| `UPSTASH_REDIS_REST_URL`                 | no   | secret     | staging, production | upstash                         | —                          |
| `VERCEL_BYPASS_PRODUCT`                  | yes  | secret     | production          | vercel-production               | —                          |
| `VERCEL_BYPASS_WEB`                      | yes  | secret     | production          | vercel-production               | —                          |
| `VERCEL_TEAM_ID`                         | yes  | public     | production          | vercel-production               | —                          |
| `VERCEL_TOKEN`                           | yes  | secret     | production          | vercel-production               | —                          |

### workspace package（6）

| package                 | exports                                          | 依存している workspace                                |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `@dayopt/billing`       | `.`                                              | `@dayopt/product`, `@dayopt/web`                      |
| `@dayopt/components`    | `.`                                              | `@dayopt/product`, `@dayopt/storybook`, `@dayopt/web` |
| `@dayopt/config`        | `.`                                              | `@dayopt/i18n`, `@dayopt/product`, `@dayopt/web`      |
| `@dayopt/foundations`   | `./og-colors`, `./scrollbar.css`, `./tokens.css` | `@dayopt/product`, `@dayopt/storybook`, `@dayopt/web` |
| `@dayopt/i18n`          | `./navigation`, `./request`, `./routing`         | `@dayopt/product`, `@dayopt/web`                      |
| `@dayopt/observability` | `.`, `./build-gate`                              | `@dayopt/product`, `@dayopt/web`                      |

## 関係

### MCP tool → tRPC procedure

1 file が複数 tool を登録することがあるため、file 単位で出す（tool ごとの内訳は
型チェッカーを使う次の段で分ける）。ここに出ない tool は tRPC を経由せず DB 関数を直接呼ぶ。

| tool                                                                                                                                     | procedure                                              | file                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `activities.list`                                                                                                                        | `activities.listActivities`                            | `apps/product/src/app/api/mcp/_tools/activities-list.ts`     |
| `categories.list`                                                                                                                        | `activities.listCategories`                            | `apps/product/src/app/api/mcp/_tools/categories-list.ts`     |
| `constraints.get`                                                                                                                        | `timeblockContext.getConstraints`                      | `apps/product/src/app/api/mcp/_tools/constraints-get.ts`     |
| `entries.list`                                                                                                                           | `plans.list`, `records.list`                           | `apps/product/src/app/api/mcp/_tools/entries-list.ts`        |
| `review.get`                                                                                                                             | `activities.listActivities`, `statistics.getMcpReview` | `apps/product/src/app/api/mcp/_tools/review-get.ts`          |
| `plans.get`, `plans.trash.list`, `records.get`, `records.trash.list`                                                                     | `plans.getById`, `records.getById`                     | `apps/product/src/app/api/mcp/_tools/timeblock-detail.ts`    |
| `plans.list`, `records.list`                                                                                                             | `plans.list`, `records.list`                           | `apps/product/src/app/api/mcp/_tools/timeblock-list.ts`      |
| `plans.create`, `plans.delete`, `plans.restore`, `plans.update`, `records.create`, `records.delete`, `records.restore`, `records.update` | tRPC を経由しない                                      | `apps/product/src/app/api/mcp/_tools/timeblock-mutations.ts` |

### tRPC procedure の呼び出し元（83）

呼び出し元は file 数。`api.x.y.useQuery` / `utils.x.y.invalidate` / `helpers.x.y.prefetch` /
`trpc.x.y(`（MCP bridge）を数える。test と Story は数えない。

| procedure                                    | app からの参照 file | MCP からの参照 file |
| -------------------------------------------- | ------------------- | ------------------- |
| `activities.archiveActivity`                 | 1                   | 0                   |
| `activities.archiveCategory`                 | 1                   | 0                   |
| `activities.createActivity`                  | 1                   | 0                   |
| `activities.createCategory`                  | 1                   | 0                   |
| `activities.deleteActivity`                  | 2                   | 0                   |
| `activities.deleteCategory`                  | 1                   | 0                   |
| `activities.listActivities`                  | 3                   | 2                   |
| `activities.listCategories`                  | 2                   | 1                   |
| `activities.listTree`                        | 2                   | 0                   |
| `activities.restoreActivity`                 | 1                   | 0                   |
| `activities.restoreCategory`                 | 1                   | 0                   |
| `activities.updateActivity`                  | 1                   | 0                   |
| `activities.updateCategory`                  | 1                   | 0                   |
| `billing.createCheckoutSession`              | 1                   | 0                   |
| `billing.createPortalSession`                | 3                   | 0                   |
| `billing.getAccess`                          | 2                   | 0                   |
| `billing.getInfo`                            | 0                   | 0                   |
| `billing.getInvoices`                        | 0                   | 0                   |
| `billing.getOverview`                        | 7                   | 0                   |
| `billing.getPaymentMethod`                   | 0                   | 0                   |
| `billing.startTrial`                         | 1                   | 0                   |
| `contact.submit`                             | 1                   | 0                   |
| `email.sendAccountDeletion`                  | 0                   | 0                   |
| `email.sendCancellationConfirm`              | 0                   | 0                   |
| `email.sendPasswordChanged`                  | 1                   | 0                   |
| `email.sendPaymentFailed`                    | 0                   | 0                   |
| `email.sendPaymentRecovered`                 | 0                   | 0                   |
| `email.sendProStart`                         | 0                   | 0                   |
| `email.sendTest`                             | 0                   | 0                   |
| `email.sendTrialExpired`                     | 0                   | 0                   |
| `email.sendTrialExpiring`                    | 0                   | 0                   |
| `email.sendTrialStart`                       | 0                   | 0                   |
| `email.sendWelcome`                          | 0                   | 0                   |
| `externalCalendar.disconnect`                | 1                   | 0                   |
| `externalCalendar.dismissEvent`              | 1                   | 0                   |
| `externalCalendar.getConnectionAvailability` | 1                   | 0                   |
| `externalCalendar.getSyncStatus`             | 1                   | 0                   |
| `externalCalendar.listConnections`           | 2                   | 0                   |
| `externalCalendar.listEvents`                | 5                   | 0                   |
| `externalCalendar.listProviderCalendars`     | 1                   | 0                   |
| `externalCalendar.syncNow`                   | 1                   | 0                   |
| `externalCalendar.updateSelectedCalendars`   | 1                   | 0                   |
| `mcpConnections.list`                        | 1                   | 0                   |
| `mcpConnections.revoke`                      | 1                   | 0                   |
| `planCommands.confirmDay`                    | 1                   | 0                   |
| `planCommands.create`                        | 1                   | 0                   |
| `planCommands.delete`                        | 1                   | 0                   |
| `planCommands.record`                        | 1                   | 0                   |
| `planCommands.restore`                       | 1                   | 0                   |
| `planCommands.update`                        | 1                   | 0                   |
| `plans.getById`                              | 2                   | 1                   |
| `plans.list`                                 | 8                   | 2                   |
| `planTemplates.applyToDay`                   | 1                   | 0                   |
| `planTemplates.create`                       | 1                   | 0                   |
| `planTemplates.delete`                       | 1                   | 0                   |
| `planTemplates.list`                         | 2                   | 0                   |
| `planTemplates.rename`                       | 1                   | 0                   |
| `recordCommands.create`                      | 1                   | 0                   |
| `recordCommands.delete`                      | 2                   | 0                   |
| `recordCommands.restore`                     | 1                   | 0                   |
| `recordCommands.update`                      | 1                   | 0                   |
| `records.getById`                            | 3                   | 1                   |
| `records.list`                               | 8                   | 2                   |
| `review.getReportActivityDetail`             | 1                   | 0                   |
| `review.getReportPeriod`                     | 1                   | 0                   |
| `review.trackOpened`                         | 1                   | 0                   |
| `statistics.getActivityEstimationFactors`    | 1                   | 0                   |
| `statistics.getActivityStats`                | 3                   | 0                   |
| `statistics.getMcpReview`                    | 0                   | 1                   |
| `statistics.getTagEstimationFactors`         | 0                   | 0                   |
| `timeblockContext.getConstraints`            | 0                   | 1                   |
| `timeblockContext.getRevision`               | 0                   | 0                   |
| `user.deleteAccount`                         | 1                   | 0                   |
| `user.deleteAllData`                         | 1                   | 0                   |
| `user.deleteBlocks`                          | 1                   | 0                   |
| `user.exportData`                            | 1                   | 0                   |
| `user.requestEmailChange`                    | 1                   | 0                   |
| `user.verifyRecoveryCode`                    | 2                   | 0                   |
| `userSettings.get`                           | 9                   | 0                   |
| `userSettings.getICalToken`                  | 1                   | 0                   |
| `userSettings.regenerateICalToken`           | 1                   | 0                   |
| `userSettings.update`                        | 1                   | 0                   |
| `userSettings.updateProfile`                 | 2                   | 0                   |

### どこからも呼ばれていない procedure（15）

削除候補ではあるが、判断は別（外部契約に近いものがある）。ここは事実の提示だけ。

- `billing.getInfo`
- `billing.getInvoices`
- `billing.getPaymentMethod`
- `email.sendAccountDeletion`
- `email.sendCancellationConfirm`
- `email.sendPaymentFailed`
- `email.sendPaymentRecovered`
- `email.sendProStart`
- `email.sendTest`
- `email.sendTrialExpired`
- `email.sendTrialExpiring`
- `email.sendTrialStart`
- `email.sendWelcome`
- `statistics.getTagEstimationFactors`
- `timeblockContext.getRevision`

### store の利用元

| store                         | 利用 file 数 | 利用 file（先頭 3 件）                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useShellStore`               | 31           | `apps/product/src/app/[locale]/(app)/(workspace)/_composition/CalendarViewClient.tsx`, `apps/product/src/app/[locale]/(app)/(workspace)/_composition/ReportViewClient.tsx`, `apps/product/src/app/[locale]/(app)/_overlays/GlobalOverlays.tsx`                                         |
| `useAuthStore`                | 21           | `apps/product/src/app/[locale]/(app)/_providers/_composition/QueryCacheAuthBoundary.tsx`, `apps/product/src/app/[locale]/(app)/_shell/MobileAccountButton.tsx`, `apps/product/src/app/[locale]/(app)/_shell/desktop-layout.tsx`                                                        |
| `useTimeblockInspectorStore`  | 17           | `apps/product/src/app/[locale]/(app)/(workspace)/_composition/useCalendarComposition.ts`, `apps/product/src/app/[locale]/(app)/_overlays/GlobalOverlays.tsx`, `apps/product/src/app/[locale]/(app)/_providers/useApplyUpdateWhenSafe.ts`                                               |
| `useReportDetailStore`        | 10           | `apps/product/src/app/[locale]/(app)/_shell/desktop-layout.tsx`, `apps/product/src/features/review/components/detail/ConnectedReportDetailPanel.tsx`, `apps/product/src/features/review/components/detail/ReportDetailResizeHandle.tsx`                                                |
| `useInlineCreateStore`        | 7            | `apps/product/src/features/calendar/components/controller/hooks/useCalendarHandlers.ts`, `apps/product/src/features/calendar/components/create/InlineCreatePanel.tsx`, `apps/product/src/features/calendar/components/create/useInlineCreate.ts`                                       |
| `useCalendarDragStore`        | 5            | `apps/product/src/features/calendar/components/activity-filter/ActivityDragContext.tsx`, `apps/product/src/features/calendar/components/views/shared/components/CalendarGridContent.tsx`, `apps/product/src/features/calendar/interaction/interaction-effects.ts`                      |
| `useCalendarFilterStore`      | 5            | `apps/product/src/features/calendar/components/activity-filter/ActivityFilterList.tsx`, `apps/product/src/features/calendar/components/controller/hooks/useCalendarData.ts`, `apps/product/src/features/calendar/index.ts`                                                             |
| `useTimeblockClipboardStore`  | 5            | `apps/product/src/app/[locale]/(app)/(workspace)/_composition/useCalendarCrudHandlers.ts`, `apps/product/src/app/[locale]/(app)/_overlays/GlobalOverlays.tsx`, `apps/product/src/features/calendar/components/views/shared/components/CalendarDragSelection/CalendarDragSelection.tsx` |
| `useBillingPollStore`         | 4            | `apps/product/src/app/[locale]/(app)/_shell/useAppInlineBanner.ts`, `apps/product/src/app/[locale]/(app)/settings/[category]/page.tsx`, `apps/product/src/features/settings/components/BillingSettings.tsx`                                                                            |
| `useCalendarNavigationStore`  | 4            | `apps/product/src/app/[locale]/(app)/(workspace)/_composition/useCalendarComposition.ts`, `apps/product/src/app/[locale]/(app)/_shell/CalendarSidebar.tsx`, `apps/product/src/features/calendar/hooks/navigation/CalendarNavigationContext.tsx`                                        |
| `useReportViewStore`          | 4            | `apps/product/src/features/review/components/report/ReportBody.tsx`, `apps/product/src/features/review/components/sidebar/ReportFilterDrawer.tsx`, `apps/product/src/features/review/components/sidebar/ReportFilterList.tsx`                                                          |
| `useTemplateSaveStore`        | 3            | `apps/product/src/app/[locale]/(app)/_shell/CalendarSidebar.tsx`, `apps/product/src/features/calendar/components/CalendarController.tsx`, `apps/product/src/features/calendar/index.ts`                                                                                                |
| `useActivitySortStore`        | 2            | `apps/product/src/features/calendar/components/activity-filter/ActivityFilterList.tsx`, `apps/product/src/features/calendar/components/activity-filter/sort-activities.ts`                                                                                                             |
| `useCalendarDisplayModeStore` | 2            | `apps/product/src/features/calendar/components/views/WeekView/components/MobileWeekLaneSwitcher.tsx`, `apps/product/src/features/calendar/components/views/WeekView/components/WeekGrid.tsx`                                                                                           |

### docs → feature

docs の frontmatter `code:` が指す実装から引く。

| doc                                            | feature                                 |
| ---------------------------------------------- | --------------------------------------- |
| `docs/operations/contact-email.md`             | `contact`                               |
| `docs/operations/google-oauth-verification.md` | `external-calendar`                     |
| `docs/product/specs/activities.md`             | `activities`                            |
| `docs/product/specs/auth.md`                   | `auth`, `external-calendar`, `settings` |
| `docs/product/specs/calendar.md`               | `calendar`                              |
| `docs/product/specs/contact.md`                | `contact`                               |
| `docs/product/specs/external-calendar.md`      | `external-calendar`                     |
| `docs/product/specs/plan-record.md`            | `timeblock`                             |
| `docs/product/specs/review.md`                 | `review`                                |
| `docs/product/specs/settings.md`               | `settings`                              |

**doc から辿れない feature**: なし

### E2E spec → route

| route                           | spec 数 | spec                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/[locale]`                     | 6       | `a11y.spec.ts`, `deep-link.spec.ts`, `mobile-navigation.spec.ts`, `pwa/pwa.spec.ts`, `review-granularity.spec.ts`, `smoke.spec.ts`                                                                                                                                                                                                                              |
| `/[locale]/auth`                | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/auth/confirmed`      | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/auth/login`          | 14      | `account-deletion.spec.ts`, `auth.spec.ts`, `billing.spec.ts`, `block-search.spec.ts`, `calendar-navigation.spec.ts`, `derived-plan-record-flow.spec.ts`, `http-csrf.spec.ts`, `legacy-url-redirects.spec.ts`, `plan-record-timeblock.spec.ts`, `pwa/pwa.spec.ts`, `seed.spec.ts`, `smoke.spec.ts`, `timeblock-conflict.spec.ts`, `timeblock-drag-move.spec.ts` |
| `/[locale]/auth/mfa-verify`     | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/auth/password`       | 1       | `auth.spec.ts`                                                                                                                                                                                                                                                                                                                                                  |
| `/[locale]/auth/reset-password` | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/auth/session-error`  | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/auth/signup`         | 1       | `auth.spec.ts`                                                                                                                                                                                                                                                                                                                                                  |
| `/[locale]/calendar`            | 11      | `account-deletion.spec.ts`, `calendar-initial-load.spec.ts`, `calendar-navigation.spec.ts`, `deep-link.spec.ts`, `derived-plan-record-flow.spec.ts`, `http-csrf.spec.ts`, `mobile-navigation.spec.ts`, `plan-record-timeblock.spec.ts`, `timeblock-conflict.spec.ts`, `timeblock-drag-move.spec.ts`, `timeblock-inspector-toggle.spec.ts`                       |
| `/[locale]/oauth/authorize`     | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/oauth/consent`       | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |
| `/[locale]/report`              | 3       | `a11y.spec.ts`, `critical-path.spec.ts`, `derived-plan-record-flow.spec.ts`                                                                                                                                                                                                                                                                                     |
| `/[locale]/settings`            | 1       | `mobile-navigation.spec.ts`                                                                                                                                                                                                                                                                                                                                     |
| `/[locale]/settings/[category]` | 3       | `a11y.spec.ts`, `account-deletion.spec.ts`, `billing.spec.ts`                                                                                                                                                                                                                                                                                                   |
| `/offline`                      | 0       | E2E なし                                                                                                                                                                                                                                                                                                                                                        |

**route に一致しなかった URL**: `/auth/confirm`, `/day`, `/week`（legacy redirect の入口など）

### DB 関数の integration test 被覆

app から呼ぶ DB 関数 76 件のうち、integration test（TS / SQL）から
呼ばれているのは 61 件。

**test から呼ばれていない（15）**: `abandon_calendar_account_delete_revoke_v1`, `begin_calendar_account_deletion_v1`, `claim_stripe_webhook_event`, `clear_calendar_sync_cursor_command_v1`, `delete_all_user_data_command_v5`, `finalize_calendar_account_delete_revoke_v1`, `get_external_lifecycle_app_version_v3`, `get_timeblock_context_marker_v1`, `list_expired_calendar_account_deletion_intents_v1`, `normalize_calendar_account_deletion_intent_v1`, `prepare_calendar_account_delete_revoke_v1`, `prepare_user_data_purge_v1`, `replace_selected_calendars_command_v1`, `seal_calendar_account_deletion_v1`, `start_calendar_account_delete_provider_attempt_v1`

### feature ごとの test / Story 被覆

| feature             | source | test file | component | Story のある component |
| ------------------- | ------ | --------- | --------- | ---------------------- |
| `activities`        | 30     | 3         | 11        | 3 / 11                 |
| `auth`              | 21     | 13        | 8         | 7 / 8                  |
| `calendar`          | 194    | 97        | 60        | 32 / 60                |
| `contact`           | 8      | 6         | 2         | 1 / 2                  |
| `external-calendar` | 26     | 19        | 2         | 1 / 2                  |
| `review`            | 37     | 22        | 19        | 14 / 19                |
| `settings`          | 47     | 35        | 22        | 17 / 22                |
| `timeblock`         | 98     | 55        | 18        | 12 / 18                |
