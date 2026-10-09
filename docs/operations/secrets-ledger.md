---
status: current
last_verified: 2026-10-09
code: scripts/tasks/env/schema.ts
---

# Secrets 台帳

1Password の vault / item / field の一覧と、値が 1Password の外にある場所（replica）の一覧。境界の契約は [secrets.md](./secrets.md)、サービスごとの手順は [secrets-services.md](./secrets-services.md) を読む。

item と field の期待値は `scripts/tasks/env/schema.ts` が正本で、`pnpm 1password:check` が実在と空の状態を値を出さずに検査する。この文書の表は人が読むための写しで、食い違ったら schema を正とする。

---

## 保管対象の分類

「API キー」「SSH 鍵」で分類すると漏れる。**漏れた時に何が起きるか**で分類する。

| 分類                          | 例                                                                                | 置き方                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ① API キー / アクセストークン | Supabase service role、Stripe secret、Sentry auth token、Vercel token、GitHub PAT | runtime 要件かどうかは `scripts/tasks/env/schema.ts` で判定する                                                   |
| ② SSH 鍵 / 署名鍵             | GitHub push 用の SSH 秘密鍵、commit 署名鍵                                        | 1Password SSH Agent で管理し、ローカルの秘密鍵ファイルを増やさない                                                |
| ③ DB 接続情報                 | Supabase DB password、pooler URL                                                  | user・password・host を可能な限り field に分ける                                                                  |
| ④ OAuth / サービスアカウント  | Google OAuth client secret、Apple `.p8`、証明書、service account JSON             | ファイル形式は 1Password Document にする                                                                          |
| ⑤ リカバリー系                | 2FA recovery codes、TOTP seed、ドメインレジストラの recovery 情報                 | 各 Login item に置き、タグ `recovery` を付ける。`op item list --tags recovery` の空は「タグ未付与」の可能性を含む |

## タグ

タグは vault（読み手）と分類（上の①〜⑤）に直交する軸。

- **ベンダー軸 `dayopt/<vendor>`**: 全小文字で 2 段まで。同じベンダーに item が複数ある時と、製品名と事業者名が違う時（Turnstile は `dayopt/cloudflare`）だけ付ける。単発ログインの長尾は `dayopt/sns`・`dayopt/tools` に、自社の運用環境は `dayopt/internal` に畳む。種別タグ（login / api）は作らない。個人アカウントには付けない
- **性質軸（トップレベル）**: `recovery`（再発行不可の recovery 情報）と `critical`（定期監査の対象）。`dayopt/` の下に入れない
- **確認は生タグの集計で行う**。`--tags` フィルタはネストの判定を誤ったことがある

```bash
op item list --format=json | jq -r '.[] | .tags[]?' | sort | uniq -c | sort -rn
```

- **タグの編集は 1Password アプリで行う**。`op item edit --tags` は置換ではなく追記になり、重複を作る。SSO field を持つ item と SSH Key 型 item は CLI から編集できない

---

## Vault / Item / Field

