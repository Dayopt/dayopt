---
status: current
last_verified: 2026-09-08
public_docs:
  - faq/pricing
  - api-mcp
lp:
  - 'API and MCP access'
---

# 課金と利用期間

月 $5 の単一有料プランと、カード不要の45日間無料体験。実装と本番有効化は別であり、公開順は[移行手順](../../operations/billing-single-plan-rollout.md)に従う。`BILLING_ENFORCED` の既定値はfalse。本番の設定値はこの文書から推測しない。

## 利用状態

正本は `packages/billing/src/access.ts` の `resolveBillingAccess`。Stripeの請求状態とアプリの体験日時を分離する。

| 状態   | 条件                                     | 通常利用                   |
| ------ | ---------------------------------------- | -------------------------- |
| 未開始 | 体験の開始・消費がなく、現在の契約もない | 認証済みアプリを開いて開始 |
| 体験中 | 開始時刻以上、終了時刻未満で未消費       | 全機能                     |
| 契約中 | `active` / `trialing` / `past_due`       | 全機能                     |
| 終了後 | 体験の期限到達、消費済み、契約終了       | 保存済み情報の閲覧と管理   |

`profiles.app_trial_started_at`、`app_trial_ends_at`、`app_trial_consumed_at` は本人が変更できない列。開始と終了の差は1080時間で固定する。複数タブ・再ログインは条件付きUPDATEで開始を再発行しない。期限ちょうどで終了。表示は利用者設定のtimezoneで行い、timezone変更で期間は変わらない。

初回アプリ表示の `billing.startTrial` mutationだけが開始する。登録・LP閲覧・バックグラウンド同期・MCPでは開始しない。既存未契約者は公開後の初回アプリ表示から開始する。現在および過去の契約者・Stripe trial経験者は公開前の分類で消費済みにする。未完了購入だけの履歴は除外する。既存Stripe trialの期限は延長も短縮もしない。

## 操作境界

`apps/product/src/lib/billing/operation-access.ts` が通常のmutationを既定で制限し、本人の管理操作を明示的に許可する。`protectedProcedure` はJWTの契約claimではなく最新profileから判定し、同じprocedure内の追加判定へ結果を引き継ぐ。既存 `entitledProcedure(key)` は移行互換の入口として残るが、キーによる機能差はない。

| 終了後も許可                                     | 終了後は拒否                                               |
| ------------------------------------------------ | ---------------------------------------------------------- |
| 保存済みカレンダー・週/月/年レポート・明細       | 予定・記録・アクティビティ・テンプレート等の作成/編集/複製 |
| データexport、削除、アカウント削除               | インポート、Google接続、新規同期                           |
| 連携解除、認証・プライバシー・表示設定、請求管理 | MCP/API/iCalフィードの通常利用                             |

レポート生成機能は新設しない。見積もりの算出方法も利用状態で変えない。保存済み外部予定は終了後も表示する。接続情報・tokenを削除せず、再契約後は通常の同期経路で再開する。通常操作は開始時に判定し、長時間同期は保存バッチごとに再判定する。

Data APIの直接INSERT/UPDATEは閉じ、既存のservice-owned commandと固定userIdの書き込みを使う。SELECT/DELETEのowner RLSと複合FKは保持する。MCPのDB認可も体験期限を認識し、既存のtoken/scope/resource/失効チェックを維持する。

## 画面と購入

`BillingAccessProvider` はアプリ表示時に開始し、期限到達・focus・定期再取得で最新状態へ合わせる。期限切れや照会失敗でも開いている入力をunmountせず、サーバーで拒否した楽観更新は既存mutationのrollbackで戻す。Inspectorに未保存の入力を残し、利用再開後は本人が保存し直す。自動再送しない。

設定は料金・残り日数・終了日時・契約状態・購入/請求管理へ整理する。終了7日前からアプリ内案内を出す。新しい催促メールは送らない。

購入は既存Checkoutを利用する。新方式ではStripeの7日trialを付けない。購入成功時点で契約開始し、署名・provider照合済みの `invoice.paid` で体験を消費する。新方式のCheckoutはカード決済に限定し、入金前のactive状態が長期間残る非同期決済を追加しない。中断やincompleteだけでは消費しない。解約予約は期間終了まで利用でき、更新のpast_due中も継続する。unpaid/canceledで終了後へ移り、再契約に追加の体験は付けない。

Checkout/Portal復帰は既存のquery処理と有限pollingを再利用する。成功画面へのアクセスだけでは課金や支払成功を確定しない。

### 再送とURLの契約

