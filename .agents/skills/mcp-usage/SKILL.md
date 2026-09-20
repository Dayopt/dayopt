---
name: mcp-usage
description: Sentry / Supabase(local・cloud) / Context7 / Eagle / Storybook / UptimeRobot の MCP と Vercel / GitHub の CLI-first 経路をいつ使うか判断する時に発動。Invoke when・認証方式（OAuth / op run 自己解決 / headersHelper / token不要）・登録手順・境界ケースを適用する。MCP 定義の追加・削除（global 設定変更）や通常の実装作業では発動しない。
---

# MCP サーバー利用ガイドライン

モデルによってはツール呼び出しが控えめになる傾向がある。モデルによらず、以下の場面では積極的に MCP を呼ぶこと。推測より確認を優先する。

通常は現在の runtime が公開する connector / MCP / CLI を使い、必要な capability が既に利用可能か先に確認する。**repo 側に MCP 定義や認証情報を置かない**。個人設定の追加・削除は利用判断とは別の明示依頼として扱う。

下記の登録表と `claude mcp` コマンドは **Claude Code の互換 adapter 例**であり、Codex の通常経路の前提ではない。Claude Code で登録する場合は `~/.claude.json` の user scope に一本化し、repo と同名定義を二重管理しない。別 runtime では同じ capability・scope・認証境界を満たす既存の連携を使う。設定ファイルの存在だけで利用可能・read-only と判断せず、公開toolと実際の権限を確認する。

Claude Code 互換の9サーバーの登録例:

| Server             | 種別                 | 登録内容                                                                                                                                                                                                                                                    |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eagle`            | http                 | `http://127.0.0.1:41596/mcp`                                                                                                                                                                                                                                |
| `supabase-local`   | http                 | `http://127.0.0.1:54321/mcp`                                                                                                                                                                                                                                |
| `storybook`        | http                 | `http://localhost:6006/mcp`                                                                                                                                                                                                                                 |
| `sentry`           | http (OAuth)         | **常駐登録しない**（オンデマンド、下記 §Sentry）。`https://mcp.sentry.dev/mcp`                                                                                                                                                                              |
| `vercel`           | http (OAuth)         | **常駐登録しない**（CLI-first。下記 §Vercel）。登録が要る時だけ `https://mcp.vercel.com`                                                                                                                                                                    |
| `context7`         | stdio                | `npx -y @upstash/context7-mcp@latest`                                                                                                                                                                                                                       |
| `supabase` (cloud) | stdio                | **常駐登録しない**（使う時だけ登録。下記 §オンデマンド専用サーバーの登録・解除）。`op run -- npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=yvglwblxrnrenfifsnje` / env `SUPABASE_ACCESS_TOKEN=op://agent/supabase-agent/credential` |
| `uptimerobot`      | http (headersHelper) | **常駐登録しない**（使う時だけ登録。下記同節）。`https://mcp.uptimerobot.com/mcp` / `headersHelper: ~/.claude/scripts/uptimerobot-headers.sh`（spawn 時に 1Password の Read-only API Key を解決）                                                           |

認証方式はサーバーごとに 3 通り:

1. **OAuth 承認方式**（`/mcp` で承認、トークン管理不要）: `sentry`（`https://mcp.sentry.dev/mcp` 直叩き）/ `vercel`。いずれもオンデマンド登録。
2. **`op run` 自己解決方式**（global 設定の起動コマンドを `op run -- <bin>` でラップし、spawn 時に 1Password が `op://` を解決。**Claude 本体の起動経路に依存しない**）: `supabase`(cloud)。stdio の token 系 MCP の標準方式。
3. **`headersHelper` 方式**（remote http + Bearer token。接続時に `headersHelper` script を実行し stdout の JSON を認証ヘッダーに使う。script 内 `op read` のため設定ファイルに token 平文が残らない）: `uptimerobot`。OAuth の read-only scope が保証されない remote http サーバー向け。

