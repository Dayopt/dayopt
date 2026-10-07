---
status: current
last_verified: 2026-10-01
---

# Dayopt サービス棚卸し — 2026-10-01

## 結論と対象範囲

依頼の8サービスに、repoで使うGoogle OAuth/Calendar、Upstash、UptimeRobot、Turnstile、R2、MCP OAuth、Vercel browser telemetry、support SMTP、Pwned Passwords、任意の開発サービスを加えて整理した。さらに公開登録情報でName.com、GitHub Settingsで6つのInstalled Appsを発見した。

[expected.yaml](./expected.yaml)に**95検査定義・60接続・23取得制約**を登録し、全定義に今回の結果または未確認理由を付けた。16 collectorはサービスの集約単位であり、外部事業者数ではない。アカウント全体、repo外の手動接続、組織webhookまで網羅したとの保証はない。

**棚卸し一覧の整備と、実態を100%検証したことは別。実態確認は未完了。** 自動取得は100結果、pass 45 / drift 0 / blocked 36 / manual 19 / not_applicable 0、終了コード2。passには安全なmetadataの取得成功や正本ファイルの存在も含む。残り55結果を正常・不存在・設定欠落として扱わない。MCP/UIの補足証拠は以下に分け、doctorのblockedを自動でpassへ変換していない。

期待値は正本の契約、ここは日時付き観測。移行方針を即時違反にしない。秘密値、顧客行、メール本文、Redisデータ、認証付きURL、生API応答を記録しない。サービス設定・権限・資格情報は変更していない。

Googleアカウント・非本番clientの切り替えはユーザー指定で別セッションが担当する。こちらは既存証拠と未確認理由を引き継ぐ。切り替え完了やGoogle実接続の成功をこの棚卸しから主張しない。

## 取得元・確認日時

時刻はJST。API値とMCP/UIの取得時刻は異なるため、単一の原子的snapshotではない。

| 証拠 | 取得元・日時                                                                                      | 範囲と限界                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A    | Node 24 / `op run` API/CLI、2026-10-01 10:50:31（全実行終了時刻。各行に確認時刻）                 | 95定義すべてに結果。HEAD `5fafc6fad2c43d5bf4960f8860a1d626b0ff8eb1`と今回の未コミットdoctor差分。生レポートはrepoに保存しない |
| B    | Supabase read-only MCP、10:21–10:25                                                               | main / persistent Integration branch metadata。管理API 404をbranch不存在と解釈しない                                          |
| C    | Vercel read-only MCP deployment metadata、10:38頃。公開Product `/api/health/version`はAでも再取得 | Production Product/WebとIntegrationの配信SHA。project APIのconnector入力不整合は設定欠落ではない                              |
| D    | Resend read-only MCP domain / webhook一覧、10:23–10:25                                            | sending domain 1件、webhook 2件。signature secretは取得・表示しない                                                           |
| E    | Cloudflare認証済みDNS/Turnstile UI、10:26–10:38。公開registry RDAPはAでも再取得                   | DNS全16行、DNSSEC、widgetの利用hostname。R2/backup scopeの詳細は9/30履歴                                                      |
| F    | Sentry既存agent資格情報でproject GET、10:39–10:40                                                 | 安全なprivacy列だけ。イベント本文・API応答全体を出力しない                                                                    |
| G    | UptimeRobot既存read-only key、`getMonitors`読み取りPOST、10:41                                    | Dayopt monitor 1件、通知連絡先の件数/typeのみ。宛先・通知本文・通知テストなし                                                 |
| H    | GitHub認証済みrepo Settings、10:43–10:54                                                          | Installed Apps 6件、production-release/opsのsecret名、repository hooks一覧。App権限・組織hooksは未取得                        |
| I    | [9/30の棚卸し](./inventory-2026-09-30.md)・[切り分け記録](./triage-2026-09-30.md)                 | 過去の値。今回未再取得の項目に現行一致と付けない                                                                              |

## サービスごとの観測

