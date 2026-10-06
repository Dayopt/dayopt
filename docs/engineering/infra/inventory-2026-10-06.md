---
status: current
last_verified: 2026-10-06
---

# Dayopt サービス棚卸し — 2026-10-06

目的は、重要なサービス設計を人とagentが見失わず、日常の実態・変更・未観測を追えるようにすること。全検査を正常にすることは完了条件にしない。期待値は[expected.yaml](./expected.yaml)、実行方法は[doctor.md](./doctor.md)、前回の観測は[10/5の記録](./inventory-2026-10-05.md)を参照する。

## 台帳と運用の追加

- 17サービスに役割、停止時の影響、再確認のきっかけ、設計の正本参照を追加。108検査定義、62接続、28取得制約を登録した。
- 検査定義は条件比較49件、metadata・正本の取得確認36件、手動確認23件。`--coverage`は宣言の一覧であり、外部設定を確認済みとは扱わない。
- 1Passwordのmaster/replica/アクセス・復旧境界、Cloudflare Email Routing・zone運用・復元可能性、Sentry通知・token権限を独立した確認項目にした。item参照やmetadata取得だけでは証明できない部分を残す。
- Supabase GitHub連携によるDB/Edge配信責任と、Vercel Integrationによるenv注入責任を区別。Google Auth/CalendarはProduction/非本番のcallback契約を明示したが、Console変更・実OAuth確認は別セッションの範囲。
- Registrarはpublic registry上の登録事業者と販売/管理画面を区別し、古い文書だけから現在の管理先を断定しない。
- `--record`は安全に射影した結果をGit管理外のcheckout別履歴へ保存。`--history`は同じ対象範囲の直前記録と比較する。初回は未比較、保存失敗時も結果を残してプロセス終了コード3。自動定期実行は設定していない。
- 期待値と登録した正本のfingerprintを記録し、設計変更と実測driftを区別する。生API応答、資格情報、顧客行、メール本文は保存しない。

## 全サービス実行

主担当がNode 24で`pnpm exec tsx scripts/doctor/cli.ts --record --format json`を実行した。取得元は既存`op run`子プロセスのAPI/CLI reader、固定のread-only SQL、公開DNS/RDAP、repo正本。既存ログインや別資格情報へ切り替えていない。

- レポート確認時刻: **2026-10-06 09:20:17 JST**。各結果にも取得時刻と取得元を保持。
- 実行repo HEAD: `0f189028b29ee93b6087a75d6667a37e67131461`。今回の未コミット追加を含むcheckoutから実行した。HEADだけでは作業中の正本内容を特定できないため、fingerprintも保持した。
- 期待値baseline: `650f62dc733831765aa8c110e29533b532e023f2`。baselineは現在の台帳を保存したcommitとは異なる。
- expected fingerprint: `3d7878dbc76e7557fa3d73935daa3b1b51b769c5e568f6c8d766db4c9fa7b755`
- source contract fingerprint: `5c121d22da848108e9ca5ffff3fe9579b66f833bfab58240dc42d8944d6eded3`
- **113結果: pass 53 / drift 1 / blocked 38 / manual 21 / not_applicable 0、終了コード1**。108定義すべてに結果があり、未登録結果は0件。環境別結果があるため定義数とは異なる。
- 初回履歴として保存され、`--history`は「未比較（前回記録なし）」を返した。passには取得成功だけの検査も含むため、53件の実動作成功を意味しない。