**`op run` 方式の常駐登録はゼロにする（`supabase`(cloud) はオンデマンド）**（spawn ごとに 1Password 承認が要り、常駐 N 個ならロック解除時に承認が N 回出るため）。**トークンを平文でハードコードしない**（env 注入を要する MCP は無い）。前提は `op` CLI + 1Password desktop 統合。`op run` は secret masking が既定で有効なので、MCP server へ env token を渡す用途では `--no-masking` を付けない。

### claude.ai コネクタ方式は使わない

claude.ai の connector 設定画面から MCP を接続する経路は `~/.claude.json` の global `mcpServers` を経由せず、本ファイルの規約（`--read-only` 固定、オンデマンド登録、scope 制限）を通さない。**決定: 使わない。** 外部サービスへ新たに繋ぐ場合も本ファイルが定める 3 方式（OAuth 承認 / `op run` 自己解決 / `headersHelper`）で global 設定へ登録する（read-only 固定・登録解除タイミングをこの 3 方式だけが inspect・強制できるため）。

## 運用方針

- **常時使う**: `context7` のみ（バージョン依存の判断で使用、記憶だけで判断しない）
- **オンデマンド**: `sentry`（CLI で閉じない時だけ、§Sentry） / `eagle`（ローカル app 起動時のみ） / `supabase-local`（migration/RLS/schema 確認時） / `storybook`（公式アドオン、正式登録済み） / `supabase`(cloud)（production schema/RLS 確認、§オンデマンド専用サーバーの登録・解除） / `uptimerobot`（障害調査、同節）
- **CLI-first（MCP を登録しない）**: Vercel（`vercel` CLI、§Vercel）、GitHub（`gh`）

各サーバーの Invoke when・Before use・絶対ルールは下記 §接続済み MCP サーバー を正とする。

### 常駐を増やさない

外部能力の扱いは `AGENTS.md` §委任・報告の作法（原則③）に従う。ローカルアプリ依存（`eagle` / `storybook` / `supabase-local`）と、購入・停止・deploy など不可逆の能力を含む OAuth MCP（Vercel 等）は常駐させない。使う時だけ `claude mcp add`、終わったら `claude mcp remove`（登録内容は上の表が正本）。

### オンデマンド専用サーバーの登録・解除

`supabase`(cloud) / `uptimerobot` は接続のたびに 1Password 承認や個別 config 生成が絡むため、常駐させるとセッション起動ごとにコストが乗る。**使う時だけ登録し、使い終わったら外す**。

#### `supabase`(cloud)

production schema を実際に見る時だけ登録する。

```bash
# 使う時（-e で SUPABASE_ACCESS_TOKEN の op:// 参照を渡す。op run がこれを解決する）
claude mcp add supabase -s user -e SUPABASE_ACCESS_TOKEN=op://agent/supabase-agent/credential -- op run -- npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=yvglwblxrnrenfifsnje

# 使い終わったら
claude mcp remove supabase -s user
```

token は `agent/supabase-agent`（read 権限だけの scoped token）で、write を含む `human/supabase-cli` は使わない。`execute_sql` は `--read-only` と token の両方で読み取りに限られるが、`auth.users` などの個人情報も読める。個人情報を含む行は User の明示指示がある時だけ読む。登録後は再起動して `list_tables` で疎通確認する。`supabase-local`（http、`op` 不要）は常駐のままでよい。

#### `uptimerobot`

障害調査で外形監視の状態を見る時だけ登録する。

```bash
# 使う時
claude mcp add-json uptimerobot "{\"type\":\"http\",\"url\":\"https://mcp.uptimerobot.com/mcp\",\"headersHelper\":\"$HOME/.claude/scripts/uptimerobot-headers.sh\"}" -s user

# 使い終わったら
claude mcp remove uptimerobot -s user
```

