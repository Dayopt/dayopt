---
status: current
last_verified: 2026-09-14
---

# MCP create digest の互換移行（#2736）

## 変更と適用順序

`20260914000000_version_mcp_create_digest.sql` は receipt に内部の `digest_version` を追加する。既存行と旧コードの INSERT は既定値1、新しい Plan / Record create は2。公開tool・operationId・receiptのschemaVersionは変えない。既存のdigest・適用時刻・90日保持期間は更新しない。

migration は1 transactionで形式情報・改変防止trigger・両形式を照合する関数・新規発行を切り替える。認可と同一operationのlockを取得してから形式を参照し、保持期限・purge・入力不一致の拒否は既存resolverへ委ねる。適用は local → PR Preview → 明示承認されたproductionの順。gate開放は別操作。

## 隔離環境での検証

共有ローカルDBのresetや本番でのfixture投入は行わない。`dayopt_mcp_digest_*` という専用DBへmigrationを適用してから、次を実行する。

```sh
psql "$DIGEST_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/mcp-create-digest.sql
DIGEST_TEST_DATABASE_URL="$DIGEST_TEST_DATABASE_URL" python3 supabase/tests/mcp-create-digest-concurrency.py
```

Plan / Record の新規発行、旧/新receipt再送、変更入力拒否、失効token拒否、形式改変拒否、90日期限の前後、purge済み再生拒否、rollbackと再適用を検証する。履歴時刻のfixture作成だけは隔離DB内でtriggerを一時停止し、全変更をROLLBACKする。このSQLを本番の試験や復旧には使用しない。同時実行のPython試験は専用DBにfixtureを残すため、試験終了後にその専用DBを破棄する。共有DBには実行しない。

## 停止・復旧

異常時は既存runbookのwrite gateを閉じる。アプリdeploymentのrollbackはDB定義を戻さない。**旧create関数へ丸ごと戻すと形式2のreceiptを再送できなくなるため、その復元は行わない。**

発行だけ戻す必要がある場合は、両形式の照合関数・digest_version列・改変防止を維持したまま、2つのcreate関数のINSERTだけを `v_request_digest, 2` から `v_legacy_digest, 1` へ変えるforward migrationを別途レビューする。隔離試験はこの形で形式2の再送と、再適用後の形式1の再送を確認する。本番へのDDLは対象定義・backup・独立レビュー・明示承認が揃ってから行う。

## 観測と旧形式の撤去条件

担当はrelease実行者、観測記録は#2736。新形式を配備したSHA、DB関数定義、適用日時、最後の旧形式発行時刻を記録する。配備時・日次・rollback後に以下のread-only集計を取得する。監視の常設先は#2683（schema/権限drift）と#2681（cleanup稼働）を再利用し、別の監視基盤は追加しない。

```sql
SELECT digest_version, count(*) AS receipts,
       count(*) FILTER (WHERE applied_at >= now() - interval '90 days') AS retained,
       max(applied_at) AS last_issued_at
FROM public.mcp_mutation_receipts
WHERE tool_name IN ('plans.create', 'records.create')
GROUP BY digest_version ORDER BY digest_version;
```

update/deleteなど形式が変わらないtoolのversion1は移行対象外。createの旧形式の新規発行が止まったことを確認した時点から90日を観測する。rollbackで旧形式が再発行されたら観測開始を更新する。取得失敗や空の観測履歴を「旧形式ゼロ」と扱わない。

期限内の旧create receiptがゼロになり、運用担当が観測証跡を確認してから、旧照合コードの撤去を別migrationとしてレビューする。固定のカレンダー日付だけでは撤去しない。#2694はprocedure改名の配信確認とこの撤去の両方が完了してから閉じる。