| サービス                                                                               | pass | drift | blocked | manual |
| -------------------------------------------------------------------------------------- | ---: | ----: | ------: | -----: |
| GitHub                                                                                 |    5 |     0 |       3 |      1 |
| Vercel                                                                                 |    1 |     0 |      13 |      1 |
| Supabase                                                                               |   11 |     1 |       4 |      3 |
| Stripe                                                                                 |    4 |     0 |       5 |      1 |
| Resend                                                                                 |    0 |     0 |       4 |      0 |
| Cloudflare                                                                             |   10 |     0 |       6 |      4 |
| Sentry                                                                                 |   10 |     0 |       2 |      2 |
| PostHog                                                                                |    1 |     0 |       1 |      1 |
| Upstash                                                                                |    1 |     0 |       0 |      1 |
| UptimeRobot                                                                            |    1 |     0 |       0 |      0 |
| Google / MCP OAuth / telemetry / Pwned Passwords / support SMTP / optional / 1Password |    9 |     0 |       0 |      7 |

## 差異と未観測

差異は`supabase.production.heartbeats:production`の`billing-reconciliation: missing or duplicate heartbeat`。今回の観測はheartbeat監査の失敗であり、cronは実行していない。現行routeにはStripe identity未構成時にheartbeat記録より前で戻る経路がある。監査の期待条件、配信中契約、実際の有効化設定を突き合わせる必要があり、この結果だけでcron障害や原因を断定しない。

取得不能38件は、資格情報解決/collector失敗25件、HTTP 403が6件、明示的な不足権限3件、AUTH_FAILEDが1件、HTTP 404が1件、サービス間証拠不足1件、Preview env/public bindings欠測1件。APIエラー本文は保存しない。404や読めないVaultを、リソース/itemの不存在と扱わない。

Vercel接続設定、Resend設定、Cloudflare非公開metadataなどは今回再確認できていない。過去のUI/API観測をこのrunの成功へ置き換えない。Google Console、実メール配送、secret replicaの値一致、復元、実通知も確認済みにはしない。確認方法・所在の記録規則は台帳の`ui_only`、各結果の`next_step`、`manual_access_policy`に残してある。

## 1Password項目の所在確認（11:20 JSTごろ追記）

ユーザーと1Passwordアプリの項目一覧を確認し、「1Passwordに入っているなら正しい」というユーザー確認を受けた。値・field・notesを開かず、項目名とVaultだけを観測した。`agent`・`ci`・`human`がGUIに存在することは確認できたが、Service AccountのVault権限を確認した証拠にはしない。

- Vercel・Supabase・Cloudflare・Sentry・PostHog・Upstash・UptimeRobotの7サービスのログイン項目を、`expected.yaml`の`resources.human_onepassword_items`へ記録した。確認は項目の所在・用途に限り、provider設定・配布済みsecretとの一致は未確認。
- Supabaseのログイン項目は`supabase-login t3-nico's Project`。最初に見えた`supabase`とは別項目であり、項目名中のproject名をDayopt接続先の期待値へ昇格させない。
- GitHub・Stripeのログイン項目もhumanに見えたが、正確な項目名に個人メールを含むため転記していない。所在の存在確認とlocatorの未完成を分けて記録した。
- human一覧46件、dayopt/resendタグ4件の確認ではResendログイン項目を特定できなかった。`resend-send`・`resend-support-replies`・`resend-web`・`resend`の項目名は見えたが、ログイン項目やfieldの証明とはしない。他Vaultに存在しないとは判定しない。
- Gmail管理用ログインの所在は未特定。Googleの作業は引き続き別セッション。台帳・入力Page以外の設定、1Password項目、認証権限は変更していない。

今回の確認は上記のAPI実行結果を更新しない。1Passwordのitem存在だけでDoctorのprovider確認・復旧確認をpassへ変えない。

ciの一覧も6件すべてを観測した。`vercel-production`、`supabase-auth-audit`、`supabase-storage-rls-audit`、`Supabase-StorageS3-backupsource`、`Cloudflare-R2-storagebackup`、`sentry-release-token`。正本のci item一覧と名前が一致し、`resources.ci_onepassword_items`に所在・確認日・確認主体を記録した。用途・fieldの期待値は`source_contracts.secrets`を参照し、複製しない。fieldの存在、現在のprovider権限・期限、GitHub/Vercel等のreplica一致は今回確認していない。