前提: `~/.claude/scripts/uptimerobot-headers.sh`（repo 外の user-global script）が存在すること。中身は `op read "op://agent/<item-id>/credential"` で **Read-only API Key** を取り出し `{"Authorization": "Bearer <token>"}` を echo するだけ。新しいマシンでは 1Password の item `UptimeRobot Read-only API Key`（agent）を参照して script を作り直す。

## 接続済み MCP サーバー

### Sentry (`mcp__sentry__*`)

**既定は `sentry` CLI**（下記 §Sentry CLI）。MCP はオンデマンド登録。

- **Invoke when**（CLI で閉じない時のみ MCP を使う）:
  - スタックトレースから原因が曖昧で `analyze_issue_with_seer` の一次切り分けが要る時
  - 複数 issue/event を横断する構造化検索が CLI の単発取得では足りない時
- **Before use**:
  - まず `sentry` CLI（下記）で足りるか検討する
  - Seer 分析や横断検索が必要と判断したら `claude mcp add` で `sentry`（`https://mcp.sentry.dev/mcp`）をオンデマンド登録し、`/mcp` で OAuth 承認する。トークンは Claude 側にキャッシュされ、起動方法（desktop / zsh）によらず再登録は `/mcp` 承認 1 回で済む
  - 疎通確認は `whoami` または `find_organizations`（`dayopt` org が返れば OK）
  - 使い終わったら `claude mcp remove sentry -s user`
- **`Authorization Expired` / 401 が出たら**: `/mcp` で `sentry` を再承認する。OAuth トークンの失効サイン。
- **フォールバック**: MCP を使わない間は Sentry Web UI、または下記の Sentry CLI を使う。
- **境界ケース**: 「再現できますか？」とユーザーに尋ねる前に Sentry（CLI 優先）で対象 issue を探す。ヒットすればスタックトレースから直接原因を特定できるので、ユーザーの手間を省ける。

### Sentry CLI（`sentry` コマンド、cli.sentry.dev）

エージェント向けの issue 閲覧・Seer 分析ツール。**既存の `sentry-cli`（sourcemap upload 等のビルドツール、npm package）とは別物。** コマンド名が紛らわしいため区別する。

MCP（上記）との分担: **メインセッションの構造化・横断調査は MCP、subagent・script からの単発参照は CLI**（MCP は session 単位の配線が要るため届かない場所を CLI が埋める）。

- **Invoke when**:
  - MCP の配線が無い場所（subagent 内、script、CI）から Sentry issue を参照したい時
  - 単純な単発取得（1 issue の閲覧、org/project 一覧）で MCP を起動するほどではない時
- **Before use**:
  - インストール: `curl -fsS https://cli.sentry.dev/install | bash`（初回のみ）
  - **認証は env var 方式のみを使う。`sentry auth login`（ブラウザ OAuth）は使わない**:
    ```bash
    SENTRY_AUTH_TOKEN="op://agent/sentry-cli-readonly/credential" op run -- sentry <command>
    ```
    token は read-only scope（project:read, org:read, event:read, member:read, team:read）で発行済み。env var 方式では token がディスクに一切残らない
- **主要コマンド**: `sentry issue list [org/project] --query "<query>"` / `sentry issue view <id>` / `sentry issue explain <id>`（Seer root cause）/ `sentry org list` / `sentry project list` / `sentry release list`
- **境界ケース**: write 系コマンド（`issue resolve` 等）はこの token では想定運用外。write が必要な場面は Sentry Web UI を使う

### Supabase（`supabase-local`=ローカル / `supabase`=cloud）

2 サーバーを使い分ける。**ローカル DB の inspect は `supabase-local`、production schema の確認は `supabase`(cloud, read-only)**。

- **Invoke when（`supabase-local`）**:
  - schema / RLS / migration を編集する前に、現在のスキーマ状態を取得して差分を確認する
  - `supabase/migrations/` に新 SQL を追加する前にローカル DB の既存テーブル・ポリシーを inspect する
  - Realtime 購読や RLS 挙動のデバッグ時に実データで挙動を確認する