vault は読み手で分ける 3 箱（[secrets.md](./secrets.md#vault-は読み手で分ける-3-箱)）。field 名は可能な限りコードの env 名と一致させる。`.op-env.agent.example` はこの schema の参照だけを持つ。

### `agent`

「入れた瞬間に agent へ漏れたとみなしても困らないもの」だけを置く。中身は test mode の credential と local dev 用の app 設定、agent の read-only token。通常の PR Preview と固定 Integration の接続情報はここへ置かず、それぞれの非本番 Vercel / Supabase 設定で管理する。local dev の Supabase 接続は `scripts/tasks/dev-with-op.sh` が `supabase status -o env` から注入し、1Password を経由しない（`scripts/__tests__/staging-supabase-boundary.test.ts` が固定）。

| Item                  | Fields                                                                                                                                                                                                                                                                                                                                               | 用途                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `supabase`            | `CRON_SECRET`, `SEND_EMAIL_HOOK_SECRET`, `SENTRY_DSN`（Edge Function send-auth-email 用、任意）                                                                                                                                                                                                                                                      | local dev 用 optional secret（cron / send-email hook の検証）                                                             |
| `upstash`             | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                                                                                                                                                                                                                 | Redis rate limit / cache                                                                                                  |
| `stripe-test`         | `STRIPE_SECRET_KEY`, `STRIPE_ACCOUNT_ID`, `STRIPE_LIVEMODE`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`                                                                                                                                                                                                                              | Stripe test mode                                                                                                          |
| `app`                 | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `RECOVERY_CODE_PEPPER`, `OAUTH_CLAUDE_REDIRECT_URIS`, `OAUTH_CHATGPT_REDIRECT_URIS`, `OAUTH_CURSOR_REDIRECT_URIS`, `MCP_OAUTH_ENVIRONMENT`, `OAUTH_AUTHORIZATION_SERVER_URI`, `MCP_CANONICAL_RESOURCE_URI`, `MCP_OAUTH_PREVIEW_BRANCH`, `MCP_OAUTH_PREVIEW_UPSTASH_HOST`, `MCP_WRITE_ENABLED_CLIENTS` | App URL / recovery code HMAC pepper / MCP OAuth beta。`RECOVERY_CODE_PEPPER` は production と別値                         |
| `google-calendar`     | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_PROJECT_NUMBER`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CALENDAR_REDIRECT_URIS`                                                                                                                                                                                     | 外部カレンダー取り込みの OAuth client（local dev 用）。schema 上の名前で、作成は User 作業                                |
| `turnstile`           | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                                                                                                                                                                                                                                                                                             | Cloudflare Turnstile                                                                                                      |
| `github-agent`        | `credential`（fine-grained PAT、Dayopt/dayopt 限定）, `expires`                                                                                                                                                                                                                                                                                      | agent の `gh` / git push。`op run` では消費せず `GH_CONFIG_DIR` の replica で使う（[手順](./secrets-services.md#github)） |
| `supabase-agent`      | `credential`（Supabase scoped access token、read 権限だけ、90 日期限）, `expires`                                                                                                                                                                                                                                                                    | agent の production Supabase 読み取り（[手順](./secrets-services.md#supabase)）                                           |
| `sentry-cli-readonly` | `credential`（Sentry user auth token、read scope だけ）                                                                                                                                                                                                                                                                                              | agent の Sentry 読み取り。経路は `mcp-usage` skill                                                                        |

agent に置かないもの: production ドメインから送れる Resend の送信 key（`human/resend-send`）、Vercel の token、Anthropic の key、Supabase の Management API token（`human/supabase-cli`）。`agent/supabase` の接続 4 field と `SUPABASE_ACCESS_TOKEN` は `forbiddenFields` に登録してあり、残っていれば `1password:check` が失敗する。

### Persistent Product Integration（#2910）

Integration は既存 `product` Vercel projectの `integration` branchと、非本番Supabase projectの `integration` branchを使う。新しいVercel projectや独自domainは作らない。共通Product Previewでは非本番persistent Supabaseを共有し、branch-scoped environment marker / OAuth originは固定Integration branchにだけ設定する。Supabase secret keyはserver-onlyで、Production credentialsをコピーしない。Preview E2E のログイン資格情報は別の Preview item から読み、Preview 全体で共通利用する。

固定originは `https://product-git-integration-dayopt.vercel.app`、Supabase refは `tilwaprottpyhlfoggbb`。Vercel project ID、Git branch、Preview target、branch alias、app URL、Supabase ref、OAuth issuer/resourceの一致をbuildとruntimeで検査する。Vercel system variablesは手入力せず、実secretやdeployment-specific URLをrepo・Issue・会話へ記録しない。

IntegrationのOAuth identity確認はread-only RPCだけを使い、healthやOAuth requestから自動provisionしない。不足・不一致はfail closedにする。MCP write allowlist、billing、PostHog送信は閉じたままにし、Integration専用Upstash key namespaceとrate-limit credentialsをProductionから分離する。Stripe・Google Calendarは使う時だけtest用の一式を設定し、Stripe account IDとOAuth accountも専用のテスト資源に限る。IntegrationのResend送信は未対応のため、API key・sender・webhook secret・CONTACT_INTEGRATION_RECIPIENTは設定しない。専用recipientを送信処理へ接続するまでは、完全な一式でもbuild/runtimeで拒否する。

deployment health だけで fresh Auth login、redirect / callback を含むログイン、アプリ CRUD の動作を完了としない。これらは別の E2E 証拠で確かめる。

### `human`

人間だけが読む。agent の Service Account はこの vault に届かない。本番 secret と、login / SSH / recovery / 個人系を置く。本番 secret は通常ローカルから参照せず、Vercel / Supabase Dashboard へ replica として同期する。Sentry は Product / Web で project を分けるため、item も分ける。

| Item                     | Fields                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase`               | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`, `CRON_SECRET`, `SEND_EMAIL_HOOK_SECRET`                                                                                                                             |
| `supabase-cli`           | `SUPABASE_ACCESS_TOKEN` + 有効期限 field。User が明示操作で使う Management API の operational credential                                                                                                                                                                               |
| `supabase-login`         | Supabase Dashboard の GUI ログイン（OTP 付き）。`op://` では参照しない                                                                                                                                                                                                                 |
| `upstash`                | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                                                                                                                                                   |
| `upstash-login`          | Upstash Console の GUI ログイン。`op://` では参照しない                                                                                                                                                                                                                                |
| `stripe-live`            | `STRIPE_SECRET_KEY`, `STRIPE_ACCOUNT_ID`, `STRIPE_LIVEMODE`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`                                                                                                                                                                |
| `posthog-delete`         | `credential`（Project 625917 限定の `person:write` key。account deletion が PostHog の削除を要求する時だけ使う）                                                                                                                                                                       |
| `resend`                 | `RESEND_WEBHOOK_SECRET`（Product）                                                                                                                                                                                                                                                     |
| `resend-send`            | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`（Product / Web の Production が共用する送信 credential）                                                                                                                                                                                         |
| `resend-web`             | `RESEND_WEBHOOK_SECRET`（Web、Product と別値）                                                                                                                                                                                                                                         |
| `sentry`                 | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`（Product）                                                                                                                                                                                                      |
| `sentry-web`             | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`（Web）                                                                                                                                                                                                          |
| `app`                    | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `RECOVERY_CODE_PEPPER`, `OAUTH_CLAUDE_REDIRECT_URIS`, `OAUTH_CHATGPT_REDIRECT_URIS`, `OAUTH_CURSOR_REDIRECT_URIS`, `MCP_OAUTH_ENVIRONMENT`, `OAUTH_AUTHORIZATION_SERVER_URI`, `MCP_CANONICAL_RESOURCE_URI`, `MCP_WRITE_ENABLED_CLIENTS` |
| `google-calendar`        | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_PROJECT_NUMBER`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `CALENDAR_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CALENDAR_REDIRECT_URIS`                                                                                                                       |
| `google-auth`            | `SUPABASE_AUTH_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_GOOGLE_SECRET`                                                                                                                                                                                                                        |
| `sentry-login`           | Sentry Dashboard の GUI ログイン（recovery codes を含む）。token field は持たない                                                                                                                                                                                                      |
| `github-login`           | password, TOTP, recovery codes                                                                                                                                                                                                                                                         |
| `github-ssh`             | SSH private key                                                                                                                                                                                                                                                                        |
| `domain`                 | registrar login, TOTP, recovery codes                                                                                                                                                                                                                                                  |
| `resend-support-replies` | `RESEND_SMTP_API_KEY`。Gmail の Send mail as 専用                                                                                                                                                                                                                                      |

`human` には agent の Service Account token の控え（master）も置く。`agent` に置くと、最初の 1 個を取り出す token が無い循環になるため。

app の env の意味（値は書かない）:

- `OAUTH_CLAUDE_REDIRECT_URIS` / `OAUTH_CHATGPT_REDIRECT_URIS` / `OAUTH_CURSOR_REDIRECT_URIS` は client が発行する追加 callback URI の comma 区切り exact allowlist。wildcard や origin だけの緩い一致は使わない。既定 callback で足りる client では空のままにする
- `MCP_OAUTH_ENVIRONMENT` は OAuth identity の環境 marker。所有する環境は Production と一時 Preview の 2 つだけで、常設 Staging は作らない。一時 Preview では `preview` を必須とし、`VERCEL_ENV=preview`、`VERCEL_TARGET_ENV=preview`、branch、issuer、resource のどれかが一致しなければ build と runtime を停止する。Production は未設定時だけ既存 origin を既定値にする
- `OAUTH_AUTHORIZATION_SERVER_URI` と `MCP_CANONICAL_RESOURCE_URI` は環境ごとに固定する origin。一時 Preview では同じ stable branch URL を使い、transport path、query、fragment、Production origin を含めない
- `MCP_OAUTH_PREVIEW_BRANCH` は検証対象 PR の exact branch 名。`VERCEL_GIT_COMMIT_REF` と一致しない Preview を停止する。Production には登録しない
- `MCP_OAUTH_PREVIEW_UPSTASH_HOST` は一時 Preview 専用 Upstash の host marker。接続先 URL の host と一致しない build を停止する。Production には登録せず、Production の Upstash を Preview へ複製しない
- `MCP_WRITE_ENABLED_CLIENTS` は runtime discovery / preflight 用の closed-beta allowlist であり、DB の global / client / connection gate を代替しない。未承認環境では空のままにする
- `CALENDAR_TOKEN_ENCRYPTION_KEY` は保存する refresh token を AES-256-GCM で暗号化する鍵。base64 で 32 バイトに decode できる値だけを受け付ける（`openssl rand -base64 32`）。鍵を失うと既存接続の token は復号できず、全ユーザーが再接続になる
- `GOOGLE_CALENDAR_REDIRECT_URIS` は comma 区切りの allowlist。callback は request host を allowlist と完全一致で引き、一致した文字列をそのまま Google へ渡す。Production には production origin だけを入れ、localhost を混ぜない
- `STRIPE_ACCOUNT_ID` と `STRIPE_LIVEMODE` は、正しい Stripe account と mode だけを変更するための固定 identity。durable Billing / account deletion を有効にする前に、`STRIPE_SECRET_KEY` と 3 項目をまとめて設定する。test mode は `false`、live mode は `true`

### `ci`

CI が消費する値の master。GitHub Actions Secrets との対応は `scripts/tasks/env/schema.ts` の `ciSecretSchema` が正本で、workflow の `secrets.*` 参照と名前で双方向に一致することを `scripts/__tests__/ci-secret-ledger.test.ts` が検査する。CI は 1Password を直接読まず GitHub Secrets の replica で動くため、この vault の読み手は同期作業をする人間だけ。

| Item                              | Fields                                                                                                        | 用途                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel-production`               | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_AUTOMATION_BYPASS_PRODUCT`, `VERCEL_AUTOMATION_BYPASS_WEB`          | Production Release（promote / rollback / smoke の Deployment Protection bypass）、Production Config Audit、replica check。token は team 全権で期限 2027-07-24                                            |
| `supabase-auth-audit`             | `credential`                                                                                                  | Production Auth Config Audit 専用 scoped token（Auth の Read のみ）                                                                                                                                      |
| `supabase-storage-rls-audit`      | `credential`                                                                                                  | Production Storage RLS Audit 専用 scoped token（`database_read` のみ、90 日期限）。GitHub Secret `SUPABASE_STORAGE_RLS_AUDIT_TOKEN` へ同期する                                                           |
| `Supabase-StorageS3-backupsource` | `RCLONE_CONFIG_SOURCE_TYPE` / `_PROVIDER` / `_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | nightly の Storage backup の読み出し元。**この key は全 bucket への書き込み・削除ができ RLS も効かない**。Supabase は読み取り専用や bucket 限定の S3 key を提供していないため、service role と同格に扱う |
| `Cloudflare-R2-storagebackup`     | `RCLONE_CONFIG_DEST_*`（6 field）, `Token value`                                                              | nightly の Storage backup の書き込み先（Cloudflare R2、Bucket Locks 35 日）。S3 用の key はこの token から派生するため **token を revoke すると backup も止まる**                                        |
| `sentry-release-token`            | `SENTRY_AUTH_TOKEN`                                                                                           | Vercel Production build の source map upload。GitHub Actions からは使わない                                                                                                                              |
| `anthropic-claude-review`         | `credential`                                                                                                  | `claude-review.yml` の `ANTHROPIC_API_KEY`。月の上限は Anthropic Console の spend limit                                                                                                                  |

`VERCEL_TOKEN` は automation 専用で、local CLI の login や `--token` 引数には使わない。local の確認方法と rotation 順序は [Environment Secrets](./security/environment-secrets.md) を正とする。

---

## Replica 台帳

基本方針「値がどこにあっても 1Password にもある」を検査できるようにするための列挙。**この表に無い場所に長寿命の実値があれば、それ自体が違反**。見つけたら master へ登録するか撤去し、この表を更新する。

| 場所                                                                                             | master                                                                                         | 機械検証                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Production Env（product / web）                                                           | `scripts/tasks/env/schema.ts` の各 entry                                                       | `production-config-audit.mjs`（台帳 → replica）と `pnpm replica:check`（replica → 台帳）                                              |
| Vercel Preview Env（`RECOVERY_CODE_PEPPER`）                                                     | `agent` / `human` の `app`（[Environment Secrets](./security/environment-secrets.md) §Vercel） | 無し                                                                                                                                  |
| GitHub Actions environment secrets（`production-release` / `production-ops` / `claude-review`）  | `ci` vault（`ciSecretSchema`）                                                                 | `scripts/__tests__/ci-secret-ledger.test.ts`（workflow が参照する名前と台帳の対応。値と、どの workflow も参照しない Secret は見ない） |
| GitHub Actions environment secrets（`Nonproduction login`）                                      | Integration 用・Preview 用の別 login item と `supabase-preview-provision` item                 | `scripts/runbook/setup-nonproduction-login.sh`（専用 Environment への同期。値は stdin 経由）                                          |
| Supabase Dashboard Secrets                                                                       | `agent/turnstile` など                                                                         | 無し                                                                                                                                  |
| PR Preview Branch credentials                                                                    | 1Password に保存しない（ephemeral。既知の例外）                                                | —                                                                                                                                     |
| `~/.config/gh-agent/hosts.yml`（開発機、0600）                                                   | `agent/github-agent`                                                                           | `pnpm agent:preflight` の gh identity 行（classic scope が見えたら警告）                                                              |
| `.claude/settings.local.json` の `env.OP_SERVICE_ACCOUNT_TOKEN`（開発機、0600、worktree へ複製） | `human` の SA token の控え                                                                     | `pnpm agent:preflight` の 1Password 行（有無だけ）                                                                                    |
| Claude Code cloud の environment 変数 `OP_SERVICE_ACCOUNT_TOKEN`                                 | `human` の SA token の控え                                                                     | 無し（cloud session で `op whoami` を実行して確かめる）                                                                               |

### 1Password に登録できない値（bootstrap 例外）

**Production 経路は 0 件**。GitHub Secrets の `SUPABASE_AUTH_AUDIT_TOKEN` / `SUPABASE_STORAGE_RLS_AUDIT_TOKEN` / `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB` はいずれも `ci` vault を master に持つ replica。Cloud Preview の例外は下の未初期化台帳を読む。

### Vercel Production の integration-managed 例外

Supabase と Vercel の Marketplace integration（slug: `supabase`）は、Production へ固定の env セットを自動で注入する。per-key の無効化はできず、同じ integration が Preview の Branch credentials 注入も担うため切断もできない。これらは **master を integration 自身とし、1Password には登録しない**。`scripts/tasks/env/check-vercel-replica.ts` の `allowedNonLedgerKeys` に理由付きで載せている（[#2094](https://github.com/Dayopt/dayopt/issues/2094) / [#2458](https://github.com/Dayopt/dayopt/issues/2458)）。

- 対象: `POSTGRES_*`（7 件）、`SUPABASE_JWT_SECRET`、`SUPABASE_ANON_KEY` など。削除しても integration が再注入する
- integration 管理の変数は Vercel Dashboard の env 一覧に出ない。由来の確認は `configurationId` を返す Vercel API を `key` / `type` / `configurationId` / `createdAt` に射影して行う（値は射影しない）
- `SUPABASE_SECRET_KEY` と `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` は runtime が使うため Production 台帳へ移した（#2517、[Supabase API keys の移行](./supabase-api-keys.md)）

### Cloud Preview の未初期化台帳（#2910）

`ci/preview-e2e` の3参照（`PREVIEW_E2E_SUPABASE_READINESS_TOKEN`、`PREVIEW_E2E_BYPASS_SECRET`、`PREVIEW_E2E_SUPABASE_KEY`）は **planned master** としてoptional/pendingを維持する。1Password item・master値の実在や同期を確認した証拠ではない。2026-09-29の作業で、ユーザーの明示指示により個人Vault・1Passwordを開かず、readiness tokenと選択したIntegration DB keyを `Preview – product` Environmentへ直接保存し、登録名をUIで確認した。Environmentのbranch policyは `integration` だけに保存・確認済み。値は会話へ出さない。

`PREVIEW_E2E_VERCEL_TOKEN` のplanned参照は廃止する。短寿命 `GITHUB_TOKEN` のdeployments/statuses read権限で、GitHubが認証したVercel botのProduct Preview記録を確認する。Production用 `VERCEL_TOKEN` のmaster・replica・release経路は変更しない。project-scoped Vercel tokenもProductのProductionを含むread/write権限を持つため、Preview用tokenとして新規発行しない。

Protection bypassは未保存・権限境界の判断待ち。project単位keyはProduct projectのProductionにも到達し得るため、非本番だけの資格情報とは呼ばない。専用project keyと対象Previewだけのshare方式のどちらを採用するか、所有者の判断後に対応する。既存Production bypassを複製しない。既存 `sync-ci-environment-secrets.sh` のProduction同期は実行しない。残る3参照は同scriptでplanned masterとの対応をpendingコメントに残し、実行対象に加えていない。masterを初期化済みにする判断は別途行う。

`PREVIEW_E2E_SUPABASE_READINESS_TOKEN` は **Development Branches Read**（`branching_development_read`）と **Migrations Read**（`database_migrations_read`）だけを持つfine-grained tokenとする。branch一覧と `GET /v1/projects/{ref}/database/migrations` のversion metadataを確認し、Database Data Read・SQL実行・write権限を与えない。project選択が親projectしか提供しない場合は親を選ぶため、親のbranch/migration metadataも読める境界になる。Productionのユーザーデータを読めるtokenではなく、非本番projectだけに限定したtokenとも呼ばない。親projectで選んだtokenが対象子projectのmigration一覧を読めることは別途実測し、401/403ではProduction credentialやSQLへのfallbackをせず停止する。[migration一覧の公式契約](https://supabase.com/docs/reference/api/v1-list-migration-history)に従い、versionの欠落・追加・重複・不正応答はreadiness失敗とする。

---

## 検証コマンド

いずれも secret の値・prefix・suffix・長さ・hash を表示しない。

```bash
pnpm env:check        # required env を OK / EMPTY / MISSING だけで確認する
pnpm secrets:check    # tracked files と untracked .env* を scan し、literal secret を [redacted] で報告する
pnpm 1password:check  # vault / item / field の実在と空の状態、有効期限、禁止 field の実在を確認する
pnpm replica:check    # Vercel Production Env の key 名だけを取得し、台帳に無い key を検出する
```

- **`secrets:check` と gitleaks は担当範囲が違う**。gitleaks は PR で新しく入った commit 範囲だけ、`secrets:check` は現在の tracked tree 全体を見る。片方だけでは main に既にある literal を誰も検出しない
- **`1password:check`**: `required: true` の entry か operational item が不足・空の時だけ失敗する。有効期限 field（`expires` 等）を読み、期限切れは `EXPIRED` で失敗、30 日以内は `EXPIRES_SOON` で警告する。`forbiddenFields` に登録した field が残っていれば `FORBIDDEN_PRESENT` で失敗する。確認できない応答は不在の証拠にせず `UNVERIFIABLE` で失敗する。そのため `forbiddenFields` に登録した item は実在し続ける必要があり、item ごと廃止する時は entry も外す。agent の SA で実行すると `human` / `ci` は `MISSING_VAULT` になるのが正しい
- **`replica:check`**: 日次 cron（`nightly.yml` の replica-check job）で実行する。手元での実行は `ci` vault を読むため User が行う。検出された key は、master へ登録して schema に足すか、Vercel から撤去する。台帳に無いが存在してよい key は `allowedNonLedgerKeys` に理由付きで載せる
- `.op-env.agent.example` の `op://` 参照は正規の injection schema なので leak として扱わない

### `1password:check` が失敗した時

失敗は「master に無い」ことしか意味しない。**schema を緩めて黙らせる前に、その env を誰が必要としているかを確かめる。**

- **本当の欠落**: code が要求していて、replica（Vercel Production Env / Supabase Dashboard）には値があり、master だけが無い。replica から master へ値を戻し、`required` は維持する
- **schema の乖離**: 機能が未有効などで item / field が無いのが正しい。`scripts/tasks/env/schema.ts` を `required: false` にする

「code が要求しているか」は build gate が正本。Sentry の 4 env は `packages/observability/build-gate.mjs` が product / web の Production build で必須にしているため、`human/sentry` と `human/sentry-web` は両方とも実在が要る。

master へ値を戻す時は GUI か、対象を限定した `op item create` / `op item edit` を使う。`scripts/runbook/setup-1password.sh` は 3 vault が空の時だけの初回 bootstrap 専用。`recovery` タグの item は既存情報の集約だけを行い、値の生成・再発行はしない。