追記後にNode 24で`pnpm run doctor --offline`を実行し、108検査定義と正本参照の整合を確認した（認証・通信なし、終了コード0）。`pnpm docs:check`も成功。今回の変更は所在metadataのみで、readerや判定処理の変更・実環境APIの再実行はない。

## 11:49–11:52 JSTのUI / MCP追補

サービス設定は変更せず、環境変数の値・署名secret・メール本文を開かずに確認した。この追補は11:31のDoctor実行とは別の証拠であり、自動結果の件数は書き換えない。

| 項目                           | 取得元と観測                                                                                                                                                                                                                                                                                                                   | 判定と残る範囲                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel ProductのStripe binding | ChromeのProduct → Environment VariablesでProject / Sharedを確認。全環境のProject検索では`STRIPE_WEBHOOK_SECRET`、`STRIPE_ACCOUNT_ID`、`NEXT_PUBLIC_STRIPE_PRO_PRICE_ID`、`STRIPE_SECRET_KEY`、`STRIPE_LIVEMODE`の5項目がすべてPreview / `integration`。ProductionのProject、Productionと全環境のShared検索はいずれも該当なし。 | `production_activation: pending`と整合。現設定のmetadataは確認できたが、配信済みdeploymentが保持する値やcronの実行分岐は証明しない。 |
| Resend送信domain               | 接続済みMCPのdomain一覧・detail。`dayopt.app`はverified、sending enabled、receiving disabled、Open / Click Tracking false。DKIM / sending用DNSもverified。                                                                                                                                                                     | 期待設定と一致。送信実行・実配送・送信key scopeの証明ではない。                                                                      |
| Resend Product webhook         | MCP webhook一覧。`https://app.dayopt.app/api/webhooks/resend`、enabled。eventは`email.bounced`、`email.complained`、`email.delivered`、`email.delivery_delayed`、`email.failed`、`email.suppressed`。                                                                                                                          | 接続先・状態・event集合が期待値と一致。署名secretの配布先一致と受信処理の成功は未確認。                                              |
| Resend Web webhook             | MCP webhook一覧。`https://dayopt.app/api/webhooks/resend`、enabled。eventは`email.bounced`、`email.complained`、`email.failed`、`email.suppressed`。                                                                                                                                                                           | 接続先・状態・event集合が期待値と一致。署名secretの配布先一致と受信処理の成功は未確認。                                              |
| Cloudflare管理画面             | Chromeで既存Dashboardを開いたがサインイン画面だった。                                                                                                                                                                                                                                                                          | 現在のログイン待ち。zone / Turnstile / R2等の非公開metadataは未取得。資格情報の不存在とは扱わない。                                  |

Resendのendpointは10/5の早い時刻にも確認記録があり、後のMCP応答では省略されていた。今回は再取得できたため、「MCPではendpointが常に取得不能」という取得制約の記述を更新した。期待値そのものは変更していない。

続いてVercel MCPのdeployment detailを`app.dayopt.app`から取得し、Production `READY`、deployment `dpl_hpdetJQXMNgMLhvAQutTSzDky3CK`、SHA `47f5d7c414317192bcd173255c092a29cdee0035`を確認した。公開versionのSHAと一致する。応答には環境変数bindingが含まれず、配信時点のStripe設定の証拠には使えない。生応答・creator情報は保存していない。

### 残作業の整理

1Passwordのhuman・ci項目について、今回ユーザーと確認した所在は記録済みであり、その確認を再入力してもらう必要はない。GitHub / Stripeの正確な項目名の省略、Resend / Gmailログインの所在未特定は上の記録どおり残す。以下は所在の確認とは別に、実設定・権限・動作の証拠が必要なもの。