| 対象                           | 安全に射影した実測値                                                                                                                                                                                                  | 判定・残る確認                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                         | A: `Dayopt/dayopt` public / main、repo merge commitのみ。ruleset active、required checks 5、最新main必須、thread解決必須、bypass actors 0。environment 14                                                             | APIのenvironment secret名とhooksは403。Hでrelease 4名、ops 16名、repo hooks表示0件を補足。組織hooks・App権限・secret値一致は未確認                                                                                          |
| GitHub Apps                    | H: ChatGPT Codex Connector / Claude / Claude Design Import / Slack / Supabase / Vercel                                                                                                                                | 接続App名を確認。対象repo selection、各権限、Slack workspace/channelは未確認。観測App一覧を必須install方針にしない                                                                                                          |
| Vercel                         | C: Product/Web Production READY、main SHA `9f1eaea488efddb1ffedc967a749e75fa37217a4`。Integration READY、branch integration、SHA `1494df3ecb1e2d02e558b25d1cc6f34e30178b82`。A: Product version `0.35.0` / `9f1eaea4` | ci資格情報を現agent経路で取得できず、env全件・branch override・secret replicaは未確認。Integration公開healthは保護により401。任意Previewは対象deployment未選択                                                              |
| Supabase                       | A/B: Production `yvglwblxrnrenfifsnje`、Integration `tilwaprottpyhlfoggbb` persistent / branch integration / with_data false / ACTIVE_HEALTHY。Production Auth・Storage監査はpass                                     | 管理API branch/backupは403、Integration project GET404はMCP実在と区別。PreviewごとのDB選択、schema全体・cron契約・restoreは未検証                                                                                           |
| Supabase migrations            | A+C: Production DB/Git双方303 version、最新 `20260930020816`。Integration双方296、最新 `20260928044000`。各配信SHAの直下active migration集合とmissing/extra双方0                                                      | `_archive`を比較対象から除外。version集合一致はmigration本文、ACL/RLS、schema一致やrestoreの証明ではない。checkout契約を未配信のまま適用済み扱いしない                                                                      |
| Supabase cron                  | A: Production pg_cron 5 / heartbeat 8、Integration pg_cron 5 / heartbeat 5                                                                                                                                            | metadata件数。cron実行・Google同期・通知・削除処理は実行していない                                                                                                                                                          |
| Stripe Test                    | A: account `acct_1TBpLoRRjoh5xfrs`、active Test price 2。期待price `price_1UDGzDRRjoh5xfrs4MMbK2rb`はUSD 500/month。Test webhook enabled、Integration `/api/webhooks/stripe`、5 events、API `2026-02-25.clover`       | account/price/webhook一致。古いactive priceも1件あり。実billing、Vercel配信account/mode/flag、signature master一致は未確認                                                                                                  |
| Stripe Portal / Live           | A: Test default Portal active、customer update / invoice history / payment update / cancellation enabled、subscription update disabled、default return URL null                                                       | session return URLの契約は別確認。Liveの5検査はhuman資格情報を読めずblocked。IのLive account/price/webhook値を現在値に昇格しない                                                                                            |
| Resend                         | D: `dayopt.app` verified、ap-northeast-1、sending enabled / receiving disabled、open/click tracking off。DKIM / send MX / SPF verified                                                                                | Product hook enabled、6 events、`https://app.dayopt.app/api/webhooks/resend`。Web hook enabled、4 events、`https://dayopt.app/api/webhooks/resend`。API/CLI master認証はblocked。sender、Auth Edge、署名replica一致は未確認 |
| Cloudflare DNS                 | A/E: NS colin/keira、app/mcp CNAME `cname.vercel-dns-017.com`、apex MX Cloudflare Routing、send MX SES ap-northeast-1、SPF/DKIM/DMARCは期待条件と一致                                                                 | DNS UI全16行。DNS only。DNSSEC disabled、multi-signer/multi-provider off。送受信の実動作や転送先アカウントは未検証                                                                                                          |
| Name.com / domain registration | A/E: registry RDAPのregistrar Name.com, Inc. / IANA 625。`dayopt.app`期限2027-01-05 10:10:42 JST、delegationSigned false、NS colin/keira                                                                              | Cloudflare UIのregistry表示をregistrarと混同しない。自動更新、支払担当、account recoveryは既存管理資格情報/reader未確認                                                                                                     |
| Turnstile                      | E: Managed widget、4 hostname `app.dayopt.app`, `dayopt.app`, `localhost`, `vercel.app`、pre-clearance off                                                                                                            | `vercel.app`の許可範囲は要検討。Previewのdummy key・production keyの配信選択は未検証。UIの未保存フォームを変更していない                                                                                                    |
| R2 / backup                    | A: 直近main scheduled run `36799675098`のStorage→R2 job成功（10:09）。I: avatars/attachments、35日locks、公開URL/custom domainなし、旧storage-backup参照と差異                                                        | job成功はbucket中身・retention・restore成功ではない。現在のR2管理API/token scopeはblocked。9/30のscope/旧bucket 404は履歴の懸念として残す                                                                                   |
| Sentry                         | A/F: dayopt / dayopt-web、最新releaseはProduction SHAと一致。両project非公開、dataScrubber / defaults true、scrubIPAddresses false、custom PII configあり、sensitive field 41、verifySSL false                        | privacy列はAPIで読める。custom PII ruleの実効IP処理、sampling、source map適用は未検証。legacy release files 0はsource map不存在の証拠ではない                                                                               |
| PostHog                        | A: project 625917、直近7日environment集計はPreview 12。project設定API403、MCP project:read不足                                                                                                                        | Production等の行なしは当該窓内の集計だけ。Iのprivacy設定は今回未再取得。有効なProduct Previewの削除credential、同意、送信/削除挙動は未検証                                                                                  |
| Upstash                        | A: 既存agent masterでPING成功。I: dayopt Personal/Free、ap-northeast-1、TLS有効、default ACL広い権限                                                                                                                  | PINGは環境分離証拠ではない。masterと配信先の一致・Integration分離は未確認。通常Preview local化のPR #2995は10:43時点OPEN/draft/未merge、適用済み扱いしない                                                                   |
| UptimeRobot                    | A/G: monitor 803514022、`https://app.dayopt.app/api/health`、up、300秒。alert contact 1件、type 2（email）、threshold 0 / recurrence 0                                                                                | 既存APIで通知metadataを取得可能。受信アカウントや実通知到達は未確認。APIで返らないcontact statusを推測しない                                                                                                                |
| Google Auth / Calendar         | I: 非本番Cloud project / AuthとCalendar clientを用意。10:43 Vercel UIでIntegration-scoped Calendar env更新metadataを確認                                                                                              | 別セッションが切り替え中。値を再表示せず、旧callback差異が現在も残る/直ったとは判断しない。最新provider client、配信、Calendar authority、実接続は担当セッションの証拠待ち                                                  |
| MCP OAuth                      | A: Production issuer/resource discoveryは契約一致、ソース正本あり                                                                                                                                                     | Claude / ChatGPT / Cursor登録callback、clientごとのwrite fence、明示PreviewのDB/Redis分離・実交換は別確認                                                                                                                   |
| Browser telemetry              | A: 正本あり。10:38 Vercel Product Analytics / Speed Insightsのaggregate表示あり                                                                                                                                       | Product/Webの同意制御、masking、project toggle・配信env全件は未検証。aggregate表示からprivacy成功を推測しない                                                                                                               |
| Support SMTP / Gmail           | A: 専用SMTP資格情報とsenderの正本あり                                                                                                                                                                                 | Gmailの送信元設定・SMTP replica一致未確認。メール送信なし                                                                                                                                                                   |
| Pwned Passwords                | A: 正本あり                                                                                                                                                                                                           | provider可用性と配信password flowは未検証。パスワード入力・password range照会なし                                                                                                                                           |
| 開発サービス                   | A: Jev / Vercel AI Gateway契約あり                                                                                                                                                                                    | budget / key scope / expiryの現行metadata未取得。モデル呼び出しなし                                                                                                                                                         |