- **Invoke when（`supabase` cloud）**:
  - production の実 schema / RLS / advisors を確認したい時（`list_tables` / `get_advisors`）
  - ローカルを起動せずに本番テーブル構成を素早く参照したい時
- **Before use**:
  - `supabase-local`: Docker Desktop 起動後に `npx supabase status`、`nc -vz 127.0.0.1 54321` で待ち受け確認。`list_tables` が通れば利用可
  - `supabase`(cloud): §オンデマンド専用サーバーの登録・解除 参照
- **絶対ルール**: `supabase`(cloud) は global 設定で `--read-only` + production project に固定。**cloud 経由で書き込み・migration はしない**。schema 変更は `supabase-local` → PR Preview → production の既存フロー（`supabase` skill）で行う。
- **境界ケース**: `pnpm types:generate` を走らせる前に、スキーマ変更が DB に反映済みか確認する（未反映だと型生成しても差分が出ない）。

### Vercel（`vercel` CLI が正、MCP は登録しない）

MCP の tool set には `buy_domain` / `buy_pro` / `buy_credits` / `pause_project` / `deploy_to_vercel` など購入・停止・deploy の不可逆な能力が含まれ、常駐させると毎セッションその権限が載る（原則③違反）。read 用途は `vercel` CLI（50.32.5、OAuth ログイン済み）で閉じる。

- **Invoke when**: デプロイ状態・build log・runtime log・env 一覧を確認したい時
- **主要コマンド**（テーブル出力は `| head` / `| rg` で射影する。`--json` を持つのは `vercel logs` のみ）:
  - `vercel ls | head -20`（最新 deployment 一覧。repo が link 済みなら `--scope` 不要。数行で MCP `list_deployments` と同等の情報が取れる）
  - `vercel inspect <deployment-url>`（状態・commit・region）
  - `vercel inspect --logs <deployment-url> | tail -80`（build log）
  - `vercel logs <deployment-url> --json | jq -c 'select(.level=="error")' | head`（runtime error）
  - `vercel project ls`、`vercel env ls`（既存 `pnpm vercel:env`）
- **ドキュメント参照**: `context7`（`resolve-library-id vercel` → `query-docs`）か WebFetch を使う。Vercel MCP の `search_vercel_documentation` は使わない。
- **絶対ルール**: agent から実行してよいのは読み取り系サブコマンドだけ（`ls` / `inspect` / `logs` / `whoami` / `env ls` / `project ls` 等、`api` は GET のみ）。deploy / promote / rollback / env の追加・削除・pull / domain / cert / link は pre-tool-guard が block する。本番の promote は `promote.yml`、env 変更は User の terminal か Dashboard で行う。`--token` は渡さない。agent 用 Vercel token は置かない（`docs/operations/secrets.md` §Agent の vercel CLI）。
- **MCP が要る場面**（横断 deployment 検索、agent run trace など CLI に無い機能）: `claude mcp add` で `https://mcp.vercel.com` をオンデマンド登録し、`/mcp` で OAuth 承認、使い終わったら `claude mcp remove vercel -s user`。

### Context7 (`mcp__context7__*`)

- **Invoke when**:
  - Next.js / React / tRPC / Supabase client / TanStack Query / Zustand などバージョン固有挙動が問題になりうるライブラリ API を扱う時
  - エラーメッセージが最新ドキュメントの API シグネチャと一致しているか確認したい時
  - 新規依存追加を検討する際、最新の推奨 API 設計を確認する時
- **Before use**: `resolve-library-id` から `query-docs` の順に確認する
- **境界ケース**: 「知っている」と思っても、version依存のトピックは必ずmanifestを確認し、`query-docs`で一次資料を確認してから回答する。

### Eagle (`mcp__eagle__*`)

デザインアセット運用の視覚検索ライブラリ。

