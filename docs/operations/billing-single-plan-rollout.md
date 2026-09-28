---
status: current
last_verified: 2026-09-08
code: apps/product/src/lib/billing/access-service.ts
---

# 単一有料プランの公開手順

45日体験と月 $5 の提供を開始するための手順。実装のマージは本番有効化の許可ではない。本番移行・通知送信・実課金は明示指示、独立レビュー、復元証跡が揃ってから実施する。#2610 / #2605 / #2629 / #2615。

## 事前検証

- Stripe test mode の月額 USD 500 cents の Price を確認する。既存の Price ID 設定を使い、新しい Price は自動作成しない。初期提供はカード決済のみ。非同期決済を追加する場合は入金前のactive状態を利用権と分離する設計を先に行う。
- Stripe CLI の保存済みアカウントを暗黙に使わない。`.op-env.agent` のtest keyを `STRIPE_API_KEY` としてCLIへ渡し、`STRIPE_ACCOUNT_ID` と同じsandboxへlistenerを固定する。listenerが表示する署名secretは1Passwordの`stripe-test/STRIPE_WEBHOOK_SECRET`へ保存してからProductを再起動し、値をshell履歴・ログ・issueへ残さない。

  ```bash
  op run --env-file=.op-env.agent -- bash -c \
    'export STRIPE_API_KEY="$STRIPE_SECRET_KEY"; stripe listen --forward-to http://localhost:3000/api/webhooks/stripe'
  ```

  `stripe trigger`のfixtureはアプリ利用者と結び付かない。状態遷移の合否は実際のtest Customer / Subscription / Invoiceとlocal profileを対応させて判定する。

- Preview と隔離DBに追加migrationを適用する。既存Stripe trialはそのまま維持する。体験開始は認証済みアプリ表示のみで確認し、LP・登録・MCP・同期から開始しないことを確認する。
- Checkoutの成功・中断・初回失敗、更新の再試行・回収不能・解約予約・再契約をテストする。成功画面ではなく署名検証済みWebhookとprofilesの確定を確認する。
- `invoice.paid` を既存Webhook endpointの対象イベントへ追加する。初回と更新の支払成功を別イベントとして保存し、請求IDから生成する安定したIDで再送を重複排除する。
- `pnpm check`、`pnpm docs:check`、`supabase/tests/single-plan-trial.sql`、課金E2E、MCP conformanceを実行する。E2Eの既存Stripe interceptionは実決済を証明しないため、Stripe test modeの実際のCheckout/Webhook/復帰も別途記録する。
- 期限直前・一致・直後、複数タブ、再ログイン、timezone変更、古いJWT、未保存入力の保持と本人による再保存、同期途中、Data API/RPCへの直接アクセスを確認する。

## Cloud Integration でのテスト検証 (#2867)

Docker を使わず、常設 Supabase branch `integration`（ref `tilwaprottpyhlfoggbb`）と既存 Product の固定 origin `https://product-git-integration-dayopt.vercel.app` を使う。以下は本番開通 #2869 の判断前の検証であり、本番の公開順序とは別に実施する。

