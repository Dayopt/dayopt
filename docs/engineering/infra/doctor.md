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
- DoctorはCLIから手動実行する。`--record`で安全な結果を保存し、`--history`で同じ対象範囲の前回からの変化を確認する。自動定期実行は設定していない。

## 実行

認証付き実行は、レビュー済みmainのSHAに固定した**専用clone**だけで行う。PR checkout、未レビューbranch、共有の開発用node_modulesからは資格情報を解決しない。`scripts/runbook/doctor-trusted.mjs`をそのcloneの外に設置し、絶対pathで起動する。任意のcheckout内の`pnpm run doctor`を承認する運用は廃止した。

### 初回設置・更新（人による信頼の確定）

Node 24を使う。以下の`REVIEWED_MAIN_SHA`は、このDoctorを含むレビュー済み・mainへmerge済みの40桁SHAに置換する。PRのheadや自動取得した未レビューSHAを使わない。**このPRのmerge前は設置・認証付き実行を行わない。**

```bash
DOCTOR_INSTALL="$HOME/.local/share/dayopt-doctor"
DOCTOR_REVISION=REVIEWED_MAIN_SHA
mkdir -p "$DOCTOR_INSTALL"
git clone --no-checkout https://github.com/Dayopt/dayopt.git "$DOCTOR_INSTALL/runtime"
git -C "$DOCTOR_INSTALL/runtime" checkout --detach "$DOCTOR_REVISION"
git -C "$DOCTOR_INSTALL/runtime" merge-base --is-ancestor "$DOCTOR_REVISION" origin/main
pnpm --dir "$DOCTOR_INSTALL/runtime" install --frozen-lockfile --ignore-scripts
install -m 700 "$DOCTOR_INSTALL/runtime/scripts/runbook/doctor-trusted.mjs" "$DOCTOR_INSTALL/doctor.mjs"
printf '%s\n' "$DOCTOR_REVISION" > "$DOCTOR_INSTALL/revision"
node "$DOCTOR_INSTALL/doctor.mjs" --offline
node "$DOCTOR_INSTALL/doctor.mjs" --record
```

設置の各コマンドが失敗したら次へ進まない。cloneと依存は開発checkoutと共有しない。更新は履歴を保持した上で、新しいレビュー済みmain SHAから専用clone・依存・launcherを再設置する。自動更新はしない。launcher自身、revision pin、Node/op/Gitバイナリ、専用依存を変更できるOSユーザーは信頼境界内であり、悪意のあるコードを同じOSユーザーで実行してからの安全性は保証しない。任意のPR自身に書かれた自己検査を信頼根拠にしない。

launcherは自身の隣の`runtime`だけを使い、呼び出し元cwdのコード・package.json・依存を起動しない。固定SHA、mainへの到達、detached HEAD、正規origin、追跡ファイルの無変更、未追跡moduleの不在を認証前に確認する。Node preload指定を継承せず、collectorとDB監査もこのruntime内のコードだけを実行する。対象PRのコードを監査する機能は提供しない。

開発checkoutでは次の認証不要の入口を使える（`pnpm doctor`はpnpm自身の別コマンド）。

```bash
pnpm run doctor --offline
pnpm run doctor --list
pnpm run doctor --coverage
pnpm run doctor --history
```

専用launcherには`--service vercel`、`--environment integration`、`--format json`等を同じように渡せる。

`--offline`はYAML、正本ファイル、検査定義を確認し、認証・通信をしない。通常実行は結果を標準出力へ出す。結果ファイルは自動作成しない。必要なら呼び出し元でリダイレクトする。

`--coverage`も認証・通信をせず、各サービスの役割・停止時の影響・再確認のきっかけ・設計正本・接続・検査方法・取得制約を一覧にする。表示は台帳の宣言であり、実設定の検証結果ではない。`metadata_or_source_only`はmetadataやソースの取得だけ、`comparison_rule`は指定条件の比較、`manual_verification`は人による確認を表す。比較規則でも実行時に取得不能・手動確認となることがある。

1Passwordの所在情報も`--coverage`のtext/JSONに表示する。全サービスまたは`--service onepassword`ではhuman・ciの登録済み項目を、個別サービスではそのhuman項目を表示する。`user_confirmed`は人による項目の所在確認、`complete`はVaultと正確な項目名が揃うことを示す。field・権限・期限・provider設定・replica一致の確認とは別で、live検査の判定を変更しない。未特定・個人メールを転記していない項目は`incomplete`と理由を表示する。

`--offline`を含む設定読取時に所在情報も検査する。確認済みには確認者と実在する日付、完全な所在にはVaultと項目名、不完全な所在には理由が必要。未知のサービス・正本参照、ci項目の重複、項目名のメール・URL、未定義のsecret fieldを拒否する。所在情報が未登録の旧台帳も読める。確認日の更新を自動実行せず、実際に確認した人の記録を維持する。

通常のテキスト出力にも実行repoのrevision、期待値のbaseline、確認日時を表示する。期待値のbaselineは台帳の`scope.repository_baseline`であり、現在の期待値ファイルを保存したcommitとは限らない。

## 日々の確認と履歴

日々の作業開始時とサービス・環境・資格情報・release経路の設計変更後に、重要設計の一覧を見て`node "$HOME/.local/share/dayopt-doctor/doctor.mjs" --record`を実行する。同じ専用runtime・同じ対象範囲でlauncherに`--history`を渡して読む。取得権限がない状態もそのまま記録する。終了コード1・2は保存失敗ではなく、差異・必須検査の判定不能を含む結果である。

