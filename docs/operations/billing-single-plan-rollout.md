---
status: current
last_verified: 2026-09-08
code: apps/product/src/lib/billing/access-service.ts
---

# 単一有料プランの公開手順

45日体験と月 $5 の提供を開始するための手順。実装のマージは本番有効化の許可ではない。本番移行・通知送信・実課金は明示指示、独立レビュー、復元証跡が揃ってから実施する。#2610 / #2605 / #2629 / #2615。

## 事前検証

- Stripe test mode の月額 USD 500 cents の Price を確認する。既存の Price ID 設定を使い、新しい Price は自動作成しない。初期提供はカード決済のみ。非同期決済を追加する場合は入金前のactive状態を利用権と分離する設計を先に行う。
- Preview と隔離DBに追加migrationを適用する。既存Stripe trialはそのまま維持する。体験開始は認証済みアプリ表示のみで確認し、LP・登録・MCP・同期から開始しないことを確認する。
- Checkoutの成功・中断・初回失敗、更新の再試行・回収不能・解約予約・再契約をテストする。成功画面ではなく署名検証済みWebhookとprofilesの確定を確認する。
- `invoice.paid` を既存Webhook endpointの対象イベントへ追加する。初回と更新の支払成功を別イベントとして保存し、請求IDから生成する安定したIDで再送を重複排除する。
- `pnpm check`、`pnpm docs:check`、`supabase/tests/single-plan-trial.sql`、課金E2E、MCP conformanceを実行する。E2Eの既存Stripe interceptionは実決済を証明しないため、Stripe test modeの実際のCheckout/Webhook/復帰も別途記録する。
- 期限直前・一致・直後、複数タブ、再ログイン、timezone変更、古いJWT、未保存入力の保持と本人による再保存、同期途中、Data API/RPCへの直接アクセスを確認する。

## 公開順序

ProductとWebのProductionデプロイはこの順序を揃えるまで保留する。課金制限のフラグは引き続き `BILLING_ENFORCED=false` とし、未公開の45日表記を先にWebへ出さない。

1. 復元可能なバックアップと現在の権限を保存し、対象project・branch・Stripeモード・SHAを証跡に記録する。既存の復元訓練 #1879 が未完了なら本番移行は行わない。
2. **追加schemaを先に適用**する。`20260907233848_single_plan_trial.sql` と分析イベント追加は後方互換。既存の未完了購入を誤って消費済みにしないため、statusだけでは消費済みにせず、手順5の請求成功・旧trial履歴を正本として分類する。
3. **直接書き込み権限を撤去する前に、新Productコードを配備する。** activities/categories/segments/テンプレートのINSERT/UPDATEをサーバー専用経路へ移す。フラグOFFでも作成・変更・削除が通ることを確認する。
4. 新Productの本番SHAと書き込みsmoke testを証跡化してから、権限撤去migration `20260908021201` を適用する。MCP判定の有効化はさらに分離する。SELECT/DELETE・owner RLS・複合FKは保持する。古いブラウザもサーバー経由のため新コードへ到達する。
5. 既存のwrite fenceを使って利用者の書き込みを止め、Webhook処理を含む移行競合を監視する。次のread-only preflightを実行し、人数と生成SQLをレビューする。全Stripe履歴が取得できない顧客が1人でもいれば有効化しない。契約やtrial履歴のないincomplete / incomplete_expiredだけの顧客は対象から除外される。

   ```bash
   pnpm --filter @dayopt/product exec tsx scripts/billing-trial-preflight.ts /absolute/private/review.sql
   ```

   認証は `docs/operations/secrets.md` に従う。コマンド自体はDBとStripeを読み取り、ローカルSQLを作るだけで本番には書かない。生成物は顧客IDを含むためGitや公開issueへ添付しない。dry-runの後、有効化直前に再実行し、対象追加を再レビューする。既に消費済みの時刻を上書きしない。

6. 明示指示後にレビュー済み分類SQLを適用し、`BILLING_ENFORCED=true` のProductと45日説明を含むWebを同じ公開作業で切り替える。write fence解除後、既存未契約者の初回利用で45日が一度だけ始まることを確認する。
7. 下の案内文を確定して利用者へ通知する。今回の実装では送信しない。アプリ内は終了7日前から表示し、新しい催促メールcronは作らない。

## 復帰

制限の不具合は `BILLING_ENFORCED=false` で停止する。開始済み・消費済み日時とStripe情報は残し、再有効化で45日を再発行しない。Web表示も同時に停止時の説明へ戻す。

Productのコードを権限撤去前の版へ戻す場合、先に新経路を維持した修正版を用意する。旧版へ単純revertすると作成が拒否される。やむを得ず旧権限へ戻す場合は、postgresだけが実行できる `private.restore_single_plan_direct_write_grants_v1()` を明示指示後に呼び、migration前のtable grantへ戻す。復旧後に全6テーブルのSELECT/INSERT/DELETE、更新可能な4テーブルのUPDATE、利用者自身の作成・編集・削除を確認し、制限をOFFのままにする。新しい日時列は削除しない。外部予定・接続・tokenを課金終了に合わせて削除しない。

## 既存利用者向け案内案

日本語：Dayoptは、すべての機能を月 $5 で利用できるサービスになります。これまで有料契約や無料体験をご利用でない方は、変更後に初めてアプリを開いた時から45日間、カード登録なしで全機能をお試しいただけます。期間終了後も保存済みカレンダーとレポートの閲覧、データのエクスポート・削除はできます。作成・編集・同期などを続ける場合は設定から購入できます。既存の契約と約束済みの体験期間は維持されます。

English: Dayopt is moving to one plan with all features for $5/month. If you have not previously subscribed or used a subscription trial, your 45-day card-free trial starts when you first open the app after this change. When access ends, you can still view your saved calendar and reports, export your data, or delete it. Subscribe in Settings to resume creating, editing and syncing. Existing subscriptions and promised trial periods are preserved.

## 計測

`queries/billing-cohorts.sql` はread-only集計。45日終了はprofilesの保存済み期限から算出する。初回支払と更新支払はStripeの請求成功イベントから数える。週をまたぐ再利用は開始後7日以上14日未満の予定・記録作成またはレポート閲覧。観測期間、人数、未成熟体験、更新を観測できる人数を別々に出し、未成熟者を未転換者として評価しない。90日のイベント保持期間より古い売上の正本はStripeとする。