1. Product deployment の SHA / branch / project、DB identity / migrations / control revision を読み取り確認する。seed と既存データの集計を保存する。新しい試験利用者に run ID を付け、対象 user ID と新規 Stripe オブジェクトの対応を非公開の証跡に記録する。既存試験契約や Customer を合格証拠に流用しない。
2. `agent/stripe-test` の明示 credential を使った GET で account が `STRIPE_ACCOUNT_ID` と一致し、設定済み Price が active・test mode・USD 500 cents・毎月であることを確認する。新しい Price は作らない。secret や Customer の個人情報を出力しない。
3. [secrets.md](secrets.md#cloud-first-product-integration-2910) の `integration` 限定 env を user が Vercel Dashboard / user terminal で保存する。`INTEGRATION_BILLING_REHEARSAL=true`、`BILLING_ENFORCED=true`、Stripe 5変数が必要。最初は MCP client 空で配備し、最終 SHA の runtime 確認後に MCP 検証用の `chatgpt` を設定する。shared Preview の env を変更しない。
4. Deployment Protection を維持したまま署名付き Stripe test webhook が固定 origin の `/api/webhooks/stripe` へ届く経路を用意する。Automation bypass を使う場合は secret を記録・公開しない。endpoint signing secret を branch の `STRIPE_WEBHOOK_SECRET` に保存して再配備し、署名検証と DB 確定を確認する。Protection のログイン画面や成功画面だけでは合格にしない。
5. 試験利用者の Checkout 成功・中断・初回失敗、更新成功・再試行・回収不能、解約予約・再契約、同一 event 再送を実行する。Checkout Session / Customer / Subscription / Invoice / webhook event / profiles の対応と各ケースの前後状態を同じ最終 SHA で記録する。状態を SQL で直接変更して決済成功の代わりにしない。
6. 期限境界の fixture は決済とは区別し、trial の開始・期限一致・直前直後、複数タブ・再ログイン・古い JWT、本人による未保存入力の再保存、API/RPC 直接アクセスを検証する。MCP は保存した control 状態と revision を確認後、Integration に限り billing gate / chatgpt write gate を CAS で開いて実クライアントから試す。共有利用者への影響が判明したら停止する。
7. 検証が終わったら run 所有の test Subscription のみ解約し、既存データの集計を再照合する。DB control を現在 revision で開始前の状態に戻し、rehearsal / billing を false、MCP client を空へ同時に戻して再配備する。Stripe の test 履歴と試験証跡は保持する。結果・残項目・復帰結果を #2867 に記録し、#2869 は User の結果確認と判断を待つ。

account / mode / ref / SHA の不一致、署名付き webhook の不達、既存データへの想定外の変更、run の所有範囲を確定できない場合は停止する。初期 Ready / migration 適用 / mock E2E は実フロー完了の証明に含めない。

### 接続設定

Vercel project `product` の Preview / Git branch `integration` に以下を保存する。secret の実値は会話・Issue・repo へ貼らない。

| 変数                                                 | 設定元 / 値                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                                  | 1Password `agent/stripe-test` の test key                                          |
| `STRIPE_ACCOUNT_ID`                                  | 同 item の照合済み account                                                         |
| `STRIPE_LIVEMODE`                                    | `false`                                                                            |
| `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`                    | 同 item の照合済み既存 Price                                                       |
| `STRIPE_WEBHOOK_SECRET`                              | 今回の Integration endpoint の signing secret。CLI listener の secret は流用しない |
| `INTEGRATION_BILLING_REHEARSAL` / `BILLING_ENFORCED` | 両方 `true`                                                                        |
| `MCP_WRITE_ENABLED_CLIENTS`                          | 最初は空。MCP 検証時のみ `chatgpt`                                                 |

Stripe の上記 account の test mode で endpoint を作り、イベントは `checkout.session.completed`、`customer.subscription.updated`、`customer.subscription.deleted`、`invoice.paid`、`invoice.payment_failed` を購読する。payload API version は Product の `apps/product/src/lib/stripe/client.ts` と同じ `2026-02-25.clover` を選ぶ。

Webhook URL は固定 origin の `/api/webhooks/stripe` を使う。Vercel Protection が有効な場合は、user が project の Automation Bypass secret を取得し、Stripe Dashboard 内だけで `?x-vercel-protection-bypass=<secret>` を付ける。[Vercel 公式手順](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) が Stripe 等の URL 設定による配送を案内している。完全な URL は secret を含むため証跡へ転記しない。Protection を無効化せず、既存 bypass secret をローテーションして他の Preview 検証を止めない。再配備後、署名不正の拒否と Stripe の実配送 2xx を確認してから Checkout を開始する。

## 公開順序

ProductとWebのProductionデプロイはこの順序を揃えるまで保留する。課金制限のフラグは引き続き `BILLING_ENFORCED=false` とし、未公開の45日表記を先にWebへ出さない。

1. 復元可能なバックアップと現在の権限を保存し、対象project・branch・Stripeモード・SHAを証跡に記録する。既存の復元訓練 #1879 が未完了なら本番移行は行わない。
2. **追加schemaを先に適用**する。`20260907233848_single_plan_trial.sql` と分析イベント追加は後方互換。既存の未完了購入を誤って消費済みにしないため、statusだけでは消費済みにせず、手順5の請求成功・旧trial履歴を正本として分類する。
3. **直接書き込み権限を撤去する前に、新Productコードを配備する。** activities/categories/segments/テンプレートのINSERT/UPDATEをサーバー専用経路へ移す。フラグOFFでも作成・変更・削除が通ることを確認する。
4. 新Productの本番SHAと書き込みsmoke testを証跡化してから、権限撤去migration `20260908021201_restrict_single_plan_direct_writes.sql` を適用する。続けてMCP migration `20260908022927_add_mcp_billing_access_switch.sql` を `billing_enforced=false` のまま適用し、既存のsubscriber-only判定を維持する。全migrationを旧Productへ一括先行適用しない。SELECT/DELETE・owner RLS・複合FKは保持する。古いブラウザもサーバー経由のため新コードへ到達する。
5. 既存のwrite fenceを使って利用者の書き込みを止め、Webhook処理を含む移行競合を監視する。次のread-only preflightを実行し、人数と生成SQLをレビューする。全Stripe履歴が取得できない顧客が1人でもいれば有効化しない。契約やtrial履歴のないincomplete / incomplete_expiredだけの顧客は対象から除外される。

   ```bash
   pnpm --filter @dayopt/product exec tsx scripts/billing-trial-preflight.ts /absolute/private/review.sql
   ```

   認証は `docs/operations/secrets.md` に従う。コマンド自体はDBとStripeを読み取り、ローカルSQLを作るだけで本番には書かない。生成物は顧客IDを含むためGitや公開issueへ添付しない。dry-runの後、有効化直前に再実行し、対象追加を再レビューする。既に消費済みの時刻を上書きしない。

6. 明示指示後にレビュー済み分類SQLを適用する。MCP controlの現在revisionを読み、`set_mcp_billing_enforcement_v1(true, <expected_revision>)` でMCPのapp trial判定を有効にする。その後 `BILLING_ENFORCED=true` のProductを先に配備し、実Checkoutとtrial中MCP writeを確認してから45日説明を含むWebを公開する。write fence解除後、既存未契約者の初回利用で45日が一度だけ始まることを確認する。
7. 下の案内文を確定して利用者へ通知する。今回の実装では送信しない。アプリ内は終了7日前から表示し、新しい催促メールcronは作らない。

## 復帰

制限の不具合は `BILLING_ENFORCED=false` で停止し、MCPは現在revisionを使って `set_mcp_billing_enforcement_v1(false, <expected_revision>)` へ戻す。開始済み・消費済み日時とStripe情報は残し、再有効化で45日を再発行しない。Web表示も同時に停止時の説明へ戻す。

Productのコードを権限撤去前の版へ戻す場合、先に新経路を維持した修正版を用意する。旧版へ単純revertすると作成が拒否される。やむを得ず旧権限へ戻す場合は、postgresだけが実行できる `private.restore_single_plan_direct_write_grants_v1()` を明示指示後に呼び、migration前のtable grantへ戻す。復旧後に全6テーブルのSELECT/INSERT/DELETE、更新可能な4テーブルのUPDATE、利用者自身の作成・編集・削除を確認し、制限をOFFのままにする。新しい日時列は削除しない。外部予定・接続・tokenを課金終了に合わせて削除しない。

## 既存利用者向け案内案

日本語：Dayoptは、すべての機能を月 $5 で利用できるサービスになります。これまで有料契約や無料体験をご利用でない方は、変更後に初めてアプリを開いた時から45日間、カード登録なしで全機能をお試しいただけます。期間終了後も保存済みカレンダーとレポートの閲覧、データのエクスポート・削除はできます。作成・編集・同期などを続ける場合は設定から購入できます。既存の契約と約束済みの体験期間は維持されます。

English: Dayopt is moving to one plan with all features for $5/month. If you have not previously subscribed or used a subscription trial, your 45-day card-free trial starts when you first open the app after this change. When access ends, you can still view your saved calendar and reports, export your data, or delete it. Subscribe in Settings to resume creating, editing and syncing. Existing subscriptions and promised trial periods are preserved.

## 計測

`queries/billing-cohorts.sql` はread-only集計。45日終了はprofilesの保存済み期限から算出する。初回支払と更新支払はStripeの請求成功イベントから数える。週をまたぐ再利用は開始後7日以上14日未満の予定・記録作成またはレポート閲覧。観測期間、人数、未成熟体験、更新を観測できる人数を別々に出し、未成熟者を未転換者として評価しない。90日のイベント保持期間より古い売上の正本はStripeとする。