- 保存先はGit管理外の`.local/infra-doctor/history/`。資格情報・生API応答を保存せず、安全に射影した結果だけを保存する。履歴directoryは0700、JSON fileは0600。保存失敗・不正な履歴はプロセス終了コード3で報告する。保存失敗でも今回の検査結果を標準出力へ残す。JSONの`exit_code`は検査結果、`history_saved:false`と`history_error`は記録失敗を表す。
- 全サービス/個別サービス、全環境/個別環境は別々の履歴として比較する。初回は比較対象なしであり、「変化なし」としない。別checkoutへ履歴を自動転送しない。
- 状態・期待値・実測・理由と検査の追加/消滅を追う。確認日時だけの変化と配列順だけの違いは差分にしない。heartbeat日時や集計countなど実測値の更新は表示されるため、すべてを設定変更とは解釈しない。
- 実行時の`expected.yaml`と参照先契約のfingerprintを保持し、設計変更を実測driftとは別に表示する。意図した変更なら正本と台帳を更新し、外部設定の変更が必要なら対象と影響を確認して別作業にする。
- `--history`の終了コード0は履歴の読み取り成功。保存されたrunの終了コード・未確認件数を見て現在の観測状況を判断する。古い履歴を現在の成功にしない。

手動確認はサービスの`review_triggers`にある変更時と月次に見直す。人間用資格情報の所在は既存の`manual_access_policy`に従い、Vault・正確なitem名と確認担当/日時を記録する。API非提供・現在の権限不足・reader不足・secret再表示不可・実動作検証を区別し、未確認のままでも次の確認方法を残す。

## 対象と正本

[expected.yaml](./expected.yaml)の`checks`が機械判定の一覧。`source_contracts`が既存監査・環境台帳の正本参照。現行の追加確認は[inventory-2026-10-05.md](./inventory-2026-10-05.md)、直前の追補は[inventory-2026-10-04.md](./inventory-2026-10-04.md)、前回の追補は[inventory-2026-10-03.md](./inventory-2026-10-03.md)、接続・検査の詳細snapshotは[inventory-2026-10-01.md](./inventory-2026-10-01.md)、初回の履歴は[inventory-2026-09-30.md](./inventory-2026-09-30.md)。観測値で期待値を自動上書きしない。

最新の観測と日常運用の検証は[10/6の記録](./inventory-2026-10-06.md)を参照する。

`--service`には`github`, `vercel`, `supabase`, `stripe`, `resend`, `cloudflare`, `sentry`, `posthog`, `upstash`, `uptimerobot`, `google`, `mcp_oauth`, `telemetry`, `pwned_passwords`, `support_smtp`, `optional`, `onepassword`を指定できる。Cloudflareには公開DNS、Turnstile、R2とdomain registration metadataを含む。Email Routing/zone運用・復元可能性・Sentry通知/権限・1Password復旧境界は取得できたmetadataと別のmanual検査として残す。1Password検査はitem値を取得しない。GitHub Appsはrepository hooksとは別のmanual検査。`all`はCLI既定の環境選択。

API/CLI readerはAPIが返すmetadataの安全な列だけを射影する。Googleの登録callback、Gmail SMTP、実際のsource map適用、secret replica値の一致など、現在のAPI資格情報で証明できない事項は`manual`または`blocked`。ソースファイルの存在、PING、domain verification、HTTP metadata取得だけで動作成功と扱わない。

Vercelのenv metadataには、値を含めず`configuration_id`を記録する。Integration管理の変数を手動設定と区別して調べるためのIDであり、未取得・形式不正は`null`。`null`から手動管理と推測しない。Integrationによる再注入があり得るため、古いbranchの変数を削除するだけで原因解消と扱わない。

一般Preview、Integration、明示MCP OAuth Previewは別契約。ProductionのSupabase refをPreviewが使えば差異。IntegrationのStripe Test/Calendarは一律禁止しない。ProductのPostHog有効環境には削除credentialが必要だが、削除処理を持たないWebには同じキーを要求しない。

Integrationの接続・有効化設定は共通Preview設定に`integration` branchの上書きを適用して照合する。他のPR branchの設定はこの照合に含めない。全環境のenv metadata監査は`shared`として別に報告する。存在する有効化フラグの値を取得できない場合は明示的な`false`と区別して`blocked`にし、ProductionのSupabase接続先はHTTPSのorigin全体で比較する。

公開domainのhealth/versionを配信中revisionの根拠にする。`targets.production`や最新deploymentを現在の配信と同一視しない。repo revisionが配信revisionより新しくても、その事実だけで失敗にしない。新しいrepo契約のlive適用は別確認。

## 認証・読み取り境界

各サービスの子プロセスを既存`op://`参照付きの`op run`で起動する。無関係な環境変数は渡さず、既存ログインや`.env`へfallbackしない。既存agent専用op wrapperが必要とする非秘密のCODEX_THREAD_ID / CODEX_SESSION_IDだけは維持する。OP_SERVICE_ACCOUNT_TOKEN / OP_CONFIG_DIRなどの認証overrideを親から継承しない。1Passwordの永続設定や権限は変更しない。ダイアログが出る場合は今回のみ許可する。

`agent` Vault専用のService Accountでは、現在ciを参照するVercel / Cloudflare、humanを参照するStripe Live / Resendを取得できない。GUIでitemを確認済みでも、この制約は解消しない。人間用Terminalでの既存`op run`実行とagentの実行を区別し、agentはwrapperや認証識別子を外して迂回しない。自動取得範囲を増やす場合はサービス側の読取専用権限を確定し、既存の強いcredentialのコピーやVault範囲拡大を解決策にしない。

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
