---
status: current
last_verified: 2026-10-09
code: scripts/tasks/env/schema.ts
---

# Secrets の境界

Dayopt の secret をどこに置き、誰が何に届くかの契約。この 1 ページが正本で、手順は [サービス別手順](./secrets-services.md)、item と replica の一覧は [台帳](./secrets-ledger.md) にある。決定の経緯は [decisions.md](../decisions.md) と git 履歴に任せ、ここには現在の境界だけを書く。

## 基本方針

1. **1Password が master**。secret・token・recovery 情報・接続情報は 1Password を正とする。値がどこにあっても 1Password にもある。replica にしか無い値を作らない（例外は PR Preview Branch credentials と Supabase の integration が注入する値だけ。[台帳](./secrets-ledger.md#replica-台帳)）
2. **外部環境は replica**。Vercel・GitHub Actions・Supabase Dashboard・開発機の設定ファイル・Claude Code cloud の environment は 1Password から同期する複製
3. **ローカルに実値を置かない**。repo に置くのは `op://` 参照だけ（`.op-env.agent` / `.op-env.human`）。`.env.local` に実値を置く運用は廃止した
4. **値を表示しない**。確認は存在だけにし、secret 本体を terminal・docs・Issue・PR・chat に出さない
5. **境界は token の到達範囲で作る**。agent に渡す資格情報は、漏れても rotate すれば戻せるもの（read-only か非本番 scope）だけにする。本番の書き込みは、agent が token を持たないのでできない状態にする。hook の正規表現で権限を作らない

## Vault は読み手で分ける 3 箱

| vault   | 読み手                                      | 中身                                                                                       |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `agent` | agent（Service Account、read-only）         | test mode の credential、local dev の app 設定、agent の read-only token                   |
| `human` | User だけ                                   | 本番 secret、login / SSH / recovery、管理者 script の接続情報、agent の SA token の控え    |
| `ci`    | 同期作業をする User（CI は replica を読む） | GitHub Actions の Secret の master、Vercel の automation token、source map upload の token |

環境の区別（test / live など）は item 名とタグで行い、vault では分けない。

## Agent の identity

agent が持つ資格情報はこの表の 4 つだけ。どれも read-only か、範囲を Dayopt/dayopt repo に絞ったもの。

| サービス  | 資格情報                                            | 届く範囲                                                        | 手順                                                        |
| --------- | --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| 1Password | Service Account token（`OP_SERVICE_ACCOUNT_TOKEN`） | `agent` vault の read だけ                                      | [1Password](./secrets-services.md#1passwordservice-account) |
| GitHub    | fine-grained PAT（`GH_CONFIG_DIR` の replica）      | Dayopt/dayopt の Contents / Issues / Pull requests の RW など   | [GitHub](./secrets-services.md#github)                      |
| Supabase  | `agent/supabase-agent`（scoped token、90 日期限）   | production の read だけ（Database / Auth config / Advisors 等） | [Supabase](./secrets-services.md#supabase)                  |
| Sentry    | `agent/sentry-cli-readonly`                         | org `dayopt` の read scope だけ                                 | [Sentry](./secrets-services.md#sentry)                      |

**agent に渡さないもの**: Vercel の token と本人 login、Resend の送信 key、Anthropic の key、Supabase の Management API token（write を含む）、`human` / `ci` vault。外部サービスへの CLI 経路は `mcp-usage` skill が正本。

## Service Account

agent の 1Password は **`agent` vault を read-only で読む Service Account（SA）だけ**を使う。入口は環境変数 `OP_SERVICE_ACCOUNT_TOKEN` 1 個で、ローカル（repo の `.claude/settings.local.json` の `env`）も Claude Code cloud（environment の変数）も同じ名前で渡す。wrapper や Keychain を経由しない。手順は [1Password](./secrets-services.md#1passwordservice-account)。

- 同じ OS ユーザーで動く以上、Mac の人間用アプリ・ブラウザー・ファイルへの到達は閉じない。それを前提に、`agent` vault には漏れても困らない値だけを置く
- `OP_SERVICE_ACCOUNT_TOKEN` を外して `op` を呼ぶと、1Password app の人間用 CLI 連携に落ちうる。agent は token を外した `op` を実行せず、承認プロンプトが出ても User は承認しない
- token を持つ process とその子 process は token を読める。第三者 PR の test / build や依存の install script を未信頼コードとして走らせる時は、token の無い環境で実行する
- cloud の environment 変数はマスクされず、その environment を使える人は誰でも読める。SA token と fine-grained PAT 以外を置かない

## env ファイルの境界

| ファイル                                                                                                                       | agent                  | 理由                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| `.op-env.agent` / `.op-env.agent.example`                                                                                      | 読み書きしてよい       | 中身は `op://` 参照だけ。変数一覧の正本は `scripts/tasks/env/schema.ts`                 |
| `.op-env.human` / `.op-env.human.example`                                                                                      | 読み書きしてよい       | 中身は `op://` 参照だけ。`human` は SA で解決されないので、消費は User の明示操作になる |
| `.env` / `.env.local` / `.env.*.local` / `.env.development` / `.env.staging` / `.env.production` / `.envrc` / `supabase/.env*` | **読みも書きもしない** | `vercel env pull` などで実値入りで生成されうる。読むと実値が会話ログに載る              |

secret の利用は制限しない。agent は `op run` 経由で値を見ずに secret を使う。

## 値を表示しない操作

- **設定系 API の GET レスポンスをそのまま表示しない**。Vercel Env API・Stripe API などは `jq` で必要な field だけに射影する。`*_secret` / `*_key` / `*_token` / `*password*` を含む key は射影に入れない。値が credential になりえない boolean / enum の flag に限り、key 名を 1 つずつ列挙して例外にする。構造が不明なら先に `jq 'if type == "object" then keys else type end'` で key だけを見る（素の `jq 'keys'` は scalar の時に値を stderr へ出す）
- **1Password の実値を出す使い方をしない**。`op read`、`op item get --reveal`、`op item get --format=json` は値を出す。実値が要る操作は `op run` か、User の terminal で行う
- Supabase Management API の `config/*` と `branches*` は `curl` で直接叩かない。安全な読み取り経路は [Supabase](./secrets-services.md#management-api-の設定読み取り)

## hook は 5 規則

`pre-tool-guard`（`scripts/hooks/pre-tool-guard-rules.mjs`）が止めるのは、`.env` 系の読み書き、取り返しのつかない git 操作、worktree の越境、secret 値の表示、DB の保護の 5 規則だけ。一覧と注意点は [エージェントの仕組み](../learn/system/agents.md) にある。hook は事故を減らす speed bump で、境界の本体は上の token の到達範囲と、下の User 専権の操作。

## User だけが行う操作

`AGENTS.md` の EXPLICIT AUTHORITY に当たり、agent は手順と確認コマンドを示すところまでを行う。

- 1Password の token・item の作成、値の投入、削除、rotation。SA の作り直し
- 外部サービスでの token・key の発行と revoke（GitHub PAT、Supabase、Sentry、Stripe、Google、Vercel）
- 開発機の `.claude/settings.local.json` の `env`、Claude Code cloud の environment 変数・network・setup script の設定
- Vercel・GitHub Actions・Supabase Dashboard への production の replica 同期（`scripts/runbook/sync-ci-environment-secrets.sh` など）
- `human` vault を使う管理者 script の実行（production への操作）と、`vercel env pull`
- Vercel の本人 login（User の terminal でだけ使い、作業後に logout する）

## やらないこと

- 実値を `.env.local`・`.op-env.*`・docs・Issue・PR・Slack・chat に書く
- `NEXT_PUBLIC_` だから安全だと判断して実値を公開する
- production の secret を通常の local dev から参照する
- PR Preview Branch credentials を 1Password に保存する
- agent が自分の token を 1Password から取り出す循環を作る（SA token の控えは `human` に置く）
- 機種依存の絶対パスや token を tracked の `.claude/settings.json` に書く

## どこに何があるか

| 知りたいこと                                                                            | 正本                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SA token の設定（ローカル / cloud）、`op` の罠、local dev の env-file                   | [サービス別手順 §1Password](./secrets-services.md#1passwordservice-account)        |
| agent の gh identity（PAT）、GitHub Actions の environment と Secret の同期             | [サービス別手順 §GitHub](./secrets-services.md#github)                             |
| agent の Supabase 読み取り token、管理者 script、Dashboard Secrets                      | [サービス別手順 §Supabase](./secrets-services.md#supabase)                         |
| Sentry / Vercel / Stripe / Google / Turnstile                                           | [サービス別手順](./secrets-services.md)                                            |
| 変更とローテーション（workflow の案内にある Change Procedure）                          | [サービス別手順 §変更とローテーション](./secrets-services.md#変更とローテーション) |
| vault / item / field の一覧、タグ、Replica 台帳、integration-managed 例外、検証コマンド | [台帳](./secrets-ledger.md)                                                        |
| 外部サービスへの CLI 経路（Sentry / Supabase / GitHub / Vercel など）                   | `mcp-usage` skill（`.agents/skills/mcp-usage/SKILL.md`）                           |
| GitHub / Vercel / Supabase の replica の詳細                                            | [Environment Secrets](./security/environment-secrets.md)                           |
| 問い合わせの DNS / mailbox / release 運用                                               | [問い合わせメール](./contact-email.md)                                             |