- `operationId` はクライアントが intent ごとに生成する。同じ通信結果不明の手動再試行では再利用する
- operation ID は component の生存期間で保持する。reload 後の明示操作は新しい intent とする
- inputなしの旧ブラウザbundleは移行期間中だけserver-generated operation IDで受ける
- Checkout と Portal は別の operation ID を使う。同期的な二重クリックは client-side lock で拒否する
- Stripe POST の前に DB state を `provider_started` へ commit する
- Customer / Checkout / Portalの作成前にAPI keyのaccount IDとtest/live modeを設定値へ照合する
- Customer / Checkout / Portal は用途別の namespaced idempotency key を使う
- Provider response が不明な間だけ同じ key で再送する。DB の23時間 cutoff後は provider POST を行わない
- cutoffの5分前から新しいprovider POSTを開始しない
- redirect URL はHTTPS、Stripeの用途別host、default port、userinfoなしを必須とする
- redirect URL は監査claimと分離した private tableに保存する
- Portal URLは5分、Checkout URLは10分で失効する。残り30秒未満のURLは返さない
- URL失効後は同じ operation を再実行しない。明示的な次のクリックで新しい operation を開始する
- provider requestが再送可能な間はアカウント削除開始を拒否する
- Customer作成の応答が不明なまま23時間を過ぎた場合は、アカウント削除側がuser metadataでexact検索してprofile bindまたはabandonを完了するまで削除開始を拒否する
- アカウント削除開始後は既存URLを削除し、Checkout / Portal の作成・redirectを行わない。open Checkout SessionはCalendarやStorageより先にexpireし、最終Billing stepでも再列挙する

## Webhookと計測

| イベント                        | 処理                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `checkout.session.completed`    | 実際のSubscriptionを読み、請求状態を同期                                    |
| `customer.subscription.updated` | 現在のStripe statusを内部statusへ写す                                       |
| `customer.subscription.deleted` | exact Customer/subscriptionを終了。削除中・古いsubscriptionは既存保護で除外 |
| `invoice.paid`                  | 金額が正のsubscription_create/cycleを初回/更新支払として区別                |
| `invoice.payment_failed`        | 既存の支払失敗通知。削除済み利用者には送らない                              |

支払イベントは請求ID由来の安定したIDで重複排除し、保存失敗時はWebhookを失敗させ再送を受ける。画面復帰の旧 `subscription_started` は購入確定人数に使わない。体験開始/終了の人数はprofilesを正本とし、終了記録用cronは作らない。read-only集計は `docs/operations/queries/billing-cohorts.sql`。観測期間・人数・未成熟コホートを分ける。

**セキュリティ**:

- `stripe-signature` ヘッダーを `stripe.webhooks.constructEvent()` で検証
- durable経路の有効化後は、署名検証後かつDB更新前にconfigured API keyで同じEventとcurrent AccountをStripeから5秒上限で取得する。event ID、type、作成時刻、live/test mode、Connect account、設定済みaccount IDを照合し、Webhook secretとAPI accountの取り違えをfail closedにする。以後の業務入力には署名payloadではなく、照合済みprovider Eventを使う
- Dayoptはplatform accountのWebhookだけを扱う。Stripe Connect由来のeventは拒否し、Connect対応時はaccount contextを含む別契約を設計する
- `createServiceRoleClient()` で RLS をバイパス（Webhook にはユーザーコンテキストがないため）
- Customerを持つeventはlive profileまたは30日間の削除receiptへ分類する。どちらにも一致しないCustomerは成功扱いにしない
- account削除のterminal receiptはCustomer IDのSHA-256、記録時刻、30日expiryだけをprivate schemaへ保持し、既存maintenance cronでbounded cleanupする。並列cleanupでlock中の期限切れ行も残件として報告する

account削除フローはgeneric operationをcommitしてからStripe subscriptionをcancelするため、そのcancel eventは`account_deleting`となり通知されない。通常の解約eventがgeneric operationより先に確定した場合は通常解約として通知する。

---

## 環境変数

| 変数名                            | 用途                         | 設定場所                                        |
| --------------------------------- | ---------------------------- | ----------------------------------------------- |
| `STRIPE_SECRET_KEY`               | Stripe API シークレットキー  | サーバーサイドのみ (`src/env.ts`)               |
| `STRIPE_ACCOUNT_ID`               | 固定するStripe account ID    | `acct_...`。削除前のprovider identity照合に使用 |
| `STRIPE_LIVEMODE`                 | 固定するlive/test mode       | liveは`true`、testは`false`                     |
| `STRIPE_WEBHOOK_SECRET`           | Webhook 署名検証シークレット | サーバーサイドのみ                              |
| `NEXT_PUBLIC_STRIPE_PRO_PRICE_ID` | 単一有料プランの Price ID    | サーバー側 Checkout 設定値。UI 表示制御にも使用 |

**注意**: `STRIPE_SECRET_KEY` が未設定の場合、`getStripe()` は `null` を返す（graceful degradation）。`STRIPE_ACCOUNT_ID`と`STRIPE_LIVEMODE`はdurable経路を有効にする前の必須checkpointであり、`STRIPE_SECRET_KEY`と3項目をまとめて設定する。アカウント削除はAccount APIとBalance APIで両方を照合し、不一致または確認不能ならidentityを残す。

---