| 分類                                     | 確認済みの範囲                                                                                                                                        | 残りと次の確認方法                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production heartbeatの差異               | billing activation pending、現Vercel設定にProduction Stripe bindingなし、配信SHAのrouteは未設定時にheartbeat記録前でreturn。                          | 配信deploymentのbinding / 既存cron実行metadataを読む。意図した未稼働と常時heartbeat要求の衝突を解決する。cronを発火せず、差異を消すためだけに期待値を緩めない。                                                         |
| GitHub / Supabase / Vercelの接続metadata | 10/5にenvironment secret名・branch policy・webhook、Supabase branch / backup / Storage / RLS、Vercel alias / protection / env bindingの補足証拠あり。 | GitHub Appの権限・repo選択・pending詳細、古いPreview Config型7項目の所有者と利用先、Supabase branchのその後の状態、配信deploymentとの一致。既存metadataを読む。                                                         |
| Resend / Stripe / Upstash                | Resend domain / webhook、Stripe Test price / webhook / Portal、Upstash DB / ACLを確認済み。                                                           | Resend key scope / Auth Edge sender、Production Stripe Live metadata、追加Test priceの意図、実deploymentのRedis接続先とtokenのACL対応。secretは表示しない。通常PreviewのRedis分離PRは別の変更として配信状態を照合する。 |
| Cloudflare                               | 公開DNS・メール認証・registryの証拠あり。                                                                                                             | 管理画面ログイン後にzone / DNSSEC / Email Routing / Turnstile / R2 lock・lifecycle・権限metadataを確認。object本文やtoken値を読まない。                                                                                 |
| Sentry / PostHog                         | Sentry project / org privacy / release metadata、PostHog project / privacy / authorized URL / Production送信停止の補足証拠あり。                      | Sentry hook一覧とTLS設定の対象、source map適用、通知先。PostHog Doctor読取scope、削除credentialとruntimeの配線、古いPreview許可URLの意図。個人event / personを取得せず、削除しない。                                    |
| 配布先secret・実動作・復旧               | 1Passwordの所在と既存master参照、backup runや監視設定のmetadataあり。                                                                                 | masterとreplicaの一致、実メール / 通知、復元可能性はmetadataだけでは証明できない。読み取りで到達できる範囲と、別途実行を伴う確認を区別する。Google OAuth / Calendarは別セッションの証拠を参照する。                     |

`blocked`はDoctorの自動取得経路の状態、上表は補足証拠を含む棚卸しの状態。両者を混同して未確認件数や完了率を算出しない。日々の自動追跡を広げるためのreader権限整備と、設計を把握するための確認も別に管理する。

## 検証とレビュー

### 11:56–12:02 JST Cloudflare Dashboardによる追補

ユーザーが既存Cloudflareアカウントにログインした後、ChromeのDayopt Dashboardを読み取りで確認した。設定保存、token発行・変更、object内容の表示、同期・復元、メール送信はしていない。個人宛先、site key、token値はこの記録に含めない。