- **Invoke when**:
  - UI 設計・改善で参考事例を探す時（`ai_search_by_text` でセマンティック検索、`item_query` でタグ・★絞り込み）
  - font / icon / illust などの作業用素材を探す時
  - 過去のブランドクリエイティブの出所・掲載先を確認する時
- **Before use**:
  - `nc -vz 127.0.0.1 41596` で Eagle app 側の待ち受けを確認する
  - MCP tool の直接呼び出しは `POST http://127.0.0.1:41596/api/tools/call` に `{"tool": "...", "params": {...}}`。**引数キーは `params`**
  - `ai_search_status` の `totalSyncedItems` で AI 検索インデックスを確認する
  - `item_query` はタグ・annotation を対象とし、**ファイル名では検索できない**
- **境界ケース**: 実装の見た目を確認したい時は Eagle を開かない。Storybook が正。ライブラリのアイテムを削除・trash 移動しない。

### Storybook (`mcp__storybook__*`)

公式アドオン `@storybook/addon-mcp` が Storybook dev サーバー上に MCP を公開する（`http://localhost:6006/mcp`）。

- **Invoke when**:
  - component の props / variant / story 構成をコードを離れず把握したい時
  - design token の選択（どのサイズ・spacing・icon を使うか）を確認したい時（`storybook` skill 本体を参照）
- **Before use**: `pnpm storybook`（localhost:6006）が起動していることを確認する（`nc -z localhost 6006`）
- **境界ケース**: Storybook MCP は構造化知識取得に使い、見た目の検証には使わない。

### MCP を持たない経路

GitHub は `gh` CLI を使う（`--json` + `--jq` で必要な情報へ絞る）。Agent セッションの `gh` は `GH_CONFIG_DIR` 経由の fine-grained PAT（`agent/github-agent`、Dayopt/dayopt 限定、Administration / Secrets / Workflows 無し）で動く。ruleset・GitHub Secret・org 設定の変更は scope に無いので失敗する。それらは User の terminal で行う（`docs/operations/secrets.md` §Agent の gh identity）。通常のブラウザ操作は現在の runtime のブラウザ機能を使う。Claude Code の Browser tool は互換経路であり必須ではない。認証済みセッションが要る検証は、専用 MCP を足さず既存の E2E harness を使う（`apps/product/src/lib/test/e2e/create-scoped-test-user.ts` が service role で spec 専用の使い捨て user を作り、各 spec がその資格情報で sign in する）。storageState を事前生成する経路は持たない。

### UptimeRobot (`mcp__uptimerobot__*`)

外形監視の調査経路。**Read-only API Key で接続するため read 系 tool しか公開されず、monitor の作成・変更・pause は構造的に不可能。**

- **役割分担**: alert の一次通知は既存メール。障害調査・横断要約が MCP。app 内部 error は Sentry、deployment / function は Vercel。確認順は「Sentry → UptimeRobot → Vercel」
- **Invoke when**: ユーザーが障害・ダウンタイムを報告した時、または UptimeRobot のメール alert 受領後の一次切り分けで現在状態・直近 incident・uptime・response time を確認する
- **Before use**: §オンデマンド専用サーバーの登録・解除 参照。疎通確認は `list-monitors`
- **401 / 接続失敗時**: 1Password 未起動・ロック中を疑う
- **フォールバック**: UptimeRobot dashboard（Web UI）とメール通知
- **境界ケース**: rate limit は account の API と共有（Free plan 10 req/min）。MCP の自然言語出力を根拠に監視設定を変更しない。

## 共通原則

1. **推測より確認**: 「たぶん X」と答える前に MCP で裏を取れるか検討する
2. **ユーザーの手間を減らす**: URL・ID が提示されたら、本文ペーストを求める前に MCP で取得する
3. **デプロイ後の能動チェック**: 本番デプロイ直後は Sentry でエラー増加を自発的に確認する
