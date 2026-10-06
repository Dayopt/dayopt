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

## 検証とレビュー

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
