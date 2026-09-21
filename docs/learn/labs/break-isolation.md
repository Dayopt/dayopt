---
status: current
last_verified: 2026-09-21
---

# Lab: 別の利用者のデータへ手を伸ばす

Alice のつもりで Bob の Plan を読む・書く。**どの層がどう止めるか**を確かめ、「アプリのコードを突破されても残る境界」を体で覚える。

## 目的

- 読み取りを RLS が絞ることを見る
- 利用者のセッションからは表へ直接書けないことを見る
- 書き込みの command 関数が、他人の行を「存在しない」として扱うことを見る

## 予想を書く（先に）

1. Alice のセッションで `plans` を全件読むと、Bob の行は何件見えるか
2. Alice のセッションで `plans` へ直接 INSERT したら
3. service role の command 関数に「Alice として Bob の Plan を更新」と頼んだら。エラーは Bob の Plan の存在を漏らすか

## 準備

- local Supabase を起動している。自分以外の利用者の Plan が 1 件以上ある（E2E や seed の利用者で足りる）

## 手順

1 と 2（transaction の中、何も残さない）:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT count(*) AS visible, count(*) FILTER (WHERE user_id <> '00000000-0000-0000-0000-000000000001') AS others FROM public.plans;
INSERT INTO public.plans (user_id, title, start_at, end_at, source)
  VALUES ('00000000-0000-0000-0000-000000000001', 'lab', now(), now() + interval '1 hour', 'manual');
ROLLBACK;
```

比べるために、同じ SELECT を transaction の外（postgres のまま）でも実行する。

3（API から。Bob の Plan の id と `updated_at` を psql で調べて入れる。title などは null のまま送るので、万一通っても値は変わらない）:

```bash
KEY=$(supabase status -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
curl -s -X POST http://127.0.0.1:54321/rest/v1/rpc/update_plan_command_v1 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"p_user_id":"00000000-0000-0000-0000-000000000001","p_plan_id":"<Bob の Plan の id>","p_expected_updated_at":"<その updated_at>","p_title":null,"p_note":null,"p_external_calendar_event_id":null,"p_start_at":null,"p_end_at":null,"p_activity_id":null,"p_activity_id_present":false}'
```

送る前と後で、Bob の Plan の `updated_at` が変わっていないことを確かめる。

## 実測結果（2026-09-21、local）

<details>
<summary>開く</summary>

- 管理者（postgres）からは 44 件、うち他の利用者の行が 5 件
- 1: Alice のセッションでは 39 件、**他の利用者の行は 0 件**（RLS の `Users can view own plans`）
- 2: `permission denied for table plans`（`authenticated` には SELECT しか許していない。書き込みは command 関数だけ）
- 3: `{"code":"DT001","message":"Plan not found"}`。Bob の Plan は `updated_at` も含めて無変更。「見つからない」と返すので、**Bob の Plan が存在することも漏らさない**
- 1〜3 のうち、アプリのコードが守っているものは無い。どれも DB の GRANT・RLS・関数の中の `user_id` 照合が止めた

</details>

## この境界を守るテスト

- `apps/product/src/lib/test/integration/rls-access.integration.test.ts`（「authenticatedはown Plan / Recordをreadできるが直接writeできない」ほか）
- `apps/product/src/lib/test/integration/mcp-read-tenant-isolation.integration.test.ts` — MCP の読み取りは RLS が効かない経路なので、こちらはアプリのコードの絞り込みを守る
- どちらも `pnpm test:integration`（local Supabase が要る）

## 元に戻す

1 と 2 は ROLLBACK。3 は拒否されるので何も残らない。

## 関連

- [3. DB / Auth / RLS](../03-data-auth-rls.md)、[8. セキュリティ](../08-security.md)
- [経路: AI クライアントから Plan を作る](../journeys/mcp.md)（RLS が効かない側の入口）
