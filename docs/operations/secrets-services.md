---
status: current
last_verified: 2026-10-09
code:
  - scripts/tasks/env/schema.ts
  - scripts/tasks/agent-preflight.mjs
---

# Secrets のサービス別手順

サービスごとの発行・登録・確認・rotation の手順。守る境界は [secrets.md](./secrets.md)、item と replica の一覧は [secrets-ledger.md](./secrets-ledger.md) にある。agent が外部サービスを読む CLI 経路は `mcp-usage` skill（`.agents/skills/mcp-usage/SKILL.md`）が正本で、この文書はコマンドを複製しない。

各節はローカル（開発機の Claude Code）と cloud（Claude Code on the web）の差分を併記する。値を作る・入れ替える操作はすべて User が行う。agent は手順と確認コマンドを示すところまでを担う。

---

## 1Password（Service Account）

agent の `op` は、`agent` vault を read-only で読む Service Account（SA）の token で動く。入口は環境変数 `OP_SERVICE_ACCOUNT_TOKEN` 1 個で、`op` CLI はこの変数があれば SA で認証する。wrapper は置かない（[CLI 認証](https://www.1password.dev/service-accounts/use-with-1password-cli)）。

SA の権限は `agent` vault の `read_items` だけ。`write_items` / `share_items` / vault 作成 / Environments へのアクセスは付けない。権限と vault を変えるには SA を作り直す（[公式仕様](https://www.1password.dev/service-accounts/get-started)）。

### ローカル

置き場は repo の `.claude/settings.local.json` の `env`（gitignore 済み）。Claude Code の CLI と desktop の Code tab が同じ設定を読み、Bash tool の全コマンドへ渡る。desktop app は worktree を作る時にこの file を複製する。

```json
{
  "env": {
    "GH_CONFIG_DIR": "<絶対パス>/.config/gh-agent",
    "OP_SERVICE_ACCOUNT_TOKEN": "<1Password の human に控えた SA token>"
  }
}
```

設定は User が行う。token の値を agent・chat・コマンド引数に通さない。

1. 1Password app で SA token の控えを開いてコピーする。
2. main checkout の `.claude/settings.local.json` を editor で開き、`env` に追記して保存する。tracked の `.claude/settings.json` ではないことを `git status` で確かめる。
3. `chmod 600 .claude/settings.local.json` を実行する。
4. Claude Code の新しい session を開き、下の確認を実行させる。既存の session には届かない。

採らなかった置き場: `~/.claude/settings.json`（置き場が 2 つに分かれる）、repo の `.claude/settings.json`（tracked で public）、shell の login 環境（人間の terminal の `op` まで SA に変わる）、`launchctl setenv`（全 GUI app に届く）。

**新しい SA token を作ると、古い token を入れた場所はすべて認証に失敗する**。ローカルと cloud の両方を同時に入れ替える。

### Claude Code cloud

claude.ai/code の environment に次を設定する（[#3051](https://github.com/Dayopt/dayopt/issues/3051) で成立を確認、2026-10-09）。cloud の環境変数は session 内の全コマンドから読め、値はマスクされず、その environment を使える人は誰でも読める。SA token と fine-grained PAT 以外を置かない。

| 設定                  | 値                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment variables | `OP_SERVICE_ACCOUNT_TOKEN`（`ops_` で始まる値を引用符なしで）と `PATH=/opt/node24/node_modules/.bin:/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` |
| Network access        | Custom。既定のパッケージマネージャー一覧に加えて `*.1password.com`、`nodejs.org`、`registry.npmjs.org`                                                                            |
| Setup script          | 下記。Node 24、pnpm、1Password CLI を入れる。依存の install は repo の SessionStart hook が行う                                                                                   |

```bash
#!/bin/bash
exec > >(tee -a /tmp/dayopt-setup.log) 2>&1
set -u
log() { echo "[setup] $*"; }

npm install --prefix /opt/node24 --no-save node@24 && log "node24 $(/opt/node24/node_modules/.bin/node -v)" || log "Node 24 の導入に失敗"
for f in /root/.bashrc /home/user/.bashrc /etc/profile.d/node24.sh; do echo 'export PATH=/opt/node24/node_modules/.bin:$PATH' >> "$f" 2>/dev/null; done
export PATH=/opt/node24/node_modules/.bin:$PATH

npm install -g pnpm@11.26.0 >/dev/null 2>&1 && log "pnpm $(pnpm -v)" || log "pnpm の導入に失敗"

{
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg &&
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" > /etc/apt/sources.list.d/1password.list &&
  apt-get update -qq && apt-get install -y -qq 1password-cli >/dev/null && log "op $(op --version)"
} || log "1Password CLI の導入に失敗"

exit 0
```

設定でつまずく点:

- 値の欄に手順の目印 `<` `>` を残すと、`op` が token の形式不正（`failed to parseToken`）で失敗する
- setup script の欄は全部消してから貼る。古い script の残りが連結されると先頭行が壊れて失敗する
- `nodejs.org` からの直接取得と `npm i -g node@24` は失敗した。Node 24 は npm の `node@24` を `/opt/node24` に置く
- pnpm は Corepack ではなく npm で版を固定する。setup script は repo の外で動くので、Corepack は `packageManager` を読めない

### 確認

値を出さずに、identity と読める vault の範囲を確かめる。ローカルと cloud で同じ。

```bash
op whoami                # User Type: SERVICE_ACCOUNT
op vault list            # agent の 1 件だけ
pnpm 1password:check     # human / ci は MISSING_VAULT になるのが正しい
pnpm agent:preflight     # 1Password 行が「OP_SERVICE_ACCOUNT_TOKEN あり」
```

`op run --env-file=.op-env.agent` で `op://agent/...` が解決されることも確かめる。解決後の環境変数をそのまま出力しない。

### rotation

- `op whoami` の Integration ID は token ごとに変わる。ID を設定や docs に固定しない
- 新しい token を `human` の控え、`.claude/settings.local.json` の `env`、cloud の environment 変数へ入れ替え、上の確認を実行する
- 旧 token は 1Password の管理画面で revoke する

### local dev の env-file

ローカル開発の正規ルートは `.op-env.agent` と `op run`。`.op-env.agent` には `op://` 参照だけを書き、実値・dummy・placeholder は書かない。

```bash
cp .op-env.agent.example .op-env.agent
pnpm dev
```

- `pnpm dev` は `.env.local` 系が残っていると fail する。Supabase は local を参照し、停止中なら起動して `supabase status -o env` の URL / key を値を表示せずに注入する。接続先を 1Password 参照へ切り替える手段は無い。Docker 無しで動かす時は env を明示して渡す `pnpm dev:raw` を使う
- `.op-env.agent.example` から参照を消しても、各自の `.op-env.agent` は追従しない。解決できない `op://` があると `op run` は起動前に失敗するので、`cp` で作り直す
- `.op-env.human` は `human` を参照する管理者用の env-file。agent の SA では解決されない。使い方は [Supabase の管理者 script](#管理者-scriptadmin-sh) を読む

### `op` CLI の罠

- **`op item get`（`--reveal` なし）でも notes の複数行はそのまま出る**。recovery codes を 2 回会話ログへ露出させた。field 名だけを見る時は field 行だけを通し、値の有無は `pnpm 1password:check` で確かめる
- **`op item get --format=json` は `--reveal` の有無に関わらず concealed field の実値を含める**。存在確認は既定の表示形式で `op item get <item> --vault <vault> --fields <field>` を使う。vault は `--vault` で指定し、`<vault>/<item>` の形は使えない
- **`op item create` / `op item edit` の stdout は item の内容を出す**。必ず `>/dev/null` にする。実値を引数に直接書くと会話ログとシェル履歴に残るので、値の投入は 1Password GUI で行う。書き込み直後の読み取りは数秒間不安定
- **日本語ロケールの「API Credential」item は標準 field の内部 id が `credential`**。同名の field を足すと `more than one credential field` で参照が壊れる。User へは「標準の『認証情報』欄に値を入れる」と伝える
- **`op whoami` や `supabase projects list` の失敗だけで「経路が無い」と判断しない**。token の権限不足でも失敗する。経路の有無は `mcp-usage` skill の経路表で確かめる

---

## GitHub

### agent の identity（fine-grained PAT）

agent の `gh` と git push（credential helper は `gh auth git-credential`）は、User 本人の OAuth token ではなく **Dayopt/dayopt repo だけに効く fine-grained PAT** で動く。token の scope に無い操作（ruleset 変更・Secret 上書き・repo 削除）を構造的にできなくするのが目的。User の terminal の `gh`（keyring）は変えない。

- **identity の分け方**: `GH_CONFIG_DIR` で config dir を分ける。User は既定（`~/.config/gh`、keyring）、agent は `~/.config/gh-agent`（plaintext `hosts.yml`、0600）。keyring は同じ account の 2 token を持てないので、agent 側だけ `--insecure-storage` を使う。この file は replica で、master は `agent/github-agent`
- **PAT の権限（これ以外は No access）**: Resource owner = Dayopt org、Only select repositories = dayopt、有効期限 1 年。Repository permissions は Actions R / Commit statuses R / Contents RW / Issues RW / Metadata R / Pull requests RW。`Administration` / `Secrets` / `Environments` は付けない
- **workflow ファイルの push**: この設定では `.github/workflows/` を変える push は拒否されるはずで、2026-09-14 には拒否された（PR #2761）。2026-10-09 には agent の token で workflow 変更の push が通った（[#3060](https://github.com/Dayopt/dayopt/issues/3060)）。PAT の現在の権限は未確認で、User が GitHub の PAT 設定で Workflows 権限の有無を確かめる。workflow は `GITHUB_TOKEN` の権限と secret の配布先を決めるので、Workflows 権限を付けるかは User が判断する
- **`gh` が 403 / `Resource not accessible` を返したら scope 外**。User へ依頼する

発行と登録（User の GUI / terminal。値は表示しない）:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → Generate（上記の権限）。Dayopt org 側で fine-grained PAT が許可されているか確かめる。
2. 1Password GUI で vault `agent` に API Credential item `github-agent` を作り、`credential` に値、`expires` に期限を入れ、タグ `dayopt/github` を付ける。
3. `mkdir -p ~/.config/gh-agent && chmod 700 ~/.config/gh-agent`
4. `op read "op://agent/github-agent/credential" | GH_CONFIG_DIR=~/.config/gh-agent gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage`（pipe で渡すので値は表示されない。agent の Bash tool では `op read` が止まるので User の terminal で行う）
5. agent の session へ `GH_CONFIG_DIR=<絶対パス>/.config/gh-agent` を渡す。置き場は `.claude/settings.local.json` の `env`。

確認: agent の session で `gh auth status` に `admin:org` / `delete_repo` が出ないこと、`gh api repos/Dayopt/dayopt/rulesets` が読めること、`gh api orgs/Dayopt/actions/secrets` が 403 / 404 になること。`pnpm agent:preflight` の gh identity 行は classic scope を検出すると警告する。

rotation: 新 PAT を発行して 1Password を更新し、手順 4 を再実行する。GitHub の token 一覧で新 token の Last used が更新されたことを確かめてから旧 PAT を revoke する。

**cloud**: `gh` は導入済みで、GitHub の proxy が認証する。2026-10-09 の計測で REST（`gh api`）と GraphQL（`gh pr view`）がともに通り、branch push もできた（#3051）。PAT を `GH_TOKEN` として environment に置くかは未決定で、置く場合も上の PAT 以外は置かない。

### GitHub Actions の Secret

GitHub Actions Secrets は CI の replica。**Secret は repo 単位ではなく environment に置く**。repo 単位の Secret は、同じ repo の任意の branch に workflow を足すだけで読める。environment の deployment branch policy を `main` だけにすると、他 branch の workflow は `environment:` を宣言しても secrets を受け取れない。

| environment          | 使う job                                                                                                 | Secret                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `production-release` | `promote.yml` の impact / release                                                                        | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_AUTOMATION_BYPASS_PRODUCT`, `VERCEL_AUTOMATION_BYPASS_WEB`                                                          |
| `production-ops`     | `production-config-audit.yml` の Vercel / Supabase 監査、`nightly.yml` の replica check / Storage backup | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `SUPABASE_AUTH_AUDIT_TOKEN`, `SUPABASE_STORAGE_RLS_AUDIT_TOKEN`, `RCLONE_CONFIG_SOURCE_*`（6）, `RCLONE_CONFIG_DEST_*`（6） |
| `claude-review`      | `claude-review.yml` の review job（PR へ書き込む post job には渡さない）                                 | `ANTHROPIC_API_KEY`                                                                                                                                          |

- **deployment 記録は作らない**: release job 以外は `environment: { name, deployment: false }` で宣言する。branch policy は `deployment: false` でも効く
- **`pull_request_target` と `schedule`** は default branch の ref で policy が評価されるので通る。`workflow_dispatch` を `main` 以外の ref で起動すると environment が拒否する
- **同期**: `scripts/runbook/sync-ci-environment-secrets.sh` を User の terminal で実行する（既定 dry-run、`--execute` で反映、`--only <Secret 名>` で 1 つだけ）。値は `op read` から `gh secret set --env` へ pipe で渡す。rotation 時はこの script の `--only` で該当 Secret を同期する
- Migration は Supabase の GitHub integration が担当するので、GitHub Actions から `supabase db push` しない

#### 非本番ログイン準備（#2910）

`Nonproduction login`はIntegrationとPRごとの専用Preview branchにAuthユーザーを準備する専用Environment。許可branchは `main` と `integration`。Integration用の `NONPROD_LOGIN_EMAIL` / `NONPROD_LOGIN_PASSWORD` は既存のIntegration項目から、Preview用の `NONPROD_PREVIEW_LOGIN_EMAIL` / `NONPROD_PREVIEW_LOGIN_PASSWORD` はowner指定の専用Preview項目から同期する。Provisionerは検証済みtargetに対応する組だけを使う。候補コードにはどちらのsecretも渡さない。対象nonproduction branchのManagement API keyを読むための `SUPABASE_PREVIEW_PROVISION_TOKEN` も登録する。このtokenにはSupabase `Development Branches: Read`、`API Keys: Read`、`API Key Secrets: Read` が必要。Productionでは使わず、既存の `Preview – product` Environmentも変更しない。

1Passwordを正本としてGitHub Environmentの暗号化secretsへ必要分だけ同期する。最初にGitHub Settingsで空の `Nonproduction login` Environmentを作り、deployment branch policyを `main` と `integration` のみにする。次にSupabase Dashboard `/account/tokens` でScoped Management PATを発行し、上記3権限だけを付与する。resource scopeはまず親dayopt projectを指定し、権限エラーとなった場合だけ必要なbranch scopeへ広げる。Classic full-access tokenは使わない。発行したPATは1Password item `supabase-preview-provision` の `credential` fieldへ保存する。通常は `ci` vaultを使い、別vaultに保存する場合はownerがそのVault IDを `NONPROD_LOGIN_PROVISION_VAULT_ID` で指定する。値やVault IDを会話・ログへ貼らない。

1Password startup checkが通る環境で、ownerが管理するログインVault IDを `NONPROD_LOGIN_VAULT_ID` に設定して `scripts/runbook/setup-nonproduction-login.sh --execute` を実行する。既定はdry-run。scriptはIntegration用とPreview用のitemを分けて読み、全5値をGitHubへ書く前に空でないことを確認する。branch policyに `main` / `integration` 以外があれば停止する。値はprocess memoryとstdinだけを通り、一時ファイル、argv、ログへ保存しない。1Password read失敗時は固定メッセージで停止し、GitHub secretsを書かない。GitHub側の途中失敗は手動で再実行する。workspace外から実行する場合もstartup checkは必須で、owner端末上の承認済みchecker pathを `OP_STARTUP_CHECK` で指定する。

workflow は `supabase/` を変更した PR でだけ自動で準備する。Integration は trusted Integration ref から手動 dispatch できる。候補 PR のコードは credentials 付き job で checkout / 実行しない。Auth password grant の確認とは別に、アプリ UI の実ログイン、redirect、CRUD を確かめる。

---

## Supabase

### agent の読み取り token

agent は production Supabase を `agent/supabase-agent` の scoped token だけで読む。`human/supabase-cli` は Auth config の write を含むため agent に渡さない。読み取りの経路（read-only SELECT の helper、Auth config の safe-get、advisors）は `mcp-usage` skill の Supabase cloud 節が正本。

発行（User。Supabase Dashboard → Account → Access Tokens）:

- **Management API の scoped access token（`sbp_` で始まる）は Account の Access Tokens ページで発行する**。Project の Settings → API Keys（`sb_sec` で始まる Data API 用の key）とは別物で、Management API には使えない
- 有効期限 90 日、対象 project は production だけ。権限は Database / Migrations / Advisors / Logs / Auth config / Edge Functions の read だけを選ぶ。**Write 系、Secrets、API keys、Branches は付けない**（API keys と Branches は credential を返す）
- 値は 1Password GUI で `agent/supabase-agent` の `credential` に入れ、`expires` に期限を書く。期限切れは読み取りの 401 で表面化する

Database read は table 単位に絞れず、`auth.users` などの個人情報も読める。agent は個人情報を含む行を User の明示指示がある時だけ読む。schema・件数・policy・advisor は自律で読んでよい。

**cloud**: Network access の Custom に Supabase の API host を足した上で、ローカルと同じ token を `op run` で解決する。cloud からの到達は未実測。

### Management API の設定読み取り

`config/*` と `branches*` のレスポンスは secret を含みうる。`curl` / `wget` でこれらへ直接アクセスする操作は guard が止める。Auth config の読み取りは `scripts/agent/supabase-mgmt-safe-get.mjs` を使う（使い方は `mcp-usage` skill）。

- field の allowlist は `production-auth-config-audit.mjs` の `AUTH_CONFIG_CONTRACT` から派生し、`redact: 'url'` の entry は除く。allowlist 外の field を 1 つでも含む要求は全体を拒否する
- wrapper が扱うのは `config/auth` の boolean / enum だけ。`config/database` などは未対応で、必要になった時に subcommand を足す。それまでは User が Dashboard で確かめる
- `branches` は wrapper を作らない。`branches get` が返す credential に安全な部分集合が無いため

### 管理者 script（admin-\*.sh）

`scripts/runbook/admin-*.sh` は Supabase Auth Admin API を service role で叩き、dogfooding / 内部テスト用の account を CLI から操作する。通常の signup / login flow を bypass したい時だけ使う。共通の env チェックと auth header 生成は `scripts/runbook/admin-common.sh` にある。

**実行は production への操作**で、User が自分の terminal で行う。agent の SA は `human` を読めないので、agent からは実行できない。

```bash
cp .op-env.human.example .op-env.human   # 初回だけ
op run --env-file=.op-env.human -- \
  env USER_EMAIL=foo@example.com \
  bash scripts/runbook/admin-show-user.sh
```

- `.op-env.human` は `human/supabase` を参照する。通常の `pnpm dev` に production の service role key を混ぜず、「staging のつもりで production を触る」を防ぐために env-file を分けている。用が済んだら削除する
- 雛形は接続 3 field に加えて `SUPABASE_DB_PASSWORD` を持つ。`USE_LINKED_DB=true` の `seed-dev-data.sh` が最後に `supabase db query --linked` を実行するため。欠けると Auth API での user 作成だけ成功し、既知 password の user が production に残る
- **書き換え・削除をする script は対象の打ち返しを要求する**。`admin-delete-user.sh` / `admin-set-user-password.sh` / `enable-auth-hook.sh` / `USE_LINKED_DB=true` の `seed-dev-data.sh` / `pnpm db:reset-linked:unsafe` は、操作対象から導いた project ref を `DAYOPT_CONFIRM_TARGET` に渡さない限りネットワークへ出る前に止まる。止まった時のメッセージに対象 ref が出るので、確かめてから付けて再実行する。正本は `scripts/tasks/confirm-target.sh`、契約は `scripts/__tests__/confirm-target.test.ts`
- local の Supabase を対象にする時は `supabase status -o env` の値を `env` で直接渡す
- 実行したら、何を誰に対して実行したかを Issue か PR に残す

| script                        | 用途                                                                                                                                                                           | 必須 env                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `admin-create-user.sh`        | email + password で user を新規作成（即 login 可能）                                                                                                                           | `USER_EMAIL`, `PASSWORD_ITEM_ID`                                                                     |
| `admin-delete-user.sh`        | user を hard delete（関連 row も CASCADE 削除）                                                                                                                                | `USER_EMAIL`, `DAYOPT_CONFIRM_TARGET`                                                                |
| `admin-ensure-profile.sh`     | trigger 未発火時に `profiles` row を手動 upsert                                                                                                                                | `USER_EMAIL`                                                                                         |
| `admin-generate-magiclink.sh` | captcha / UI form の bug を bypass する magic link を発行                                                                                                                      | `USER_EMAIL`                                                                                         |
| `admin-set-user-password.sh`  | 既存 user の password を上書きし email 確認済みにする                                                                                                                          | `USER_EMAIL`, `PASSWORD_ITEM_ID`, `DAYOPT_CONFIRM_TARGET`                                            |
| `admin-show-user.sh`          | email から `auth.users` の状態を表示（read-only）                                                                                                                              | `USER_EMAIL`                                                                                         |
| `verify-login.sh`             | email + password で `/auth/v1/token` を叩き login 可否を確認（read-only）                                                                                                      | `USER_EMAIL`, `PASSWORD_ITEM_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `enable-auth-hook.sh`         | Production の `custom_access_token` hook を有効化する。**現在は実行しない**（[#1946](https://github.com/Dayopt/dayopt/issues/1946)）。実行してよい条件は script のヘッダが正本 | `SUPABASE_ACCESS_TOKEN`, `DAYOPT_CONFIRM_TARGET`                                                     |

`PASSWORD_ITEM_ID` は password を保存した 1Password item の ID。`verify-login.sh` が成功すれば password は正しい（UI / CSP / form 側の問題）。失敗すれば `admin-set-user-password.sh` で再設定する。

### Dashboard Secrets

Supabase Auth の Bot Protection、Auth hooks、Edge Functions、Vault secrets は Dashboard 側の replica。Turnstile secret などは 1Password から値をコピーし、Dashboard だけで変えない。`SENTRY_DSN`（Edge Function `send-auth-email` 用、任意）も同じ経路で、未投入なら Sentry capture は no-op になる。

production の Auth `uri_allow_list` に localhost を入れない。local dev の redirect は `supabase/config.toml`、Preview は Preview Branch がそれぞれ持つ。

`google-auth` は Supabase Auth の Google provider 用で、アプリの env には入らず Dashboard だけが replica になる。redirect URI は production Supabase の `/auth/v1/callback` 1 本だけ。

---

## Sentry

- **agent の読み取り**: `agent/sentry-cli-readonly` の read scope の token を使う。コマンドは `mcp-usage` skill が正本。CLI 名は `sentry` で、`sentry-cli` は source map upload 用の別物。`sentry auth status` は token の一部を表示するので使わず、疎通は `sentry org list` で確かめる
- **build**: source map upload の token は `ci/sentry-release-token` が master で、product / web の Vercel Production target へ Sensitive replica として同期する
- **runtime**: Sentry の runtime と source map upload は Production 限定。local の `.op-env.agent`、GitHub Actions、Vercel Preview / Development に Sentry env を複製しない。product と web は同じ env 名で、`human/sentry` と `human/sentry-web` の値を Production target だけへ同期する

**cloud**: Network access の Custom に Sentry の host を足した上で、ローカルと同じ経路を使う。cloud からの到達は未実測。

---

## Vercel

agent は Vercel の資格情報を持たない。Vercel の token は scope を project の Production / Preview で分けられず、本人 login は team の全権を持つため、agent vault の条件に合わない。

- **読み取りの代替**: deployment の状態と Preview URL は GitHub の deployment status で読む（経路は `mcp-usage` skill）。Preview は Vercel の SSO で保護され、bypass secret は `ci` vault にだけあるので、agent は Preview の画面を直接開けない。表示は CI の smoke / E2E の結果か、User が sign-in した内蔵 Browser で確かめる
- **User が行うもの**: production の env 変更、promote / rollback の手動実行、domain / cert、project 設定。本人 login は User の terminal でだけ使い、作業後に logout する
- **Production Env の同期**: 1Password を先に更新し、必要な値だけ Vercel Dashboard へ同期する。Vercel 側で値を変えたら同じ変更を 1Password に戻す。Preview の Supabase env は Supabase の integration が注入するので、Preview scope に production の Supabase credentials を手で入れない
- **問い合わせ送信の credential**: `RESEND_API_KEY` / `RESEND_FROM_EMAIL` と app 別の `RESEND_WEBHOOK_SECRET` は product / web の Production だけへ同期する。metadata は `scripts/ci/production-config-audit.mjs` が key / target / type だけ確認する

### `vercel env pull`（一時用途だけ）

`vercel env pull` は通常の local dev flow ではない。一時的な調査・復旧に限り、User が行う。

```bash
pnpm vercel:env:pull:unsafe
```

生成された `.env.local` は実値を含みうる。agent は読まず、作業後に削除する。内容を terminal、chat、issue、docs に貼らない。

---

## Stripe

- local dev は `agent/stripe-test`（test mode）を `.op-env.agent` から使う。live mode の key は `human/stripe-live` にだけ置く
- agent が Stripe API を読む read-only 経路は未確認（`agent/stripe-test` は local dev 用で API 呼び出しには使わない）。経路の状態は `mcp-usage` skill の経路表を読む
- Integration で Stripe を使う時は test 用の一式を設定し、account ID も専用のテスト資源に限る

---

## Google

- **Supabase Auth の Google provider**（ソーシャルログイン）は `human/google-auth`。Dashboard だけが replica
- **外部カレンダー取り込み**（[#1702](https://github.com/Dayopt/dayopt/issues/1702)）は別の OAuth client で、Supabase 側の client secret を流用しない。`GOOGLE_CALENDAR_PROJECT_NUMBER` は client ID の先頭の project number と一致させる。Preview は登録しない（ephemeral hostname を Google に事前登録できず、`__Host-` cookie も host 固定のため、接続開始時に明示エラーを返す）
- local dev で外部カレンダー連携を確かめるには、test mode の OAuth client を作って `agent/google-calendar` item を作る（User 作業）

---

## 問い合わせ送信 / Bot 対策

- Cloudflare Turnstile が正。`NEXT_PUBLIC_TURNSTILE_SITE_KEY` は app / web の browser 側、`TURNSTILE_SECRET_KEY` は web の contact form と Supabase Dashboard の replica で使う。reCAPTCHA の env は新規に足さない
- product / web の問い合わせは Production だけ Resend へ送る。From / To / 件名は server 固定、送信者の email は Reply-To にだけ使い、app 別の webhook 署名 secret を共用しない。Gmail の返信は `resend-support-replies` の専用 SMTP key だけを使う。運用は [問い合わせメール](./contact-email.md)

---

## 変更とローテーション

値を変える手順（User）:

1. 1Password の master を更新する。
2. 必要な長寿命 replica（Vercel Production Env / GitHub Secrets / Supabase Dashboard）へ同期する。
3. 値を表示せずに存在を確かめる（`pnpm 1password:check`、既定表示の `op item get`）。
4. 旧 key を発行元サービスで revoke する。
5. docs / PR には field 名と同期先だけを書く。

既存 vault への item / field の追加は GUI か、対象を限定した `op item create` / `op item edit` で行い、`pnpm 1password:check` で確かめてから replica へ同期する。`scripts/runbook/setup-1password.sh` は 3 vault が空の時だけの初回 bootstrap 専用。

### 期限付き token の再発行

scope を切れるサービスでは permission を最小にし、期限を付けて発行する。scope を切れない場合も期限を付けて、漏洩時の被害期間に上限を作る。

1. 新しい token を期限付き（可能なら最小 permission）で発行する。値は表示・記録しない。
2. 1Password の master を新しい値へ更新する。実値を引数に直接書かない。
3. 全消費者が新しい token で動くことを確かめる。参照は item / field 名なので、通常は値の差し替えだけで反映される。
4. **発行元の「Last used」が更新されたことを確かめてから**旧 token を revoke する。疎通の 200 は、ローカルに古い値が残っていると旧 token で返るので証拠にしない。
5. 旧 token を revoke する。

期限の自動リマインダーは無い。`pnpm 1password:check` の `EXPIRES_SOON` と月次の gardening で期限の近い token を拾う。
