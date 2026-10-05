---
status: current
last_verified: 2026-08-02
code:
  - apps/product/src/lib/analytics/product-events.ts
  - supabase/migrations/20260802013954_add_product_events.sql
---

# Product analytics運用

`public.product_events`に保存するpayload-free eventの日次数確認、90日retention、障害切り分けの正本。分析queryはSupabase SQL EditorなどのDB owner権限で実行し、browserまたはapplicationのservice roleへSELECTを付与しない。

## Contract

- event名はmigrationと`product-events.ts`の定義を使う。現在の名前は末尾の生成領域で確認する
- `properties`は常に`{}`。email、氏名、token、title、note、request bodyを追加しない
- application helperは1秒timeoutのbest-effort。分析障害をProduct操作の失敗にしないため、件数は厳密な監査logではない
- `user_signed_up`は`auth.users`の`AFTER INSERT` triggerで記録し、内部insert失敗をsignupへ伝播させない
- checkoutは成功したtRPC responseだけ、subscriptionは署名検証とwebhook重複排除の完了後だけを数える
- tableはRLS有効。`anon` / `authenticated`は権限なし、`service_role`はINSERTのみ

## 日次件数

直近30日のevent別日次数を確認する。

```sql
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day_utc,
  event_name,
  count(*) AS event_count
FROM public.product_events
WHERE created_at >= clock_timestamp() - INTERVAL '30 days'
GROUP BY day_utc, event_name
ORDER BY day_utc DESC, event_name;
```

特定userの識別子やraw rowをIssue、PR、chat、loggerへ貼らない。調査結果は日付、event名、集計件数だけを共有する。

## Retention

`cleanup-product-events` pg_cron jobが毎日03:40 UTCに動き、90日より古いrowを古い順に最大10,000件削除する。lock待ちと実行時間を制限し、並行処理中のrowはskipする。

backlogは次のaggregateだけで確認する。

```sql
SELECT count(*) AS expired_event_count
FROM public.product_events
WHERE created_at < clock_timestamp() - INTERVAL '90 days';
```

件数が継続して0にならない場合は、書込量とjob失敗を確認して新しいmigrationでbatch / scheduleを調整する。Productionで関数を手動実行したりcron catalogを直接更新したりせず、緊急時もレビュー可能なforward migrationで変更する。

## 障害切り分け

| 症状                   | 確認                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| 全application eventが0 | service role client、`product_events` INSERT grant、sanitized analytics warning件数を確認         |
| signupだけ0            | `track_product_user_signup` triggerと`private.track_product_user_signup_v1()`の存在を確認         |
| 同じsubscriptionが重複 | Stripe webhookのprocessed markerより後にtrackingされているか、event ID dedupを確認                |
| checkoutが多すぎる     | eager tRPC generationを除外し、成功した`billing.createCheckoutSession` resultだけ数えているか確認 |
| 90日超rowが残る        | `cron.job_run_details`の`cleanup-product-events`結果とexpired aggregateを確認                     |

event追加時はTypeScript allowlistだけを広げない。database check constraint、event source test、この文書を同じ変更で更新する。

## 関連

- 旧 Project overview（`docs/projects/_archive/minimal-product-analytics/overview.md`、docs/projects 全廃に伴い #2473 で削除。git 履歴参照）
- [Supabase運用](../engineering/infra.md)

## 機械取得する現状

<!-- docs-live:facts:start -->

抽出対象の登録は [scripts/lib/docs-live/facts.ts](../../scripts/lib/docs-live/facts.ts)。現在の一覧は `pnpm docs:read docs/operations/product-analytics.md` で生成して読む。

<!-- docs-live:facts:end -->
