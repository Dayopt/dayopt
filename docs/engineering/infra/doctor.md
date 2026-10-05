---
status: current
last_verified: 2026-10-06
---

# Infrastructure doctor

期待値と実設定を、既存の1Password資格情報とAPI/CLIで読み取り専用に比較する。設定の変更、secret同期、メール送信、webhook発火、課金、cron実行、backup実行は行わない。

## 目的と完了条件

この台帳は、Dayoptが現在使うサービスの重要な設計、接続、環境分離、権限境界を人とagentが見失わないように残し、read-only Doctorで日々の実態と観測状況を追うために使う。サービスを網羅した重要情報の一覧と、差異・未観測を区別する仕組みが成果であり、すべての検査を`pass`にすることや`drift` / `blocked` / `manual`をゼロにすることは完了条件ではない。

- `expected.yaml`には合意済みの設計とその正本参照を置く。ライブ観測値を自動的に期待値へ昇格しない。
- `drift`は記録した設計と実測が異なる合図。意図した変更か、設計の更新が必要か、実設定の修正が必要かを判断する材料として残す。
- `blocked`と`manual`は取得権限やAPIの限界も含む観測状態。理由と次の確認方法が記録されていれば、未解決のまま追跡できる。
- Doctorは現在CLIから手動実行する。自動定期実行や実行履歴の保存はこの文書・コマンドでは設定していない。

## 実行

Node 24とrepo指定のpnpmを使う。

```bash
pnpm run doctor --offline
pnpm run doctor --list
pnpm run doctor
pnpm run doctor --service vercel
pnpm run doctor --environment integration
pnpm run doctor --format json
```

**`pnpm doctor`はpnpm自体の組み込みコマンド。Dayoptのdoctorには必ず`pnpm run doctor`を使う。** JSONの標準出力にpackage managerの進捗を混ぜたくない場合は`pnpm exec tsx scripts/doctor/cli.ts --format json`を使う。

`--offline`はYAML、正本ファイル、検査定義を確認し、認証・通信をしない。通常実行は結果を標準出力へ出す。結果ファイルは自動作成しない。必要なら呼び出し元でリダイレクトする。

## 対象と正本

[expected.yaml](./expected.yaml)の`checks`が機械判定の一覧。`source_contracts`が既存監査・環境台帳の正本参照。現行の追加確認は[inventory-2026-10-05.md](./inventory-2026-10-05.md)、直前の追補は[inventory-2026-10-04.md](./inventory-2026-10-04.md)、前回の追補は[inventory-2026-10-03.md](./inventory-2026-10-03.md)、接続・検査の詳細snapshotは[inventory-2026-10-01.md](./inventory-2026-10-01.md)、初回の履歴は[inventory-2026-09-30.md](./inventory-2026-09-30.md)。観測値で期待値を自動上書きしない。

`--service`には`github`, `vercel`, `supabase`, `stripe`, `resend`, `cloudflare`, `sentry`, `posthog`, `upstash`, `uptimerobot`, `google`, `mcp_oauth`, `telemetry`, `pwned_passwords`, `support_smtp`, `optional`を指定できる。Cloudflareには公開DNS、Turnstile、R2とdomain registration metadataを含む。GitHub Appsはrepository hooksとは別のmanual検査。`all`はCLI既定の環境選択。

API/CLI readerはAPIが返すmetadataの安全な列だけを射影する。Googleの登録callback、Gmail SMTP、実際のsource map適用、secret replica値の一致など、現在のAPI資格情報で証明できない事項は`manual`または`blocked`。ソースファイルの存在、PING、domain verification、HTTP metadata取得だけで動作成功と扱わない。

一般Preview、Integration、明示MCP OAuth Previewは別契約。ProductionのSupabase refをPreviewが使えば差異。IntegrationのStripe Test/Calendarは一律禁止しない。ProductのPostHog有効環境には削除credentialが必要だが、削除処理を持たないWebには同じキーを要求しない。

公開domainのhealth/versionを配信中revisionの根拠にする。`targets.production`や最新deploymentを現在の配信と同一視しない。repo revisionが配信revisionより新しくても、その事実だけで失敗にしない。新しいrepo契約のlive適用は別確認。

## 認証・読み取り境界

各サービスの子プロセスを既存`op://`参照付きの`op run`で起動する。無関係な環境変数は渡さず、既存ログインや`.env`へfallbackしない。既存agent専用op wrapperが必要とする非秘密のCODEX_THREAD_ID / CODEX_SESSION_IDだけは維持する。OP_SERVICE_ACCOUNT_TOKEN / OP_CONFIG_DIRなどの認証overrideを親から継承しない。1Passwordの永続設定や権限は変更しない。ダイアログが出る場合は今回のみ許可する。

