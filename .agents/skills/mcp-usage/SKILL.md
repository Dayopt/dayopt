---
name: mcp-usage
description: 外部サービス（Sentry / Supabase / GitHub / Vercel / UptimeRobot / Eagle / Storybook / Context7）へ CLI・MCP でアクセスする時に発動。サービス別の CLI 経路表・認証（agent vault の item）・read-only 境界・MCP を使う例外（context7 と dayopt 自身）を適用する。MCP 定義の追加・削除（global 設定変更）や通常の実装作業では発動しない。
---

# 外部サービスへの経路（CLI-first）

この skill が外部サービス別の経路表の**唯一の正本**。docs はここへリンクし、コマンドを複製しない（#3054、親 Mission #3050）。

## 原則

1. **CLI-first**。MCP は `context7` と dayopt 自身の MCP コネクタだけ。他のサービスの MCP は登録しない（登録・解除の手順も持たない）。
2. 認証は agent vault の scoped read-only token を `op run` で env に解決する。token は平文でコマンドラインにも設定ファイルにも置かない。`op read` / `--reveal` で値を出さない。`--no-masking` は付けない。
3. 推測より確認。version 依存の API は context7、障害は Sentry、deploy 状態は GitHub で裏を取ってから答える。

repo 側に MCP 定義や認証情報を置かない（同名定義が user-global とマージされ MCP 全体が起動不能になる）。MCP 定義は user-global（Claude は `~/.claude.json`）の個人設定で、変更は User 作業。

## 経路表（実測 2026-10-09）

| サービス       | CLI / 経路                                                                                                                                                                            | 認証（agent vault）                                   | read-only                                                            | 実測                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sentry         | `SENTRY_AUTH_TOKEN="op://agent/sentry-cli-readonly/credential" op run -- sentry <cmd>`。`org list` / `issue list dayopt/` / `issue view <id>` / `issue explain <id>` / `release list` | `sentry-cli-readonly`                                 | 可（read scope のみ）                                                | `org list` で dayopt org を取得 OK                                                                                                |
| Supabase local | `pnpm exec supabase status` / `pnpm types:generate` / psql。要 Docker                                                                                                                 | 不要                                                  | local のみ                                                           | 未実測（この環境は Docker 無し）                                                                                                  |
| Supabase cloud | 下記「Supabase cloud」の repo script。`supabase` CLI は token の権限不足で使えない行が多い                                                                                            | `supabase-agent`（`credential`、90 日期限）           | 可（read 権限のみ）                                                  | `supabase-mgmt-safe-get.mjs auth-config` OK。`supabase projects list` は 403（`projects_read` 無し）、`branches list` も 403      |
| GitHub         | `gh pr` / `gh issue` / `gh api`（`--json` + `--jq` で絞る）                                                                                                                           | `github-agent`（`GH_CONFIG_DIR` の fine-grained PAT） | scope 内のみ（ruleset・Secret・org 設定・workflow push は scope 外） | `gh api repos/Dayopt/dayopt/deployments --jq length` で 30                                                                        |
| Vercel         | `gh api repos/Dayopt/dayopt/deployments` と deployment statuses、PR の checks に出る Preview URL。**agent に Vercel token は渡さない**（2026-09-14 決定を維持）                       | なし                                                  | 可                                                                   | gh deployments OK。`vercel` CLI は User の個人 login で現状まだ動くが、#3053 で外す予定なので依存しない                           |
| UptimeRobot    | REST v3 `GET https://api.uptimerobot.com/v3/monitors`（Bearer、Read-only key は `get*` のみ可）。key は `~/.claude/scripts/uptimerobot-headers.sh` が `op read` で解決する            | `UptimeRobot Read-only API Key`（agent）              | 可                                                                   | 未実測（curl は承認が要るため）。無ければ Dashboard とメール通知                                                                  |
| Eagle          | `POST http://127.0.0.1:41596/api/tools/call` に `{"tool":"…","params":{…}}`（**キーは `params`**）                                                                                    | 不要（ローカル app）                                  | 読み取り系 tool のみ使う                                             | `ai_search_status` が `ready`。app 起動時のみ                                                                                     |
| Storybook      | MCP は使わない。`pnpm storybook`（dev）/ `pnpm build-storybook` / `pnpm test-storybook`                                                                                               | 不要                                                  | 可                                                                   | script の存在のみ確認。MCP は local 限定で未登録のため廃止                                                                        |
| Stripe         | `stripe` CLI 1.37.4 は導入済み                                                                                                                                                        | 未確認                                                | 未確認                                                               | agent vault に restricted test key が無い。read-only 経路は未確認（`agent/stripe-test` は local dev 用で API 呼び出しに使わない） |

### Supabase cloud

- production への読み取り SELECT: `op run` で `SUPABASE_ACCESS_TOKEN` を解決し、`scripts/lib/production-db-readonly.mjs`（`runReadOnlyQuery`、`read_only: true` 固定）を使う。呼び出し例は `scripts/ci/production-schema-drift-audit.mjs` など。
- Auth config: `SUPABASE_ACCESS_TOKEN="op://agent/supabase-agent/credential" op run -- node scripts/agent/supabase-mgmt-safe-get.mjs auth-config <field>…`（allowlist 内の field だけ）。`curl` での直叩きは guard が block する。
- advisors: `supabase` CLI にコマンドは無い。Management API の advisors 読み取りを使うか、User に Dashboard の Security Advisor 確認を依頼する（`docs/operations/security.md` の定期確認）。
- migration・write は cloud から行わない。`supabase` skill の既存フロー（local → PR Preview → production）に従う。
- token の発行・ローテーションは User 作業（`docs/operations/secrets-services.md` §Supabase）。

## MCP（例外）

- **context7**: 常時使う。`resolve-library-id` → `query-docs` の順。Next.js / React / tRPC / Supabase client など version 固有の API は記憶で答えず一次資料で確かめる。
- **dayopt 自身の MCP コネクタ**: dayopt の MCP 機能を自分で確かめる時だけ。claude.ai コネクタも dayopt 自身に限って許す。他サービスのコネクタは使わない。

## 絶対ルール

- Read-only を守る。write 系（`sentry issue resolve`、cloud DB 書き込み、monitor の変更、Eagle のアイテム削除・trash 移動）は agent から行わない。必要なら User の terminal か Dashboard に依頼する。
- `auth.users` など個人情報を含む行は User の明示指示がある時だけ読む。schema・件数・policy は自律で読んでよい。
- token・key の値を出力・ログ・commit・PR 本文に残さない。新しい token の発行と agent vault への item 追加は User 作業として列挙して止める。
- `sentry-cli`（sourcemap upload 用の build tool）と `sentry`（閲覧用 CLI）は別物。
- 「再現できますか？」と User に尋ねる前に Sentry で対象 issue を探す。本番 deploy 直後は Sentry でエラー増加を確認する。
- UptimeRobot の API 出力を根拠に監視設定を変更しない。rate limit は Free plan で 10 req/min。確認順は Sentry → UptimeRobot → GitHub deployments。
- Eagle は参考事例・素材探し用。実装の見た目の確認は Storybook が正。
- ブラウザ操作は現在の runtime のブラウザ機能を使い、認証済み session が要る検証は既存の E2E harness（`apps/product/src/lib/test/e2e/create-scoped-test-user.ts`）を使う。