production-releaseのHによるsecret名は `VERCEL_AUTOMATION_BYPASS_PRODUCT`, `VERCEL_AUTOMATION_BYPASS_WEB`, `VERCEL_ORG_ID`, `VERCEL_TOKEN`。production-opsはRCLONE SOURCE/DESTのACCESS_KEY_ID・ENDPOINT・PROVIDER・REGION・SECRET_ACCESS_KEY・TYPE各6名に、SUPABASE_AUTH_AUDIT_TOKEN・SUPABASE_STORAGE_RLS_AUDIT_TOKEN・VERCEL_ORG_ID・VERCEL_TOKENの4名。両environmentはmainのみ、required reviewer/wait timerなし、administrator environment bypassあり。これはmain rulesetのbypass actors 0とは別制御。既存の期待値を変えず記録した。

## 差異・怪しい箇所・移行方針

| ID                                | 根拠・発生条件・影響                                                                    | 現在の扱い / 次の確認                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Google旧callback差異              | Iの非本番Auth callbackと当時のclient選択に差異。誤clientならredirect mismatchで認証不可 | 別セッションで変更中。現在値未確認。最新Console / Supabase provider / deploymentの三点を担当側で照合     |
| Preview Redis分離                 | shared masterのPINGしか証明していない。通常Preview local化PRは未merge                   | 要確認。PR merge・配信・branch override後に比較。ここではPR操作なし                                      |
| Turnstile hostname範囲            | Eで `vercel.app` を含む。Dayopt Previewを超える許可範囲になり得る                       | リスク確認。現行hostname契約・dummy keyの配信選択と照合。勝手に縮小しない                                |
| R2旧bucket/scope                  | Iでstorage-backup参照と実bucket、広いbackup/source credential scopeに差異               | 履歴の懸念。現行token/bucket/locksと正本照合が必要。backup成功で解消扱いしない                           |
| DNSSEC                            | A/Eでdelegation署名なし / UI disabled                                                   | 設定観測。必須化方針未確定のため即時driftではない。registrarとDNS両側の現行契約確認                      |
| Sentry privacy / source fetching  | FのscrubIPAddresses falseとverifySSL false。custom PII configあり                       | scrubIPAddresses単独で漏洩とは断定しない。安全なPII rule射影とsource fetch契約を確認。appのTLS設定とは別 |
| Stripe旧active Test price         | Aで期待price以外に旧Test price 1件                                                      | 旧checkout/session依存未確認。追加価格を機械的に削除しない。利用契約を照合                               |
| master / replica                  | Vercel Secret、GitHub Actions secret、Auth Edge等の存在/名前は値一致を証明しない        | 秘密再表示不可や現在の認証境界を区別してunknownを残す                                                    |
| private化 / Production activation | public repo、Production Stripe/PostHog未有効                                            | private化は移行advisory。課金・計測の有効化は独立gate。今回の違反として数えない                          |
| Production revision               | 10:21の旧SHA `9c397468`から10:38に`9f1eaea4`へ更新                                      | 後のpublic versionとdeployment metadataは一致。取得窓の差を継続driftとしない                             |

## APIで読めない項目とUIでの確認方法

「UIで確認した」と「APIが存在しない」を分ける。API提供がないと確定した独立項目は今回0件。API資格情報やreaderが足りない項目をUI専用と断言しない。機械可読な詳細はexpected.yamlの`ui_only`（名前は互換用）に23件ある。

