---
status: current
last_verified: 2026-09-30
code: apps/product/src/lib/billing/access-service.ts
---

# Stripe Integration 検証の結果と引き継ぎ

[#2867](https://github.com/Dayopt/dayopt/issues/2867) の2026-09-30時点の記録。検証済み範囲と未実行を分け、次のセッションが同じ環境で続きを実測するために残す。**全体は未完了**で、[#2869](https://github.com/Dayopt/dayopt/issues/2869) の本番開通は保留。PRのマージやこの記録の作成は開通の許可ではない。

実行手順の正本は [単一有料プランの公開手順](./billing-single-plan-rollout.md)。Issue本文の古いlocal/Docker前提より、ユーザーと合意したクラウドIntegrationを使う。Dockerは再試行しない。

## 検証環境

| 項目                     | 実測値                                                       |
| ------------------------ | ------------------------------------------------------------ |
| 固定origin               | `https://product-git-integration-dayopt.vercel.app`          |
| 最新の検証SHA            | `1494df3ecb1e2d02e558b25d1cc6f34e30178b82`                   |
| deployment               | `dpl_cRoZbbZRjhNXaHbLTY5kXoDQdPuC`                           |
| Supabase Integration ref | `tilwaprottpyhlfoggbb`                                       |
| Stripe mode / 月額       | Dayopt sandbox、`livemode=false`、USD 500 cents              |
| 最終runtime確認          | 2026-09-30 12:09 JST、version200、上記SHA/deployment/ref一致 |

再開時にはversion・branch・ref・migration・control revisionを再取得する。この表を現在の環境状態の保証として使わない。文書PRのHEADと実測SHAは別であり、最新main全体の実フローを検証したとの主張ではない。

## 完了した検証

### Stripeの購入と管理（旧SHA）

旧SHA `d5bdac2d9c464c7fbdb6dd626770dea540c58f6d` では、実Checkoutの初回失敗から成功、署名Webhookとtrial消費、Checkout eventとinvoice.paidの再送、Portalの解約予約・取消、canceled後の再購入の証跡を#2867へ残した。旧SHAの成功を最新SHAの画面・購入フロー完了へ広げない。

課金概要のキャッシュ更新修正は [PR #2971](https://github.com/Dayopt/dayopt/pull/2971) でmainへマージ済み。Integrationにはその修正を反映した1494を配備して以下を実測した。画面のfocus復帰は未実行。

### 更新・滞納・再試行（1494）

Stripe Test Clockを使い、所有契約・Invoice・署名Webhook・DB・実Product APIを照合した。DBに契約状態をPATCHして合格させたものではない。

| ケース               | JST / 結果                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| 月次更新成功         | 11:20:36、新しいsubscription_cycle Invoice paid500、attempt1、Stripe/DB/API active          |
| 更新失敗と継続利用   | 11:21:03、Invoice open/paid0、Stripe/DB past_due、API subscribed/canUseProduct=true         |
| 予定再試行による回復 | 11:21:19、正常なtest支払方法へ戻し、同じInvoiceがattempt2でpaid500、activeへ復帰            |
| 再試行尽きで自動解約 | 11:24:27〜11:26:50、同じInvoiceのattempt1〜9、最後はcanceled / payment_failed、手動解約なし |
| 自動解約後の利用権   | 11:26:50、expired/enforced=true/canUseProduct=false、カテゴリ読取200、正規作成403           |

- 今回の新契約は自動canceledで停止済み。試用の開始・終了・消費3日時は全段階で不変。
- 今回時間帯のWebhook claim25件は全てprocessed。実StripeオブジェクトとDB/API遷移を対応させた。
- analyticsは初回支払1、更新支払3、終了1で各source1件。trial開始は全履歴で1件。
- 他利用者のPlan39件/Record42件は全行JSON hashが前後一致。ほかのprofiles/categories/activitiesは件数維持を確認したが、全内容の保証へ広げない。

検証helperの例外も記録した。API作成の初回fixtureはCheckout eventを発生させず、初回active期待が失敗した。実月次subscription.updatedで同期後の更新ケースを検証した。また、同じ冪等キーの再利用で2度目の支払方法変更が再実行されず、追加の自然なtest更新支払1件が成功した。所有契約の支払方法を修正してから失敗・終端を実測し、Invoice監査にも含めた。合計test paid2000 cents、実際の金銭支払いなし。

詳しい結果は [更新4ケースの記録](https://github.com/Dayopt/dayopt/issues/2867#issuecomment-5902898903)。`unpaid` / invoice.uncollectibleは今回の終端設定では実測していない。

### 期限終了後のAPIと直接書込（1494）

既存の所有確認済みsynthetic clock fixtureだけを使用。認証時は未開始/freeでtrial3日時null。認証後に開始・終了2時刻をCASで人工的な期限終了へ設定し、**同じJWT/cookies**で以下を確認。finallyで元のnullへCAS復元した。実signup、自然な45日経過、実Stripe、UIの証拠には数えない。

| ケース                                                            | 結果                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Plan/Record/Activity/Categoryの既存内容                           | 実tRPC200、ID・内容一致                                                                            |
| 設定・請求概要・外部接続/予定API                                  | 200。外部接続/予定は空fixtureで、実Google予定の表示証明ではない                                    |
| 週/月/年レポート・アクティビティ明細                              | 200。全期間の集計値の正確さを保証する検証ではない                                                  |
| export                                                            | 200、既存4種類のID・内容が含まれる                                                                 |
| Category作成、Activity作成/編集、Plan/Record作成/編集、日単位確定 | 計8件403 / FORBIDDEN / Product access has ended                                                    |
| 本人JWTでData API直接INSERT/UPDATE                                | categories/activities/plans/records計8件403 / 42501 / permission denied for table                  |
| 本人JWTで作成RPCを直接呼出                                        | create_plan_command_v1 / create_record_command_v1の2件403 / 42501 / permission denied for function |
| 本人Data API読取                                                  | 既存Record SELECT200、ownerと内容一致                                                              |
| 所有データ・fixture復元                                           | 4テーブル各1行の全行SHA256前後一致、trial2時刻とprofile復元一致                                    |

[API12件・export・通常書込8件](https://github.com/Dayopt/dayopt/issues/2867#issuecomment-5903078547) は11:44 JST、[直接書込10件](https://github.com/Dayopt/dayopt/issues/2867#issuecomment-5903167602) は11:53 JSTに完了。adminは所有確認・前後snapshot・人工期限の設定/復元だけに使用し、probeは本人JWTで実行した。

## 未完了と担当Issue

残件は親Mission [#2610](https://github.com/Dayopt/dayopt/issues/2610) の子Issueで追跡し、結果を#2867へ集約する。

| 後続Issue                                                                                  | 再開条件                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [#2979 Redis接続・MCP実クライアント](https://github.com/Dayopt/dayopt/issues/2979)         | 専用接続値のユーザー保存、限定設定/配備/gate操作の範囲確認  |
| [#2980 実登録・課金画面・Google期限境界](https://github.com/Dayopt/dayopt/issues/2980)     | Chrome復旧、規約/Google権限、共有Calendar実測の限定保留解除 |
| [#2981 最終Stripeケース・停止復帰・Go/No-Go](https://github.com/Dayopt/dayopt/issues/2981) | 前2件の完了、最終SHA固定、環境終了/復元範囲の確認           |

### MCP / Redis

- MCP GETは最新確認でも503 / -32000 / Rate limit service unavailable。
- Preview共通のRedis URL/TOKENは存在するが、integration専用overrideは0件。ユーザーは専用Redis用意済みと回答した。
- Vercelの既存CLI認証でGETした両変数にはvalueが返らず、Redis PING未実行。configurationIdはnull。値の空欄・instance不存在・token無効を断定しない。
- `MCP rate limit check failed` は設定済みlimiter.limitの例外分岐。通常ログは固定メッセージのみで、元の例外はSentryへ渡す。根本原因は未確定。
- Vercel連携一覧APIは必須view不足の400が3回続き、この経路を停止した。provider一覧は未取得。

接続値の保存は公開手順にあるユーザー操作。Vercel Productで `UPSTASH_REDIS_REST_URL` と同じ専用instanceの標準 `UPSTASH_REDIS_REST_TOKEN` を **Preview / Git branch integration限定**に保存する。tokenはSensitive。共通PreviewやProductionは変更せず、値をチャット・Issueへ貼らない。rate limiterは書込を必要とするためread-only tokenでは不足する。

保存後はmetadataの2変数を照合し、共有レーンの限定配備範囲を確認して同じコードSHAを再配備する。新deploymentのversion/ref/SHAと503解消を確認してから、開始時control・現在revision・許可範囲を確認し実MCPクライアントを検証する。401やmetadata200だけでOAuth/tool完了にしない。

### 実登録・画面・Google

Chromeは管理ポリシー確認不能でアクセスを拒否した。公開されたトラブルシュートにagentが解除する手順はなく、別browserやshellで迂回していない。

実signup、複数タブ・再ログイン、focus復帰、未保存入力、複製/import、実Google権限/同期/変換/解除、保存バッチ境界、短い開始済み操作は残件。[Calendar実測手順](./calendar-integration-rehearsal.md) の共有環境保留・専用カレンダー・権限境界を守る。

### 最終同一SHAと停止・復帰

現在SHAのCheckout/画面復帰/解約/再購入/Webhook再送と、`unpaid` の隔離方法の判断が残る。SHAが変われば既存の結果を新SHAの実証へ自動で移さない。

最終停止は未実行。次の順で行う。

1. runtime/ref/SHA、保存済み開始時control、現在revision、所有fixtureと契約を照合する。
2. run所有の残るactive test契約だけを停止する。今回の更新契約はcanceledだが、既存の再購入test契約は保持されている。履歴・非公開対応表を残す。
3. 共有データ基準を再照合し、想定外の差分なら停止する。
4. 現revisionのCASでcontrolを開始時の保存値へ復元する。不明なら実行しない。
5. 許可されたintegration限定でrehearsal/billing false・MCP client空を同時に再配備する。
6. 復元後runtime・gate・trial非再発行・共有データを確認し#2867へ記録する。

## 非公開証跡の保持

ローカルartifact bundle `billing-2867-20260930-pr2971` は元worktree削除前に退避済み。実行済みhelper、manifest、JSON証跡、画像、check/pre-push出力を保持している。Customer ID、メール、JWT/cookie、秘密値、magic linkはこの文書/PRへ入れない。引き継ぎ先に所有対応表がなければ、推測で既存契約を変更しない。

再利用用helper v2は別ファイル。冪等キーにrun・操作・所有Subscription/Invoice/period・path・正規化payloadを含め、キー生成の5testsと構文確認は成功。v2での実Stripe再実行は未実施。通信結果不明時はinspectで照合し、実行途中に旧版から差し替えない。

新しい検証を始める前に `pnpm ctx 2867 --reuse-brief-l1` と後続Issue本文を読む。briefが無い/古い場合はIssue・実測・現行runbookから続ける。
