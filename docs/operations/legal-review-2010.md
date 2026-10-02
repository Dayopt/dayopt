---
status: current
last_verified: 2026-10-01
---

# 法的ページの最終レビュー資料（#2010）

状態：**レビュー原稿。公開承認ではない**。初回調査日：2026-09-17。再照合日：2026-10-01。再照合の基準main：`67dcc653266b45ddf53e9d50cc44ec6c2c58672b`（統合コミット `9484df76a0f76ff3217d53baa5b101e87f4ccdb2`）。本番・契約の未確認事項は下表のまま残る。

日英6ページの原稿と、この証拠・判断表を一緒に確認する。[#2010](https://github.com/Dayopt/dayopt/issues/2010) は User が選択した「レビュー準備完了」で終了し、法務承認・本番の証拠回収・公開は [#2832](https://github.com/Dayopt/dayopt/issues/2832) が追跡する。同意撤回の常設導線は実装済みだが、通信停止の実測は [#2831](https://github.com/Dayopt/dayopt/issues/2831) に残る。未達の公開条件は解消済みにしていない。

## 最新mainとの再照合（2026-10-01）

今回の統合は競合なし。日英6ページを現在のコードと照合し、Privacy / Cookies の次の事実ずれを補正した。法的な適用判断・契約承認は未完了。

- 保存領域の手動消去を案内していた同意撤回の説明を、Webフッターの「Cookie設定」とProductの「設定 > データ管理 > Cookie設定」に更新。[Web操作](../../apps/web/src/shell/privacy/CookieConsentSettings.tsx)、[Product操作](../../apps/product/src/features/settings/components/DataSettings.tsx)を確認。origin別のブラウザ同意とアカウントのPostHogサーバー同意を区別した。#2831の2026-09-30照合どおり、実SDKの通信停止は未確認。
- [PostHogの共有Cookieと識別](../../packages/observability/src/posthog-browser.ts)、[Productの識別呼出](../../apps/product/src/app/_components/PostHogProductAnalytics.tsx)に合わせ、同意済みのウェブサイト閲覧とProductアカウントUUIDが関連付くことを明示。[内部利用記録](../../apps/product/src/lib/analytics/product-events.ts)には同意設定の判定がなく、Supabase内の操作種別・UUID・時刻の記録は別に継続する。内部分析の法的根拠と異議申立てはHUMAN-02。
- [PostHogの公式保持説明](https://posthog.com/docs/data/events-retention)のFreeプランの1年は参照期間であり、削除期限の保証ではない。現在の契約プランと実際の削除期限は未確認。アカウント削除で要求する対象はProduct UUIDであり、未連動の匿名イベントを含むとは保証しない。HUMAN-05を継続。
- [45日体験の定義](../../packages/billing/src/access.ts)と[起算処理](../../apps/product/src/lib/billing/access-service.ts)は実装済み。旧7日体験の定義も残るため、コードの存在だけで本番表示・有効化を保証しない。[課金検証の記録](billing-integration-rehearsal.md)ではStripeの購入・更新等を一部実測済みだが、同一最終SHAでの画面・実登録・全フローは未完了。[課金移行資料](billing-single-plan-rollout.md)、[#2867](https://github.com/Dayopt/dayopt/issues/2867)、[#2869](https://github.com/Dayopt/dayopt/issues/2869)の本番有効化と原稿公開を合わせる。

Google由来内容のMCP等への移転、事業者情報、国外移転契約、バックアップ・ログの実保持期限、返金・責任条項の判断は引き続き未達。以下のHUMAN確認票を公開承認の条件とする。

## 原稿の読み方

1. Privacy → Terms → Cookies → 返金 → 特商法 → Security の順に日英を確認する。
2. 原稿の `HUMAN-01`〜`HUMAN-09` は未確定の事実・判断・実装条件。HUMAN-10は全体の公開承認。注記を消すだけでは完了せず、以下の証拠が必要。
3. 月$5・カード不要45日体験・体験終了時自動課金なしを原稿の前提とした。**本番の有効化を確認したという意味ではない**。[#2610](https://github.com/Dayopt/dayopt/issues/2610) の有効化と公開時期を合わせる。
4. [#2670](https://github.com/Dayopt/dayopt/pull/2670) が Privacy / Terms / 法務契約テストに重なる。merge順に関わらず、本原稿と再照合し、古いAI・料金・保持保証を復活させない。
5. 更新日は「レビュー原稿」。最終承認時に適用日を確定する。draft PRのまま保持し、現状のままmainへmergeしない。

原稿の正本は [MDX（日英各5ページ）](../../apps/web/content/legal)、[返金の日本語本文](../../apps/web/messages/ja/legal.json)、[英語本文](../../apps/web/messages/en/legal.json)。返金ページはMDXではなく翻訳JSONを読むため両方を確認する。

ローカルの実ページは Node 24 で `pnpm --filter @dayopt/web dev --port 3108` を実行し、`http://localhost:3108/ja/legal/privacy` から確認する。日英の `/legal/{privacy,terms,cookies,refund,tokushoho,security}` を確認対象とする。開発環境の下部注意表示とは別に、各原稿内にも未承認箇所を表示している。

## #2010 の公開条件8項目との対応

「コード確認」は現在の実装を読んだ証拠、「テスト確認」は指定環境で検証した範囲。いずれも本番の通信・管理画面の設定・委託契約を保証しない。

| 元の条件                                                                | 確認した事実・証拠                                                                                                                                                                                                                                           | 原稿での対応                                                                  | 公開までの残件                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同意前にbrowser Sentry / Analytics / Speed Insightsが一切ロードされない | [Product計測](../../apps/product/src/lib/analytics/DeferredAnalytics.tsx)、[Web計測](../../apps/web/src/shell/privacy/BrowserTelemetry.tsx)は同意で描画。両appの `instrumentation-client.ts` はSentryを静的importし、初期化・送信を同意で制御                | 「SDKコードの読込」「初期化」「送信」を分離。旧条件の字義どおりの無読込は未達 | HUMAN-09。常設撤回UIは実装済み。#2831でproduction相当の実SDK通信を、同意中に送信を捕捉できる正の対照を含めて検証。無読込を引き続き要求する場合はSDK遅延読込の別実装が必要       |
| Sentryにbody/email/query/Cookie/Authorizationが入らない                 | [除去処理とhook](../../apps/product/src/lib/sentry/scrub-pii.ts)、共有observability、Web sanitizer。関連テストあり                                                                                                                                           | 除去処理を行う事実を説明し、全経路の完全除去を未測定で断定しない              | HUMAN-05/09。server/edge/browserの合成payload、span、breadcrumb、別の送信経路を確認。Sentryの実保持期間も必要                                                                   |
| OAuth scopeが読み取り最小                                               | [GOOGLE_AUTHORIZATION_SCOPES](../../apps/product/src/features/external-calendar/schemas/google.ts)：openid/email + calendarlist.readonly + events.readonly。旧広域scopeは既存接続の受入互換に残る                                                            | 新規要求する権限を明記                                                        | [#1963](https://github.com/Dayopt/dayopt/issues/1963)の2026-08-17接続実測を歴史的証拠として参照。公開前に現行認可URLと同意画面を再確認。closeだけをGoogle審査完了の証拠にしない |
| 切断時にtoken/選択/同期/予定が削除される                                | [disconnect](../../apps/product/src/features/external-calendar/server/connection-service.ts)、[account deletion](../../apps/product/src/features/external-calendar/server/account-deletion.ts)。参照済みの取り込み済み予定、権限取消しの再試行・証跡は別扱い | 一律即時削除を避け、切断とアカウント削除を区別                                | HUMAN-05。現行gate・workerで切断/再接続/削除終端/失敗回復を隔離環境で検証し、本番cleanupのread-only証拠と照合                                                                   |
| AIへのGoogle由来データ混入なし、またはAIなし確定                        | [strategy §4](../strategy.md)は内蔵AIなし。Product/Webのruntimeでモデル呼出を確認していない。開発用JevのAI SDK依存は利用者向けAIの証拠ではない。ただしMCPは予定・記録のtitle/noteを返す                                                                      | 内蔵AIを削除し、外部AIは別の受領者として説明。外部の学習禁止は保証しない      | HUMAN-04。下の経路表を反証し、Google方針に適合する除外／選択／説明の実装・検証を完了するまで未達                                                                                |
| 削除後の実保持期間がカテゴリ別に判明                                    | SQLの期限・cleanup実装は存在。外部サービス・バックアップ・法定保持期間は未確認                                                                                                                                                                               | カテゴリ別表を追加し、未確認値を明示                                          | HUMAN-05。下の保持表の空白を設定証拠で埋める                                                                                                                                    |
| 記載プロバイダーと実依存が一致                                          | app依存と呼出経路、[monitoring](monitoring.md)、[復旧資料](disaster-recovery-drill.md)を照合。Cloudflare R2とPostHogが旧一覧から漏れていた                                                                                                                   | 10提供者に統合。内蔵モデル提供者を削除し、R2とPostHogを追加                   | HUMAN-03/05。Productionの非秘密設定メタデータ・実送信先・契約主体を照合。開発用AIツールは利用者データ処理の提供者と混同しない                                                   |
| 出力と30日猶予が動く、または約束を実態へ合わせる                        | [user-service](../../apps/product/src/features/auth/server/user-service.ts)がJSON対象を定義し、削除時にauth userを削除。[CSV変換](../../apps/product/src/features/settings/lib/timeblock-csv-export.ts)は予定・記録の明細                                    | 削除前出力を案内。削除後の猶予は除去。契約終了後の閲覧・出力権は維持          | 実装と原稿の照合は完了。HUMAN-07で課金有効時の出口と本番の提供状態を確認。JSONにメール・請求・ログの全量が含まれるとは約束しない                                                |

## Google由来データと外部への出口

この表はコードで到達可能な経路を示す。法的な許容判断や、本番で第三者へ送信した実測ではない。

| 経路                                | 証拠                                                                                                                                                                                                                                    | 確認事項                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Google → external_calendar_events   | [google provider](../../apps/product/src/features/external-calendar/server/providers/google.ts)のfieldsはid/status/summary/description/start/end。構造化した参加者等は要求しない                                                        | 説明欄にメール・会議URLが書かれることはある。「参加者情報等は一切保存しない」という全面保証は不正確                                  |
| 取り込み済み予定 → 自身の予定・記録 | [timeblock command](../../apps/product/src/features/timeblock/server/timeblock-command-service.ts)のexternalCalendarEventId/source、関連付けを持つread model                                                                            | 出自の識別子があることと、出力内容から由来情報が除外されることは別                                                                   |
| 予定・記録 → MCP                    | [MCP read client](../../apps/product/src/features/timeblock/server/mcp-timeblock-read-client.ts)のselect/transformがtitle/noteを含む。[detail tool](../../apps/product/src/app/api/mcp/_tools/timeblock-detail.ts)はscopeを検証して応答 | sourceを理由とした本文除外／実行単位opt-inはこの経路で確認できない。内部IDの除去やprompt injection対策はデータ最小化の代替にならない |
| 予定 → iCalendar feed               | [calendar route](../../apps/product/src/app/api/v1/calendar/[token]/route.ts)がtitle/noteを取得                                                                                                                                         | 秘密URLを知る購読アプリへの配信。接続解除とURLの失効、取得済みコピーの保持を区別                                                     |
| 予定・記録 → JSON/CSV               | user-serviceのexportDataとDataSettingsの出力                                                                                                                                                                                            | 利用者自身への出力と、第三者AIへの自動配信を区別する                                                                                 |

**推奨**：HUMAN-04で、Google由来の内容を外部AIに既定で渡さない境界を先に定める。現行の包括的な接続scopeを実行単位のopt-inと読み替えない。[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)と[Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)に対して実装を確認する。必要な修正Issueを#2832から追跡する。

## カテゴリ別保持・削除の証拠表

| カテゴリ／管理者                  | 起算点・コード上の期限                                                                                | 削除／失敗の扱い                                                                                                                                                                                                 | 本番・契約の確認（HUMAN-05）                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| auth/profile/予定/記録/設定       | アカウント存在中。成功したaccount deletionが主データを削除                                            | Calendar→Storage→Billing等の準備後にauth削除。gateで互換／durable経路が変わる                                                                                                                                    | 有効gate、削除終端、失敗時の再試行。全テーブルのCASCADEを推測だけで保証しない                                             |
| Google credentials/outbox         | 更新直後の権限取消し待ち認証情報に24時間期限。通常接続と再試行用を区別                                | encrypted outbox/worker/fence。失敗時は期限処理と観測が必要                                                                                                                                                      | 有効worker、期限超過、孤立した認証情報が無いこと                                                                          |
| Google authority記録              | created/settled基準のdelete_after、最大90日。cleanupは4時間の余裕を持って削除対象化                   | [retention migration](../../supabase/migrations/20260812071342_add_calendar_authority_retention_safety_margin.sql)                                                                                               | hourly配線だけで実削除を保証しない。最近成功・期限超過件数・監視を確認                                                    |
| OAuth code/access token           | 使用済み／失効から24時間経過後にcleanup対象                                                           | [OAuth cleanup](../../supabase/migrations/20260810070002_add_oauth_retention_cleanup_rpcs.sql)、bounded batch                                                                                                    | 起算点とcronの遅延を含む実際の上限                                                                                        |
| OAuth refresh token               | 実効的な終端から30日経過後にcleanup対象                                                               | 同上                                                                                                                                                                                                             | 同上                                                                                                                      |
| OAuth connection                  | revoke/reauth期限から90日経過後にcleanup対象                                                          | 同上。関連情報をCASCADE／detach                                                                                                                                                                                  | 同上。90日で削除対象となる規則を90日以内の削除保証と混同しない                                                            |
| MCP mutation receipts             | 作成から90日。origin connectionと独立して保持する場合あり                                             | [receipt lifecycle](../../supabase/migrations/20260729073126_mcp_stage1_receipt_generation_lifecycle.sql)                                                                                                        | backlog、cleanup最近成功、アカウント削除との関係                                                                          |
| product_events                    | created_atから90日。auth userへのCASCADEあり                                                          | [product analytics](product-analytics.md)、[migration](../../supabase/migrations/20260802013954_add_product_events.sql)                                                                                          | cronの成功、期限超過、処理目的と同意の境界                                                                                |
| PostHog analytics events          | Freeプランの一般規則は1年の参照期間。実契約プラン・削除期限は未確認。参照期間を削除期限と読み替えない | [削除処理](../../apps/product/src/lib/analytics/posthog-deletion.ts)：UUIDに対し`delete_events: true`を非同期依頼。送信有効時のkey欠落・要求失敗はアカウント削除を止める。両送信OFFかつ削除keyなしでは要求を省略 | HUMAN-05。過去の収集後に送信を止めても削除keyと依頼稼働を維持。契約プラン・実削除期限・完了状態・匿名イベントの扱いを確認 |
| Supabase DB backup/PITR           | **未確認**                                                                                            | provider backup expiry。復元すると削除済みデータが戻る可能性                                                                                                                                                     | 契約プラン、履歴、設定保持日数、復元時の削除再適用の責任者                                                                |
| StorageのR2 backup                | 運用資料に35日のBucket Lock。**最大保持期間ではない**                                                 | [storage backup](../../scripts/ci/storage-backup.sh)のrclone syncとmax-delete。ロック／失敗／同期停止で削除が遅れる                                                                                              | lifecycle、削除再試行、実稼働、期限切れ件数。過去の復元演習だけでは期限証明にならない                                     |
| Sentry/Axiom/Vercel/Supabase logs | **未確認**                                                                                            | 各提供者の設定・契約。アカウント削除とは独立                                                                                                                                                                     | データセットごとの保存地域・保持設定・削除手段・法的例外                                                                  |
| Upstash                           | リクエスト識別子・counterのTTL                                                                        | endpointにより制限窓が異なる                                                                                                                                                                                     | active Redis、TTL最大値、provider backup                                                                                  |
| Stripe/請求帳簿                   | **法定期間・契約未確認**                                                                              | provider上のcustomer削除と請求証跡消去は別                                                                                                                                                                       | 適用される税・会計期間、請求データの管理者、問い合わせ窓口                                                                |
| Resend/Cloudflare Email/Gmail     | **実保持期間未確認**                                                                                  | 配送ログ・メールボックス・返信・ごみ箱・backupは別                                                                                                                                                               | 問い合わせ完了後の削除周期、担当者、法的保全例外                                                                          |
| 外部AI/MCP clientの受領済みコピー | 外部提供者の契約次第                                                                                  | Dayoptでrevokeしても受領済みコピーは削除されない                                                                                                                                                                 | 接続時の説明と外部提供者への削除請求方法                                                                                  |

## 人間への確認票

担当の「事業者」はこのサービスの運営者。「専門家」は事業者が指定する法務担当。技術検証は実装担当が実施し、事業者が公開判断をする。

| ID       | 担当・質問                                                                 | 推奨する進め方／必要な証拠                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HUMAN-01 | 事業者：個人／法人のどちらか。正式名称・所在地・電話と公開可能な情報は何か | 確認済みの情報を入力。特商法の省略は条件と遅滞なく開示できる運用を先に確認。Footerの`Dayopt, Inc.`とも一致させる。私的住所を公開Issueへ貼らない                                                                 |
| HUMAN-02 | 事業者＋専門家：対象国・適用法・年齢規則、サーバー利用分析の根拠は何か     | 対象国・売上／人数等の適用条件を確認。GDPR/CCPAの全面適用を推定しない。児童・保護者・権利請求の運用を確認。PostHogの任意同意と、同意設定によらない内部Supabase利用分析の根拠・異議申立てを別に確認              |
| HUMAN-03 | 事業者＋専門家：各提供者の契約主体・DPA・保存地域・移転根拠は何か          | PostHogはproject 625917 / US Cloudを含めて実契約と設定メタデータを非公開で保管。SCC締結済みや日本からの同意取得済みを推測しない。[PPC指針](https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/)と照合 |
| HUMAN-04 | 実装担当＋専門家：Google由来内容をどの条件で外部AIへ渡せるか               | 上記の経路を検証し、既定除外または必要な操作単位の選択を実装・テスト。本文だけで適合扱いしない                                                                                                                  |
| HUMAN-05 | 事業者＋実装担当：保持表の全カテゴリの実際の期限を証明できるか             | 設定値、確認日、最近の削除成功、期限超過0件または解消手順を記録。PostHogの実契約プラン・参照期間・削除期限とstatus、送信停止後の削除依頼稼働、匿名イベントの削除扱い、バックアップ復元後の再削除を含む          |
| HUMAN-06 | 事業者＋専門家：権利請求、事故、改訂通知は誰がいつ扱うか                   | 本人確認・担当・期限・例外・受付履歴・通知経路を決め、support/securityの受信を確認。規約同意の文面版と時刻の記録が必要かを判定                                                                                  |
| HUMAN-07 | 事業者＋実装担当：採用済み料金の提供状態と実決済表示は一致するか           | #2610、#2670に加え#2867のStripe test mode実フローと#2869の本番有効化を照合。45日体験のコードと旧7日定義を区別し、起算・購入／解約・通貨・税込総額・最終確認画面を確認。決済設定変更は別途承認                   |
| HUMAN-08 | 専門家：責任・返金・管轄の最終条項は適切か                                 | 強行的な消費者保護を残し、責任上限／例外を確定。#2832で追跡する削除済み6条項（分離・完全合意・譲渡・不可抗力・サービスの知財帰属・補償）の復活または削除を承認。固定SLAを無条件に引き継がない                   |
| HUMAN-09 | 実装担当：同意を後から簡単に撤回でき、通信が止まるか                       | #2831。導線は実装済み。両originで初回拒否→許可→再訪→撤回→別タブ反映・reloadを実測。同意中の送信捕捉を正の対照に置き、送信先を遮断。Cookie名・localStorage・TTL・初期化・キュー・navigation由来送信を分けて記録  |
| HUMAN-10 | 事業者：全条件の証拠を読んで公開を承認するか                               | 日英の全レビュー注記を解消。公開用変更で全法的本文のHUMAN／レビュー日付が残れば失敗する検査へ切替え、現行のHUMAN存在assertを反転（#2832）。承認者・日付・対象SHAを記録。その後に公開指示と公開後の12URL確認     |

## 検証の再現方法と限界

Node 24を使用する。Node 26ではDOMテストのlocalStorageが環境エラーとなったため、指定バージョンで実行する。

```bash
pnpm --filter @dayopt/web exec vitest run legal-document-contract refund/page.test.tsx legal-content CookieConsent BrowserTelemetry PostHog instrumentation-client sentry-runtime-config
pnpm --filter @dayopt/product exec vitest run src/lib/analytics/DeferredAnalytics.test.tsx src/lib/analytics/posthog-deletion.test.ts src/lib/analytics/posthog-server.test.ts src/lib/sentry/scrub-pii.test.ts src/features/auth/server/user-service.test.ts src/features/settings/lib/timeblock-csv-export.test.ts src/features/settings/components/DataSettings.analytics-consent.test.tsx src/features/settings/server/analytics-consent-service.test.ts src/features/external-calendar/server/account-deletion.test.ts src/features/external-calendar/server/google-provider.test.ts src/features/external-calendar/server/connection-service.test.ts src/app/api/mcp/_tools/list-tools.test.ts src/lib/billing/access-service.test.ts
pnpm check
pnpm docs:check
```

- 初回改訂前に追加した意味の検査は Privacy/Terms/Security の日英6ケースで失敗。未提供AI・旧料金・Prisma等を検出した。2026-10-01の再照合では、Privacy / Cookiesの日英4ケースが補正前に失敗し、補正後は成功。
- 法務描画のhash/構造を変更後の実レンダリングで更新し、未提供機能の再導入検査、保持表・出力範囲・外部AIの説明、返金実ページの日英表示検査を追加した。hash一致だけを事実の証明にしない。
- 初回準備（2026-09-17）の対象検査はWeb 45件・Product 217件が成功。全体検査で旧providerキーを前提とした検査を発見し、Email Routing・Gmail・保持確認箇所を検査する形に修正後、Web全43ファイル・315件が成功した。今回の再照合結果とは区別する。
- 今回の対象検査はWeb 8ファイル・60件、Product 13ファイル・262件が成功（上記コマンド、Node 24）。全体検査の結果・対象SHAはPR #2833に記録する。
- 2026-10-01にローカルNext.jsの12URLすべてHTTP 200と本文・レビュー日付を再確認。ブラウザではPrivacyの新しい本文と、初回「必須のみ」選択後にフッターから拒否状態の設定を再表示できることを確認。初回準備時の幅390pxや返金の言語切替の確認とは区別する。開発モードは計測を無効化するため、本番同意制御の証明にはしない。
- DB/外部providerの統合検証、本番の保持期限、実送信先、契約内容はこの原稿準備で確認済みにしない。#2832に明示的に残す。
- DB依存の再確認は[Cloud Previewの実行前照合](../engineering/testing.md#cloud-preview-の実行前照合2910移行中)の分離・readiness条件を先に満たす。対象はcalendar authority retention／account deletion／gateの統合検証。今回DB統合検証は未実施。skipは合格扱いしない。共有DBや本番を初期化しない。

実行結果の件数・コマンド・SHAはdraft PRと#2010の終了コメントに記録する。コード変更後は関連検証を更新する。

## 公開前に使う一次資料

- [個人情報保護委員会：外国にある第三者への提供](https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/)
- [消費者庁：通信販売広告](https://www.no-trouble.caa.go.jp/what/mailorder/advertising.php)と[通信販売のルール](https://www.no-trouble.caa.go.jp/what/mailorder/rule.html)
- [European Commission：GDPRの適用](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en)
- [California Attorney General：CCPA](https://www.oag.ca.gov/privacy/ccpa)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [Google Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)（2026-10-01に確認。MCP等の操作単位の同意・文脈とモデル学習への利用制限を含む）
- [PostHog：イベントの保持と参照期間](https://posthog.com/docs/data/events-retention)（2026-10-01に確認。参照期間は削除手段ではない）

これらは論点を確認する一次資料であり、Dayoptへの適用や契約締結を証明しない。初回2026-09-17の資料と今回再確認したGoogle・PostHogの条件を基に、専門家が公開時点の適用と契約を確認する。