| 分類                                            | 対象                                                                                                                                    | 確認方法 / 制約                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 現在のAPI権限・資格情報では取得不可             | GitHub secret名/hooks、Supabase branch/backup、Vercel/Cloudflareのci master、Stripe Live、Resend master、PostHog project設定            | 既存MCP/UIでmetadata補足可能なものは上記に記録。資格情報の追加や別ログインへの暗黙fallbackはしない                                                                                                                                                                                                |
| reader / connectorがない・動作しない            | Vercel project MCP入力不整合、GitHub Apps権限/組織hooks、Upstash管理DB/ACL、Google Console、registrar auto-renew、Gmail sender、Gateway | 既存DashboardのDayopt範囲で確認。Googleは別セッション。API不提供の根拠とはしない                                                                                                                                                                                                                  |
| UIでも既存secret値を再表示できない              | GitHub Actions secret、Vercel保存済みSecret、Supabase Edge secretの値/replica一致                                                       | 名前・hash・存在だけで一致としない。既存`op://`正本を参照し、未確認のまま残す。[GitHub API](https://docs.github.com/en/rest/actions/secrets)、[Vercel sensitive env](https://vercel.com/docs/environment-variables/sensitive-environment-variables)                                               |
| API GETでは既存secret値を返さず、UIでは確認可能 | Stripe webhook endpointのsigning secret                                                                                                 | Dashboardで確認できるが今回再表示しない。API未取得＝secret欠落ではない。[Stripe署名](https://docs.stripe.com/webhooks/signature)                                                                                                                                                                  |
| APIで読めるためUI限定にしない                   | Resend webhook signing secret、Sentry privacy設定、UptimeRobot alert contacts、Turnstile hostname/R2管理metadata                        | Resend GETはsecretを返し得るので未要求/未出力。SentryとUptimeRobotは安全な列のみ補足取得。[Resend GET](https://resend.com/docs/api-reference/webhooks/get-webhook)、[Sentry GET](https://docs.sentry.io/api/projects/retrieve-a-project/)、[UptimeRobot API](https://uptimerobot.com/api/legacy/) |
| metadataでは実動作を証明できない                | restore、source map適用、consent、通知到達、メール送受信、OAuth実交換、Calendar同期、課金、削除                                         | API/UI設定確認と実フローは別。読み取り棚卸しで動作成功へ変換しない                                                                                                                                                                                                                                |

## 実態確認を完了するための残件

1. Vercel Product/Webの全環境・全branch overrideのmetadataと安全な接続先を、既存の許可済み認証経路で取得し、Preview→DB/Redis、PostHog削除credential等を照合する。現在のci/human master不可を追加権限や別ログインで迂回しない。
2. Stripe Live、Cloudflare R2/backup scope、PostHog project設定、Supabase backup metadata、Upstash管理情報の現在値を取得する。既存の過去値では完了にしない。
3. GitHub Apps権限/対象repo/Slack binding・組織hooks、registrar更新/回復、SMTP/Gatewayを既存Dashboardで確認する。secret値再表示不可は最終的にもunknownが残り得る。
4. Google担当セッションから最新のclient/project/provider/配信/Calendar authorityの確認結果を受け取り、この記録と照合する。
5. source map/consent/restore/通知到達などの動作保証は別の検証範囲。ここに成功証拠はない。

権限拡張・token発行・service mutation・顧客データアクセスを伴わずに取得できないものは、未確認理由を持つ棚卸し項目として残す。**この状態を「実態100%検証済み」「全件正常」とは呼ばない。**

## 接続と全検査の対応表

接続の期待値・環境・secret参照はexpected.yamlへ集約。下記の状態はdoctorの該当check群による機械判定で、MCP/UI補足を含む完成判定ではない。実測値の要点はサービス表、追加証拠はA–Iを参照。各checkの期待値と次の確認方法は同IDの定義、取得制約は同じserviceの`ui_only`を参照する。

### 60接続

| 接続ID                         | 環境                             | from → to                                                                                                                          | 対象環境のcheck群の状態 |
| ------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `github.product.release`       | production                       | Dayopt/dayopt main / production-release → Vercel product Production                                                                | pass / blocked          |
| `github.product.preview`       | preview                          | Dayopt/dayopt PR branch → Vercel product Preview                                                                                   | blocked                 |
| `github.web.release`           | production                       | Dayopt/dayopt main / production-release → Vercel web Production                                                                    | pass / blocked          |
| `github.web.preview`           | preview                          | Dayopt/dayopt PR branch → Vercel web Preview                                                                                       | blocked                 |
| `vercel.production.supabase`   | production                       | Product NEXT_PUBLIC_SUPABASE_URL / server binding → Supabase yvglwblxrnrenfifsnje                                                  | blocked / pass          |
| `vercel.preview.supabase`      | preview                          | Product default Preview / branch override → Supabase tilwaprottpyhlfoggbb または明示した非本番branch                               | blocked                 |
| `vercel.integration.supabase`  | integration                      | Product integration branch / fixed origin → Supabase tilwaprottpyhlfoggbb                                                          | blocked                 |
| `stripe.integration.api`       | integration                      | Product Integration billing binding → Stripe Test acct_1TBpLoRRjoh5xfrs                                                            | pass / manual           |
| `stripe.integration.webhook`   | integration                      | Stripe Test webhook → https://product-git-integration-dayopt.vercel.app/api/webhooks/stripe                                        | blocked / pass          |
| `stripe.production.activation` | production                       | Product Production billing gate → Stripe Live acct_1TBpLgIe9fUk4fJW                                                                | blocked                 |
| `supabase.auth.email_hook`     | production                       | Supabase Auth email hook → https://yvglwblxrnrenfifsnje.supabase.co/functions/v1/send-auth-email                                   | pass                    |
| `supabase.edge.resend`         | production                       | send-auth-email Edge Function → Resend dayopt.app                                                                                  | pass / blocked          |
| `resend.product.send`          | production                       | product contact sender → Resend verified dayopt.app                                                                                | blocked                 |
| `resend.product.webhook`       | production                       | Resend product webhook → https://app.dayopt.app/api/webhooks/resend                                                                | blocked                 |
| `resend.web.send`              | production                       | web contact sender → Resend verified dayopt.app                                                                                    | blocked                 |
| `resend.web.webhook`           | production                       | Resend web webhook → https://dayopt.app/api/webhooks/resend                                                                        | blocked                 |
| `dns.app.vercel`               | production                       | Cloudflare DNS app.dayopt.app → Vercel Product                                                                                     | blocked / pass          |
| `dns.mcp.vercel`               | production                       | Cloudflare DNS mcp.dayopt.app → Vercel Product /api/mcp                                                                            | blocked / pass          |
| `dns.web.vercel`               | production                       | Cloudflare DNS dayopt.app → Vercel Web                                                                                             | blocked / pass          |
| `dns.resend.authentication`    | production                       | Cloudflare send / resend._domainkey DNS → Resend dayopt.app / SES ap-northeast-1                                                   | blocked / pass          |
| `dns.email.routing`            | production                       | Cloudflare apex MX / SPF → Cloudflare Email Routing → support Gmail                                                                | pass / manual           |
| `dns.dmarc.policy`             | production                       | Cloudflare _dmarc.dayopt.app → 送受信domain policy                                                                                 | pass                    |
| `dns.registration.authority`   | shared                           | dayopt.app registrar / parent delegation → Cloudflare authoritative NS                                                             | blocked / pass / manual |
| `support.gmail.resend_smtp`    | production                       | Gmail Send mail as support sender → Resend SMTP                                                                                    | manual                  |
| `turnstile.production.browser` | production                       | Product/Web public site key → Cloudflare Turnstile production widget                                                               | blocked                 |
| `turnstile.production.auth`    | production                       | Supabase Auth CAPTCHA / Product validation → Cloudflare Turnstile server validation                                                | pass / blocked          |
| `google.production.auth`       | production                       | Google Production Auth client → https://yvglwblxrnrenfifsnje.supabase.co/auth/v1/callback                                          | pass / manual           |
| `google.integration.auth`      | integration                      | Google Nonproduction Auth client → https://tilwaprottpyhlfoggbb.supabase.co/auth/v1/callback                                       | pass / manual           |
| `google.production.calendar`   | production                       | Product Production Calendar client → https://app.dayopt.app/api/integrations/google-calendar/callback                              | manual                  |
| `google.integration.calendar`  | integration                      | Google Nonproduction Calendar client → https://product-git-integration-dayopt.vercel.app/api/integrations/google-calendar/callback | manual                  |
| `redis.product.production`     | production                       | Product production rate limiter → Upstash Redis binding                                                                            | blocked / manual        |
| `redis.product.integration`    | integration                      | Product integration rate limiter → Upstash Redis binding                                                                           | blocked / manual        |
| `redis.product.preview`        | preview                          | Product preview rate limiter → Upstash Redis binding                                                                               | blocked / manual        |
| `redis.web.production`         | production                       | Web server rate limiter → Upstash Redis binding                                                                                    | blocked / manual        |
| `mcp.redis.binding`            | production, preview, integration | MCP OAuth token admission → Upstash Redis / explicit MCP Preview binding                                                           | manual / blocked        |
| `mcp.discovery.identity`       | production                       | https://app.dayopt.app issuer → https://mcp.dayopt.app resource / Product /api/mcp                                                 | pass                    |
| `mcp.client.callbacks`         | production, preview, integration | Claude / ChatGPT / Cursor OAuth clients → Product OAuth authorization / token endpoints                                            | manual                  |
| `posthog.product.ingestion`    | production, preview, integration | product browser/server telemetry switches → PostHog project 625917                                                                 | blocked / pass / manual |
| `sentry.product.runtime`       | production                       | product DSN / served release → Sentry dayopt                                                                                       | pass / manual           |
| `sentry.product.build`         | production                       | Vercel product Production build → Sentry release / artifact bundle                                                                 | pass / manual           |
| `telemetry.product.vercel`     | production                       | product DeferredAnalytics / BrowserTelemetry → Vercel Analytics / Speed Insights                                                   | manual                  |
| `posthog.web.ingestion`        | production, preview, integration | web browser/server telemetry switches → PostHog project 625917                                                                     | blocked / pass / manual |
| `sentry.web.runtime`           | production                       | web DSN / served release → Sentry dayopt-web                                                                                       | pass / manual           |
| `sentry.web.build`             | production                       | Vercel web Production build → Sentry release / artifact bundle                                                                     | pass / manual           |
| `telemetry.web.vercel`         | production                       | web DeferredAnalytics / BrowserTelemetry → Vercel Analytics / Speed Insights                                                       | manual                  |
| `sentry.auth.edge`             | production                       | send-auth-email optional reporting → Sentry Edge DSN                                                                               | pass / manual           |
| `backup.storage.r2`            | production                       | Supabase Storage via GitHub Nightly → Cloudflare R2 avatars / attachments                                                          | pass / blocked          |
| `backup.database.supabase`     | production, integration          | Supabase project database → Supabase managed backup                                                                                | blocked                 |
| `monitor.uptime.health`        | production                       | UptimeRobot Dayopt monitor → https://app.dayopt.app/api/health                                                                     | pass                    |
| `cron.vercel.product`          | production                       | Vercel Product cron scheduler → Product fixed cron endpoints                                                                       | blocked / manual        |
| `cron.supabase.metadata`       | production, integration          | Supabase pg_cron jobs → Calendar retention / revoke housekeeping                                                                   | pass / manual           |
| `cron.calendar.provider`       | production, integration          | Product Calendar cron → Google Calendar API                                                                                        | manual                  |
| `password.hibp.range`          | production, preview, integration | Product password check → https://api.pwnedpasswords.com/range/                                                                     | manual                  |
| `development.jev.gateway`      | shared                           | Developer Jev CLI → Vercel AI Gateway                                                                                              | manual                  |
| `github.app.codex`             | shared                           | Dayopt/dayopt installed GitHub Apps → OpenAI ChatGPT Codex Connector                                                               | manual                  |
| `github.app.claude`            | shared                           | Dayopt/dayopt installed GitHub Apps → Anthropic Claude                                                                             | manual                  |
| `github.app.claude-design`     | shared                           | Dayopt/dayopt installed GitHub Apps → Anthropic Claude Design Import                                                               | manual                  |
| `github.app.slack`             | shared                           | Dayopt/dayopt installed GitHub Apps → GitHub Slack                                                                                 | manual                  |
| `github.app.supabase`          | shared                           | Dayopt/dayopt installed GitHub Apps → Supabase                                                                                     | manual                  |
| `github.app.vercel`            | shared                           | Dayopt/dayopt installed GitHub Apps → Vercel                                                                                       | manual                  |

### 全95定義・100結果

期待値は同じcheck IDのexpected.yaml定義を参照する（表の括弧内は比較rule）。`取得済み`は射影metadataの取得を表し、動作の成功を含まない。reasonにAPIエラー本文は記録しない。未確認の次の確認方法は定義の`next_step`と上記残件を参照。確認時刻はJST。

#### github

| check ID（期待値rule）                                | 環境       | 判定・実測要点 / 理由                                         | 取得元                                      | 確認時刻 |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------- | ------------------------------------------- | -------- |
| `github.repository` (subset)                          | shared     | pass: 条件一致                                                | github.repository                           | 10:49:10 |
| `github.rulesets` (ruleset)                           | shared     | pass: 条件一致                                                | github.rulesets                             | 10:49:10 |
| `github.environments` (subset)                        | shared     | pass: 条件一致                                                | github.environments                         | 10:49:10 |
| `github.production-release.secret_names` (ci_secrets) | production | blocked: FORBIDDEN HTTP 403                                   | github.environment_secrets                  | 10:49:10 |
| `github.production-ops.secret_names` (ci_secrets)     | production | blocked: FORBIDDEN HTTP 403                                   | github.environment_secrets                  | 10:49:10 |
| `github.workflows` (evidence)                         | shared     | pass: 安全なmetadata取得済み（動作未検証）                    | github.workflows                            | 10:49:10 |
| `github.repository_hooks` (evidence)                  | shared     | blocked: FORBIDDEN HTTP 403                                   | github.repository_hooks                     | 10:49:10 |
| `github.backup_runs` (evidence)                       | production | pass: 安全なmetadata取得済み（動作未検証）                    | github.backup_runs                          | 10:49:10 |
| `github.installed_apps` (manual)                      | shared     | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | GitHub installed Apps / repository settings | 10:49:10 |

#### vercel

| check ID（期待値rule）                                  | 環境        | 判定・実測要点 / 理由                                                | 取得元                                                              | 確認時刻 |
| ------------------------------------------------------- | ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| `vercel.product.settings` (contract_errors)             | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.product.environment_metadata` (contract_errors) | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.product.public_bindings` (bindings)             | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.product.domains` (domains)                      | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.product.deployments` (evidence)                 | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.web.settings` (contract_errors)                 | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.web.environment_metadata` (contract_errors)     | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.web.public_bindings` (bindings)                 | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.web.domains` (domains)                          | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.web.deployments` (evidence)                     | all         | blocked: credential_or_collector_failed                              | op run / reader                                                     | 10:49:14 |
| `vercel.production.public_health` (evidence)            | production  | pass: 安全なmetadata取得済み（動作未検証）                           | public.health                                                       | 10:49:14 |
| `vercel.integration.public_health` (subset)             | integration | blocked: AUTH_FAILED                                                 | public.health                                                       | 10:49:14 |
| `vercel.preview.public_health` (manual)                 | preview     | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照        | public.health                                                       | 10:49:14 |
| `vercel.preview.database_references` (evidence)         | preview     | blocked: cross_service_evidence_missing                              | vercel.binding + supabase.branches                                  | 10:50:31 |
| `vercel.preview.mcp_build_policy` (passed)              | preview     | blocked: Preview env metadataまたはpublic bindingsを取得できません。 | apps/product/production-build-gate.mjs#assertProductPreviewBuildEnv | 10:50:31 |

#### supabase

| check ID（期待値rule）                              | 環境        | 判定・実測要点 / 理由                                         | 取得元                                                        | 確認時刻 |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| `supabase.branches` (evidence)                      | shared      | blocked: FORBIDDEN HTTP 403                                   | supabase.branches                                             | 10:49:27 |
| `supabase.production.project` (subset)              | production  | pass: 条件一致                                                | supabase.project                                              | 10:49:27 |
| `supabase.production.auth_config` (evidence)        | production  | pass: 安全なmetadata取得済み（動作未検証）                    | supabase.auth_config                                          | 10:49:27 |
| `supabase.production.auth_audit` (passed)           | production  | pass: 条件一致                                                | supabase.auth_audit                                           | 10:49:27 |
| `supabase.production.functions` (subset)            | production  | pass: 条件一致                                                | supabase.functions                                            | 10:49:27 |
| `supabase.production.backup_metadata` (evidence)    | production  | blocked: FORBIDDEN HTTP 403                                   | supabase.backups                                              | 10:49:27 |
| `supabase.production.database_metadata` (database)  | production  | pass: 条件一致                                                | supabase.database_metadata                                    | 10:49:27 |
| `supabase.integration.project` (subset)             | integration | blocked: HTTP_ERROR HTTP 404                                  | supabase.project                                              | 10:49:27 |
| `supabase.integration.auth_config` (subset)         | integration | pass: 条件一致                                                | supabase.auth_config                                          | 10:49:27 |
| `supabase.integration.auth_audit` (manual)          | integration | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | production-auth-config-audit.mjs                              | 10:49:27 |
| `supabase.integration.functions` (evidence)         | integration | pass: 安全なmetadata取得済み（動作未検証）                    | supabase.functions                                            | 10:49:27 |
| `supabase.integration.backup_metadata` (evidence)   | integration | blocked: FORBIDDEN HTTP 403                                   | supabase.backups                                              | 10:49:27 |
| `supabase.integration.database_metadata` (database) | integration | pass: 条件一致                                                | supabase.database_metadata                                    | 10:49:27 |
| `supabase.production.storage_audit` (passed)        | production  | pass: 条件一致                                                | supabase.storage_audit                                        | 10:49:27 |
| `supabase.preview_project_selection` (manual)       | preview     | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | supabase.branches                                             | 10:49:27 |
| `supabase.production.migrations` (passed)           | production  | manual: checkout契約と配信契約の同一性未確認                  | schema/cron source contracts + fixed metadata + public.health | 10:49:27 |
| `supabase.production.heartbeats` (passed)           | production  | manual: checkout契約と配信契約の同一性未確認                  | schema/cron source contracts + fixed metadata + public.health | 10:49:27 |
| `supabase.production.schema_snapshot` (passed)      | production  | manual: checkout契約と配信契約の同一性未確認                  | schema/cron source contracts + fixed metadata + public.health | 10:49:27 |
| `supabase.production.cron_schedule_review` (manual) | production  | manual: 配信migrationとのcron契約比較が必要                   | fixed database metadata / deployed migration                  | 10:49:27 |

#### stripe

| check ID（期待値rule）                               | 環境        | 判定・実測要点 / 理由                                         | 取得元                          | 確認時刻 |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------- | ------------------------------- | -------- |
| `stripe.account` (stripe_account)                    | production  | blocked: credential_or_collector_failed                       | op run                          | 10:49:38 |
| `stripe.account` (stripe_account)                    | integration | pass: 条件一致                                                | stripe.account                  | 10:49:38 |
| `stripe.active_prices` (stripe_prices)               | production  | blocked: credential_or_collector_failed                       | op run                          | 10:49:38 |
| `stripe.active_prices` (stripe_prices)               | integration | pass: 条件一致                                                | stripe.listPrices               | 10:49:38 |
| `stripe.webhooks` (stripe_webhooks)                  | production  | blocked: credential_or_collector_failed                       | op run                          | 10:49:38 |
| `stripe.webhooks` (stripe_webhooks)                  | integration | pass: 条件一致                                                | stripe.listWebhooks             | 10:49:38 |
| `stripe.portal` (evidence)                           | production  | blocked: credential_or_collector_failed                       | op run                          | 10:49:38 |
| `stripe.portal` (evidence)                           | integration | pass: 安全なmetadata取得済み（動作未検証）                    | stripe.listPortalConfigurations | 10:49:38 |
| `stripe.deployed_identity_and_billing_gate` (manual) | production  | blocked: credential_or_collector_failed                       | op run                          | 10:49:38 |
| `stripe.deployed_identity_and_billing_gate` (manual) | integration | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract             | 10:49:38 |

#### resend

| check ID（期待値rule）                          | 環境 | 判定・実測要点 / 理由                   | 取得元          | 確認時刻 |
| ----------------------------------------------- | ---- | --------------------------------------- | --------------- | -------- |
| `resend.domains` (evidence)                     | all  | blocked: credential_or_collector_failed | op run / reader | 10:49:42 |
| `resend.domain_settings` (subset)               | all  | blocked: credential_or_collector_failed | op run / reader | 10:49:42 |
| `resend.webhooks` (resend_webhooks)             | all  | blocked: credential_or_collector_failed | op run / reader | 10:49:42 |
| `resend.sender_and_signature_replicas` (manual) | all  | blocked: credential_or_collector_failed | op run / reader | 10:49:42 |

#### cloudflare

| check ID（期待値rule）                        | 環境   | 判定・実測要点 / 理由                                         | 取得元                                  | 確認時刻 |
| --------------------------------------------- | ------ | ------------------------------------------------------------- | --------------------------------------- | -------- |
| `cloudflare.zone` (evidence)                  | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.turnstile` (evidence)             | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.r2_buckets` (evidence)            | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.r2_locks.avatars` (evidence)      | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.r2_locks.attachments` (evidence)  | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.backup_credential_scope` (manual) | all    | blocked: credential_or_collector_failed                       | op run / reader                         | 10:49:56 |
| `cloudflare.public_dns.ns` (subset)           | shared | pass: 条件一致                                                | public_dns:dayopt.app                   | 10:49:56 |
| `cloudflare.public_dns.app_cname` (subset)    | shared | pass: 条件一致                                                | public_dns:app.dayopt.app               | 10:49:56 |
| `cloudflare.public_dns.mcp_cname` (subset)    | shared | pass: 条件一致                                                | public_dns:mcp.dayopt.app               | 10:49:56 |
| `cloudflare.public_dns.apex_mx` (subset)      | shared | pass: 条件一致                                                | public_dns:dayopt.app                   | 10:49:56 |
| `cloudflare.public_dns.send_mx` (subset)      | shared | pass: 条件一致                                                | public_dns:send.dayopt.app              | 10:49:56 |
| `cloudflare.public_dns.apex_spf` (subset)     | shared | pass: 条件一致                                                | public_dns:dayopt.app                   | 10:49:56 |
| `cloudflare.public_dns.send_spf` (subset)     | shared | pass: 条件一致                                                | public_dns:send.dayopt.app              | 10:49:56 |
| `cloudflare.public_dns.dkim` (subset)         | shared | pass: 条件一致                                                | public_dns:resend._domainkey.dayopt.app | 10:49:56 |
| `cloudflare.public_dns.dmarc` (subset)        | shared | pass: 条件一致                                                | public_dns:_dmarc.dayopt.app            | 10:49:56 |
| `cloudflare.registrar_metadata` (evidence)    | shared | pass: 安全なmetadata取得済み（動作未検証）                    | public.domain_registration              | 10:49:56 |
| `cloudflare.registrar_operations` (manual)    | shared | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | registrar_dashboard                     | 10:49:56 |

#### sentry

| check ID（期待値rule）                       | 環境       | 判定・実測要点 / 理由                                         | 取得元                  | 確認時刻 |
| -------------------------------------------- | ---------- | ------------------------------------------------------------- | ----------------------- | -------- |
| `sentry.projects` (subset)                   | production | pass: 条件一致                                                | sentry.listProjects     | 10:50:09 |
| `sentry.releases.dayopt` (evidence)          | production | pass: 安全なmetadata取得済み（動作未検証）                    | sentry.listReleases     | 10:50:09 |
| `sentry.release_files.dayopt` (evidence)     | production | pass: 安全なmetadata取得済み（動作未検証）                    | sentry.listReleaseFiles | 10:50:09 |
| `sentry.releases.dayopt-web` (evidence)      | production | pass: 安全なmetadata取得済み（動作未検証）                    | sentry.listReleases     | 10:50:09 |
| `sentry.release_files.dayopt-web` (evidence) | production | pass: 安全なmetadata取得済み（動作未検証）                    | sentry.listReleaseFiles | 10:50:09 |
| `sentry.applied_source_maps` (manual)        | production | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract     | 10:50:09 |

#### posthog

| check ID（期待値rule）                           | 環境 | 判定・実測要点 / 理由                                         | 取得元              | 確認時刻 |
| ------------------------------------------------ | ---- | ------------------------------------------------------------- | ------------------- | -------- |
| `posthog.settings` (subset)                      | all  | blocked: insufficient_access                                  | posthog.getProject  | 10:50:16 |
| `posthog.ingestion_aggregate` (evidence)         | all  | pass: 安全なmetadata取得済み（動作未検証）                    | posthog.aggregate   | 10:50:16 |
| `posthog.deployed_privacy_and_deletion` (manual) | all  | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract | 10:50:16 |

#### upstash

| check ID（期待値rule）                   | 環境   | 判定・実測要点 / 理由                                         | 取得元              | 確認時刻 |
| ---------------------------------------- | ------ | ------------------------------------------------------------- | ------------------- | -------- |
| `upstash.ping` (subset)                  | shared | pass: 条件一致                                                | upstash.ping        | 10:50:22 |
| `upstash.environment_isolation` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract | 10:50:22 |

#### uptimerobot

| check ID（期待値rule）          | 環境       | 判定・実測要点 / 理由 | 取得元                  | 確認時刻 |
| ------------------------------- | ---------- | --------------------- | ----------------------- | -------- |
| `uptimerobot.monitors` (subset) | production | pass: 条件一致        | uptimerobot.getMonitors | 10:50:30 |

#### google

| check ID（期待値rule）                 | 環境   | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| -------------------------------------- | ------ | ------------------------------------------------------------- | ------------------------- | -------- |
| `google.source_contract` (evidence)    | shared | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:30 |
| `google.registered_callbacks` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:30 |

#### mcp_oauth

| check ID（期待値rule）                                      | 環境       | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------- | ------------------------- | -------- |
| `mcp_oauth.source_contract` (evidence)                      | shared     | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:31 |
| `mcp_oauth.deployed_identity_and_client_callbacks` (manual) | all        | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:31 |
| `mcp_oauth.production.issuer` (subset)                      | production | pass: 条件一致                                                | public.oauth_metadata     | 10:50:31 |
| `mcp_oauth.production.resource` (subset)                    | production | pass: 条件一致                                                | public.oauth_metadata     | 10:50:31 |

#### telemetry

| check ID（期待値rule）                                     | 環境   | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------- | ------------------------- | -------- |
| `telemetry.source_contract` (evidence)                     | shared | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:31 |
| `telemetry.deployed_privacy_and_vercel_analytics` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:31 |

#### pwned_passwords

| check ID（期待値rule）                                    | 環境   | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------- | ------------------------- | -------- |
| `pwned_passwords.source_contract` (evidence)              | shared | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:31 |
| `pwned_passwords.provider_and_deployed_behavior` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:31 |

#### support_smtp

| check ID（期待値rule）                                | 環境   | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------- | ------------------------- | -------- |
| `support_smtp.source_contract` (evidence)             | shared | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:31 |
| `support_smtp.gmail_sender_and_smtp_replica` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:31 |

#### optional

| check ID（期待値rule）                                 | 環境   | 判定・実測要点 / 理由                                         | 取得元                    | 確認時刻 |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------- | ------------------------- | -------- |
| `optional.source_contract` (evidence)                  | shared | pass: 安全なmetadata取得済み（動作未検証）                    | repository_contract_paths | 10:50:31 |
| `optional.jev_gateway_budget_and_credentials` (manual) | all    | manual: metadataによる証明範囲外。サービス表 / 取得制約を参照 | repository_contract       | 10:50:31 |

## 今回のdoctor改善と検証

- agent専用の既存`op` wrapperに必要な非秘密のCodex識別子だけを子プロセスへ維持。認証tokenや別認証経路は継承しない。
- Stripe Live/Testを別の`op run`子プロセスで読む。Live認証失敗でもTest結果を残し、サービス全体の120秒上限を維持。
- `connections` / `ui_only`のschema、check・contract・secret参照、ID重複をoffline検査。架空のIntegration管理secret参照を作らない。
- 登録domainは固定の公開RDAP GETだけ。registrant連絡先を捨て、公開registrar / 期限 / NS / DNSSEC metadataを射影。自動更新等はmanual。GitHub Installed Appsをhookとは別のmanual検査として維持。
- Node 24: doctor 133 tests / 13 files passed。auth allowlist、Live失敗/Test成功、固定URL、secret非出力、未知/重複参照を回帰検査。`typecheck:scripts`、`docs:check`、`secrets:check`、offline 95定義、変更TSへの共通TypeScript ESLint設定による検査が成功。秘密値スキャンに一致していた既存ダミーfixtureは、除外せず実行時に同じ値を組み立てる形に変更。実環境runは上記の終了コード2であり、全件正常ではない。
