---
status: current
last_verified: 2026-09-21
---

# Lab: UI を迂回して規則を破る

時刻の規則（`DT003` / `DT005`）と重なりの制約を、UI を通さずに DB へ直接ぶつけて、**DB が最後の砦**であることを確かめる。ついでに「superuser の psql は本番の再現にならない」ことも踏む。

## 目的

- UI の確認（写し）を通らない依頼でも、DB が規則を強制することを見る
- 規則の例外（誰が書く時に規則が外れるか）を知る

## 予想を書く（先に）

1. 終了が開始より前の Plan を DB 関数に直接渡したら
2. 未来に終わる Record を渡したら
3. 同じ利用者で時間が重なる Plan を 2 つ作ったら
4. 過去の Plan は作れるか

## 準備

- local Supabase を起動している
- psql が使える（接続先は `supabase status` が表示する `DB_URL`）

## 手順

すべて `BEGIN … ROLLBACK` の中で行い、DB に何も残さない。command 関数は service role の依頼しか受け付けないので、transaction の中で JWT の role を service_role にする。

```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- 1. 終了が開始より前の Plan
SELECT id FROM public.create_plan_command_v1(
  '00000000-0000-0000-0000-000000000001', 'lab', NULL, NULL, 'manual',
  now() + interval '2 hour', now() + interval '1 hour', NULL);
ROLLBACK;
```

同じ形で、2〜4 も試す（`create_record_command_v1` の引数は `\df public.create_record_command_v1` で見る）。

2 の未来の Record は、psql ではなく API から送る（理由は結果を見る）:

```bash
KEY=$(supabase status -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
curl -s -X POST http://127.0.0.1:54321/rest/v1/rpc/create_record_command_v1 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"p_user_id":"00000000-0000-0000-0000-000000000001","p_title":"lab","p_note":null,"p_plan_id":null,"p_external_calendar_event_id":null,"p_source":"manual","p_start_at":"<1 時間前の ISO 時刻>","p_end_at":"<1 時間後の ISO 時刻>","p_activity_id":null,"p_fulfillment":null}'
```

## 実測結果（2026-09-21、local）

<details>
<summary>開く</summary>

- **JWT の role を付けずに呼ぶと**、どれも `42501 Access denied: service role required`。postgres ユーザーでも command 関数は呼べない（`private.assert_timeblock_service_role_request_v1`）
- 1: `DT003 Plan end must be after start`
- 3: 2 つ目で `23P01`（排他制約。利用者ごとに `[start, end)` の半開区間が重なってはいけない）
- 4: 過去の Plan は作れた（未来だけの特別扱いは 2026-09-04 に撤去済み）
- 2: **psql から送ると作れてしまった**。trigger `validate_record_temporal_write_v1` は、`SESSION_USER` が `postgres` / `supabase_admin` の時だけ未来の Record を許す（migration と seed のための例外）。API から送ると `{"code":"DT005","message":"Records cannot end in the future"}` で拒否され、行は 0 件だった。アプリの依頼は API 経由（`authenticator`）なので、本番で規則は効いている
- 教訓: **superuser の psql での確認は、本番の経路の再現にならない**。規則の確認は、アプリと同じ入口から行う

</details>

## 元に戻す

psql の分は ROLLBACK で残らない。API から送った分は拒否されるので残らない（残っていたら `SELECT … FROM public.records WHERE title = 'lab'` で探して消す）。

## 関連

- [経路: Record を作る・Plan を記録する](../journeys/record-plan.md)、[経路: Plan を保存](../journeys/save-plan.md) の 9 段
- [0. Dayopt とは](../00-product.md)（規則は 2 本だけ）、[2. UI → DB](../02-ui-to-db.md)
- [docs/engineering/invariants.md](../../engineering/invariants.md) の「時刻」