| 対応する検査                                                | 観測                                                                                                                                                                                                  | 判定と限界                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare.zone` / `cloudflare.zone_operations`            | account表示はDayopt、zoneは`dayopt.app`、DNSセットアップはフル。DNSレコード一覧は1–16 / 16で、全16行がDNSのみ。DNSSECは「DNSSECを有効化」ボタンが表示され、未有効。マルチ署名者DNSSECもoff。          | DNS onlyは契約と一致。DNSSECの有効化を必須とする具体的期待値は台帳にないため、未有効という観測を記録し、driftや設定変更へ自動昇格させない。管理・復旧担当とregistrar更新設定は未確認。                                                                |
| `cloudflare.email_routing`                                  | routing有効、DNSレコードロック済み、ルール1件・宛先1件。`support@dayopt.app`のルール有効、キャッチオールはdrop / 無効、宛先アドレスは検証済み。                                                       | `contact-email.md`と台帳の設定契約に一致。転送先の個人アドレスは出力しない。実メールの受信・返信は実行していない。                                                                                                                                    |
| `cloudflare.turnstile`                                      | ウィジェットDayoptは1件、Managed mode、pre-clearance off。許可ホストは`app.dayopt.app`、`dayopt.app`、`localhost`、`vercel.app`。                                                                     | Productionの必須2domainを含む。残る2ホストも同じウィジェットで許可されているという観測であり、Production専用のhost一覧とは扱わない。非本番との共用意図、server secretとの対応、個々のdeployment配布値は未確認。設定画面は値を編集・保存せず退出した。 |
| `cloudflare.r2_buckets` / `cloudflare.r2_locks.avatars`     | `avatars`はAPAC。custom domainなし、public development URL無効。`avatars-retention-35d`が有効、prefixは`--`、lock期間35日。lifecycleはDefault Multipart Abort Ruleが有効で未完了uploadを7日後に中止。 | 35日lockは台帳と一致。35日経過後の完成object自動削除を示すlifecycleではない。lock期間と自動削除期間を混同しない。実復元可能性は未検証。                                                                                                               |
| `cloudflare.r2_buckets` / `cloudflare.r2_locks.attachments` | `attachments`もcustom domainなし、public development URL無効。`attachments-retention-35d`が有効、prefixは`--`、lock期間35日。lifecycleは同じ7日multipart abort ruleが有効。                           | 35日lockは台帳と一致。object本文や個別ファイルを開いていない。                                                                                                                                                                                        |
| `cloudflare.backup_credential_scope`                        | Account API token一覧に`storage-backup-rclone`が1件、active、2026-08-18発行。適用先は`attachments`、`avatars`、`storage-backup`、権限はObject Read & Write。User API tokenはなし。                    | backup scriptの既定対象は`avatars attachments`なので、scopeには追加の`storage-backup`がある。用途・残存scopeの意図は未確認。token値を読んでおらずci master / GitHub replicaがこのtokenと同一とは証明しない。有効期限は一覧に表示されず未確認。        |

今回、Cloudflareの管理metadataを補完できたため、ログイン待ちは解消。DoctorのAPI取得不能件数はこのUI確認では変更しない。Cloudflareで残るのは、DNSSEC / 追加Turnstileホスト / 追加token scopeの運用意図、token期限と実配布先の対応、管理・復旧担当、registrar更新設定、復元証跡。期待値を観測値に自動で合わせず、設定変更はしていない。

### 12:04–12:10 JST 残る判断・復元証跡・registrarの照合

直前の追補で残した項目を正本と既存Dashboard / MCPに照合した。外部設定・token・支払設定は変更していない。

| 項目                         | 取得元と確認結果                                                                                                                                                                                                                                                            | 解消した範囲 / 残る範囲                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turnstileの環境共用意図      | `pnpm --silent docs:read docs/engineering/infra.md`のBot対策節に、widgetは1つ、複数hostnameをカバーし、環境別site keyは分けないと明記。                                                                                                                                     | 共用意図は確認済み。前節の「共用意図未確認」を解消し、台帳に`widget_strategy: shared_across_environments`を明示した。秘密の配布値との対応や検証動作は別確認。                                                                                                    |
| R2 token権限・IP制限・期限   | Cloudflare R2の既存`storage-backup-rclone`編集画面を変更せず読取。Object Read & Writeのみ、特定bucketのみが選択。対象は`attachments` / `avatars` / `storage-backup`。IP include / exclude欄は空。TTL見出しはあるが値・選択controlが表示されず、キャンセルで退出。           | bucket作成・削除・設定変更が可能なAdmin権限ではないことを確認。IP制限なし。期限は未確認で、無期限とは断定しない。ci master / replicaとの同一性は未確認。                                                                                                         |
| 旧`storage-backup` scope     | 現R2一覧は検索なしで`avatars` / `attachments`の2行、前 / 次ページ操作ともdisabled。9/30記録では旧`storage-backup` HEADが404。現在のtoken scopeは旧名を含む。                                                                                                                | 旧名のscopeが残ることは確認。単なる追加bucketの必要性ではなく、旧構成の残存候補として扱う。scope変更や新規bucket作成はしない。過去404を現在のAPI応答とは扱わない。                                                                                               |
| 既存のStorage復元演習記録    | `pnpm --silent docs:read docs/operations/disaster-recovery-drill.md`のStorage節。2026-08-20にR2からローカルへの復元、2 object・85.150 KiB、初回搬出と件数・サイズ一致、認証込みRTO約2分との記録。Production書き戻しなし。                                                   | 「復元記録が未発見」は解消。これは過去の文書証跡であり、現在のbackup内容・実行revision・checksum・復旧担当を今日独立検証した証拠ではない。backup正本の参照にこのrunbookを追加し、日々のfingerprint対象にした。復元は実行していない。                             |
| Cloudflare Registrar管理先   | DashboardのDomains → Registrationsは「まだCloudflareに登録されたdomainはありません」。Domains概要には`dayopt.app` active。                                                                                                                                                  | DNS zoneの存在とRegistrar登録を区別できた。Cloudflare画面を自動更新設定の確認先として要求しない。                                                                                                                                                                |
| Vercel側のdomain登録metadata | 12:09 JST、既存Dayopt team限定のVercel MCP `list_domains`で`dayopt.app`を取得。`renew:true`、購入2026-01-05、期限2027-01-05 01:10:42 UTC（10:10:42 JST）、verified、`serviceType: external`。実nameservers / customNameserversはCloudflareの2台。応答paginationのnextなし。 | 自動更新onという設定metadataと期限は確認済み。11:30 JSTのDoctor公開RDAP結果はregistrar `Name.com, Inc.` / ID625、同日期限、delegation_signed:falseで整合。Vercelの管理metadataとregistry registrar名を混同しない。課金手段の有効性・回復方式・復旧担当は未確認。 |

Vercel応答の`intendedNameservers`はVercelの2台だが、実`nameservers`と`customNameservers`はCloudflareで、Cloudflare Dashboard・公開DNSとも一致する。未使用の意図metadataだけで委譲差異と判定しない。creator / memberの個人情報、token値、支払情報、object内容は記録していない。

この追補後の残りは、DNSSEC方針、旧bucket scopeの整理判断、token期限・実配布先一致、domain管理アカウントの支払い状態・回復担当、現在のbackupに対する復元証跡。Turnstile共用意図、自動更新metadata、過去の復元記録を再度「未確認」に戻さない。Doctorの自動判定件数は補足確認では更新していない。

### 12:12 JST Production cron配線・既存requestの追補

Vercel Product → Settings → Cron Jobsを読み取り確認。CronはEnabledで、billing reconciliationは02:15 UTCの日次、account deletion settleは毎時5分、calendar sync / external connection maintenanceは15分ごと。checkoutの`apps/product/vercel.json`と一致する。Run操作はしていない。

既存View Logsのpath filterを`/api/cron/billing-reconciliation`、期間をLast dayに限定し、一覧metadataのみ確認した。**2026-10-06 11:15:14 JST、GET、HTTP 200**の1行があり、その期間の一覧末尾は「No more logs to show」。直近30分では空だったため、その空一覧を呼び出し不存在とは扱わない。ログ本文、request header / response body、認証付きURLは読んでいない。

requestのdeployment hostnameをVercel MCP `get_deployment`で照合すると、Production `READY`、`dpl_hpdetJQXMNgMLhvAQutTSzDky3CK`、SHA `47f5d7c414317192bcd173255c092a29cdee0035`。現在の公開Production versionと一致する。これにより定期呼び出しの到達と配信revisionは確認できたが、HTTP 200は`configured:false`のskipにも処理完了にも使われるため、heartbeat欠測の原因確定・reconciliation成功とは扱わない。残るのは配信deploymentの実設定 / 実行分岐と、activation pending中のheartbeat要求の整合。

### 11:31 JSTの再取得と所在情報のCLI対応

- 所在情報のtext/JSON表示を`--coverage`に追加し、`--service onepassword`でhuman・ciの所在と確認状態を表示できる。個別serviceではそのhuman項目を表示する。
- 設定読取時に確認者・実在する確認日、完全な所在のVault/項目名、不完全な所在の理由を検査する。未知のservice/contract、重複ci項目、項目名の個人メール/URL、未定義secret fieldを拒否する。旧台帳の未登録所在情報は許容する。
- 確認者欠落のtestと所在表示のtestが変更前に失敗し、実装後に成功した。Node 24の`pnpm test:scripts scripts/doctor`は17ファイル178テスト成功、`pnpm typecheck:scripts`、`pnpm run doctor --offline`、`pnpm docs:check`も成功した。
- `pnpm exec tsx scripts/doctor/cli.ts --record --format json`で全サービスを再取得。確認時刻は**2026-10-06 11:31:22 JST**。113結果、**pass 52 / drift 1 / blocked 39 / manual 21 / not_applicable 0、終了コード1**。既存の`op run`経路だけを使い、ログイン・資格情報・権限の切替はしない。
- `pnpm run doctor --history`は全サービス履歴2件を比較でき、終了コード0。PostHogの`ingestion_aggregate`がpassからblocked（`read_failed`）へ変化した。backup runのmetadataとDBのheartbeat時刻等にも更新があるが、これだけで設定変更とは判断しない。所在情報を追加したexpected fingerprintの変更は実測driftと別に表示された。
- Productionの公開versionはSHA `47f5d7c4`。配信SHAとcheckoutのbilling reconciliation route、heartbeat policy、migrationに差分はない。routeはStripeのsecret/account/modeがすべて未設定の場合、heartbeatの記録前に`configured:false`で終了する。一方policyはbilling reconciliationにも1560分以内の完了を要求する。今回もheartbeat欠測を再現したが、ProductionのVercel設定は取得不能で、未設定分岐に入ったかは未確定。cronを呼ばず、policyや設定を変更して差異を消していない。
- 取得不能は従来の38件にPostHog集計失敗1件が加わったもの。所在一覧の確認をAPI権限やreplica一致の成功へ置き換えていない。次は既存の人間用読取経路でVercelのStripe設定の有無とcronの既存実行記録を確認し、heartbeat条件との関係を判定する。secret値・顧客行は不要。
- Vercel MCPの補足読取では既存Product projectのid/name、Next.js、Node 24.xのmetadataを取得できた。env一覧は`decrypt:false`を明示した呼出しが`INVALID_ARGUMENT`で取得できず、返されたaccount IDを指定しても同じだった。CLIの13件の取得不能を成功へ置き換えず、Productの一部metadataだけの別証拠として記録する。生応答・秘密値・ログ本文は表示していない。

以下は朝の機能追加・検証記録。

Lunaが履歴機能を実装し、Solが追加diffを読み取りレビュー、主担当が差分と実行結果を確認した。保存JSONと画面の比較不一致、textの環境識別不足を修正した。

- `pnpm test:scripts scripts/doctor`: 17ファイル166テスト成功。取得失敗・ページング・secret射影・環境分離・履歴整合/順序・保存失敗時の結果保持を含む。
- `pnpm typecheck:scripts`成功。`--offline`は108定義を検証し、認証・通信なし。
- `--coverage`は17サービス/108定義と検査方法を表示し、実設定未検証と明示。
- 実際の既定text形式`--service onepassword --record`も保存でき、pass 1 / manual 1、終了コード2を保持。個別履歴は全対象履歴と分離され、読み取りは終了コード0、初回は未比較。
- `pnpm docs:check`成功。サービス設定、token、メール、cron、backup、課金の変更・実行はしていない。

日々の入口は`pnpm run doctor --coverage`と`pnpm run doctor --record`。変更・未観測の理由を見て、必要な人の確認または別の修正作業へ進む。台帳を自動で実測へ合わせない。