通常API timeoutは10秒。認証と収集全体はサービスごと120秒。429と一時的5xxだけ最大2回再試行。一つの認証・API失敗が他サービスの結果を消さない。StripeのallはLive/Testを別々の子プロセスで取得し、Live失敗でもTest結果を残す。サービス全体の120秒上限は共通。

通信は固定のoperationとDayoptリソースに限定する。GETとmetadata用の固定read POSTのみ。Supabase SQLには`read_only:true`を付け、顧客行・Vault値・pg_cron commandを読まない。PostHogは直近7日のenvironment/count集計だけ。UptimeRobotは`getMonitors`だけ。RedisはPINGだけ。domain registrationはdayopt.app固定の公開registry RDAP GETだけで、registrant連絡先を出力しない。

資格情報やAPI応答bodyをerror/logへ出さない。URLのquery/userinfoと未知のpathを削除する。公開client IDとproject/account IDは秘密値ではない。runtime secretは存在だけを扱い、復号・master照合ができない場合はunknownのまま残す。

ページング途中の失敗を空一覧や不存在へ変換しない。GitHub backup履歴は直近10件のmain scheduled runという限定窓。workflow全体のconclusionからbackup jobの成功を推測しない。Storage/RLS既存監査の成功は全required policyの存在やrestore成功まで保証しない。

## 判定と終了コード

| 判定             | 意味                                                         |
| ---------------- | ------------------------------------------------------------ |
| `pass`           | 指定された比較条件と一致。metadata取得の検査なら取得成功だけ |
| `drift`          | 取得できた実設定が期待値と異なる                             |
| `blocked`        | 権限不足、認証timeout、接続失敗、必要なmetadataの欠測など    |
| `manual`         | API metadataだけでは証明できず、人間による確認が必要         |
| `not_applicable` | その環境で適用されない契約                                   |

終了コードは`0`:必須検査一致、`1`:差異あり、`2`:差異未検出だが必須検査判定不能、`3`:引数・期待値・検査定義・内部処理の不備。差異と判定不能が混在すると`1`。任意検査のmanualは必須検査の成功判定には含めない。

private化と専用Integration projectへの移行はadvisory。doctor結果をmerge/release gateに接続せず、定期CIや自動修復は別変更にする。

## schema・cronの比較条件

Productionの配信SHAにあるschema/cron契約ファイルがこのcheckoutと一致する場合のみ、既存migration比較関数、heartbeat判定、RLS snapshot生成器の`--check`を再利用する。snapshotはmanagement APIの読み取りだけを使い、標準出力・例外本文は取り込まない。契約ファイルが異なる、配信commitがローカルにない、またはSHAを取得できない場合は`manual`/`blocked`。cron scheduleは安全なmetadataを提示して配信revisionのmigrationとの手動照合に残す。

UpstashのPINGは既存agent masterに限る。Preview/IntegrationのRedis接続先・分離をその結果から推測しない。

## 初版の実行記録（2026-09-30）

Node 24で全16サービスを読み取り実行し、2026-09-30 12:37:14 JSTのレポートは97結果（pass 50、drift 1、blocked 28、manual 17、not_applicable 1）、終了コード1だった。複数環境の検査は同じ定義から環境別結果を出すため、定義数とは異なる。

差異は`vercel.product.public_bindings`の`posthog_enabled_without_deletion_key`。権限不足・認証失敗・metadata欠測・サービス間の証拠欠測を差異と分けて残した。未取得のsignature secret、API権限、配信契約の未確認を「全件正常」にしていない。サービスへの書き込みは行っていない。

この記録は初版の限定的な読み取り証拠。現行状態は再実行で確認する。schema/cronの契約ファイル比較とURLの原表記保持は、この実行後にも回帰テストで確認した。

初版後の差異・取得不能の切り分けとreader修正は[triage-2026-09-30.md](./triage-2026-09-30.md)に記録している。

## 接続・取得制約の台帳

expected.yamlの`connections`は安定ID、対象環境、from/to、check ID、既存正本、既存secret参照を持つ。`ui_only`は互換上の名称であり、API未提供を確定した項目と、現在の権限不足、reader不足、secret再表示不可、実動作検証を分ける。すべてをUI限定と扱わない。offlineでID重複と参照切れを検査する。

10/1時点は95定義・60接続・23取得制約。全実環境runは100結果（pass 45 / drift 0 / blocked 36 / manual 19）、終了コード2。MCP/UIによる補足と過去証拠は統合棚卸しに記録し、自動取得結果と混ぜて全件正常にしない。Googleの切り替え作業は別セッションで進行している。
