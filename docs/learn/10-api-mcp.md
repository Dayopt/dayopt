---
status: current
last_verified: 2026-09-21
---

# 10. API / MCP（外の AI から Dayopt を使う）

## この章で答えられるようになる問い

- Claude などの AI クライアントは、どうやって利用者の許可を得て Dayopt を読み書きするか
- UI から Plan を作るのと、MCP から作るのとで、何が同じで何が違うか
- MCP のツール名や scope を変えると、誰が壊れるか

## 概念

**MCP（Model Context Protocol）**: AI クライアントが外部のツールを呼ぶための約束。Dayopt は `/api/mcp` でツール（`plans.list`・`plans.create` など）を公開する。

**OAuth 2.1 + PKCE**: 利用者が同意画面で許可すると、AI クライアントは access token を受け取る。token は推測できないランダム値で、Dayopt の DB には hash だけを保存する。クライアントは事前登録の allowlist（Claude / ChatGPT / Cursor）だけで、動的な登録はしない。

**scope**: token が許す範囲（`read:entries`・`write:plans` など）。ツールごとに必要な scope が決まっている。

## Dayopt ではどうなっているか

[経路: AI クライアントから Plan を作る](journeys/mcp.md) は [Plan を保存](journeys/save-plan.md) の双子で、`pnpm learn` の「↔ 同じ操作を別の入口から」で行き来できる。

**同じ Plan を作るのに、入口で変わるもの**:

| 観点                     | UI（Plan を保存）                              | MCP                                                                                                                                            |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 認証                     | Supabase のセッション cookie                   | OAuth の bearer token（hash で照合）。OAuth token で `/api/trpc` を直接叩いても拒否される                                                      |
| 書き込みの通り道         | tRPC → service → `create_plan_command_v1`      | **tRPC を通らない**。`McpMutationClient` が `apply_mcp_plan_create_v1` を呼び、その中で同じ `create_plan_command_v1` に入る（source は `api`） |
| 誰の Plan か             | セッションの user を service が渡す            | アプリは user_id を渡さない。DB 関数 `authorize_mcp_mutation_v1` が接続から決める                                                              |
| MFA                      | 関門で毎回確かめる                             | 書き込みの時には見ない（同意画面は MFA 済みのセッションでしか開けない）                                                                        |
| 書き込みを止めるスイッチ | write fence                                    | **write fence は効かない**。MCP 専用の gate（`mcp_mutation_control`。閉じると DM003、または token から書き込みの scope が外れて 403）          |
| rate limit               | 利用者ごと 1 分 300 回。Upstash が落ちたら通す | IP ごと 1 分 1200 回・利用者ごと 1 分 120 回。本番で Upstash が落ちたら 503 で止める                                                           |
| 利用権                   | protectedProcedure の利用権チェック            | `/api/mcp` の入口と、DB 側の `billing_enforced`（別のスイッチ）の 2 か所                                                                       |
| 送り直し                 | 冪等の鍵は無い（送り直すと 2 つ作りうる）      | `operationId` が同じなら 2 つ目を作らず `replayed` を返す                                                                                      |
| 読み取りの分離           | RLS（利用者のセッション）                      | service role の tRPC caller なので RLS は効かず、service の `user_id` 絞り込みだけが守る                                                       |
| 画面への反映             | その場で（楽観的更新）                         | Realtime が無いので、タブへ戻った時などの取り直しで現れる                                                                                      |

**外部契約**: MCP のツール名・入力の形・scope・OAuth の endpoint は、利用者がつないだ AI クライアントが依存している。名前を変える・消すと、既存の接続が壊れる（REVIEW-3）。`list-tools.test.ts` の「MCP list tools public contract」がツールの一覧を固定している。

**REST**: `/api/v1/*` は iCal feed（秘密の token 付き URL）だけで、汎用の REST API は無い。新しい API は tRPC で作る。

## 正本

- [docs/engineering/invariants.md](../engineering/invariants.md) の「MCP の DB 書き込み境界」「OAuth・暗号」
- [docs/engineering/threat-model.md](../engineering/threat-model.md) の信頼境界（外部 MCP クライアント → 利用者のデータ）
- [docs/operations/runbook.md](../operations/runbook.md) の MCP write gate の開閉
- [docs/operations/mcp-digest-migration.md](../operations/mcp-digest-migration.md)

## 自分で確かめる問い

<details>
<summary>1. AI クライアントの token が漏れた。何ができ、どう止めるか</summary>

その token の scope の範囲で、その利用者のデータを読み書きできる。利用者が設定の MCP 接続から取り消すと（`features/settings/server/mcp-connections-service.ts` の `revoke`）、以後の照合で拒否される。全員の書き込みをまとめて止めるなら MCP の gate。token は hash しか保存していないので、DB から token を取り出すことはできない。

</details>

<details>
<summary>2. `plans.create` の入力に必須の項目を 1 つ足したい。何が壊れるか</summary>

既存の AI クライアントは古い形で呼ぶので、その呼び出しが失敗する。外部契約なので、任意の項目として足すか、新しい version のツールを並べる。

</details>

<details>
<summary>3. MCP からの書き込みだけを今すぐ止めたい</summary>

`mcp_mutation_control` の gate を閉じる（runbook の「MCP write gate の開閉」、`pnpm mcp:gate`）。write fence では、接続済みの AI クライアントの書き込みは止まらない（止まるのは新規接続の token 発行だけで、しかも UI の書き込みまで止めてしまう）。

</details>

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": "apps/product/src/lib/oauth-server/tokens.ts",
    "find": "export function hashToken(token: string): string {"
  },
  {
    "path": "apps/product/src/lib/oauth-server/clients.ts",
    "find": "Phase 1 static client allowlist"
  },
  {
    "path": "apps/product/src/lib/trpc/procedures.ts",
    "find": "if (ctx.oauthExecution !== 'mcp_internal') {"
  },
  {
    "path": "apps/product/src/features/timeblock/server/mcp-mutation-db.ts",
    "find": "apply_mcp_plan_create_v1"
  },
  {
    "path": "supabase/migrations/20260914000000_version_mcp_create_digest.sql",
    "find": "FROM public.create_plan_command_v1("
  },
  {
    "path": "apps/product/src/app/api/mcp/_tools/timeblock-mutations.ts",
    "find": "Create one future Plan as canonical Dayopt data.",
    "why": "tool の説明（外部契約）。過去の Plan も作れるのに future と書いてある"
  },
  {
    "path": "apps/product/src/app/api/mcp/_tools/list-tools.test.ts",
    "find": "describe('MCP list tools public contract'"
  },
  {
    "path": "apps/product/src/features/settings/server/mcp-connections-service.ts",
    "find": "async revoke(userId: string, connectionId: string)"
  }
]
```
