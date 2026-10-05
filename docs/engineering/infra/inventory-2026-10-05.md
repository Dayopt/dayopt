---
status: current
last_verified: 2026-10-05
---

# Dayopt サービス棚卸し — 2026-10-05

この追補は10/5にVercel・GitHub・Supabase・PostHogを読み取り専用で確認した記録を残す。期待値は[expected.yaml](./expected.yaml)、直前までの全体照合は[10/4の棚卸し](./inventory-2026-10-04.md)を参照する。Google OAuth/Calendarは別セッションの作業範囲なので調査していない。

## Preview配信とbranchの照合

2026-10-05 08:29 JST（23:29 UTC）ごろにVercelのdeployment一覧と詳細、08:34 JSTにProject metadata、08:43 JSTにproject-wide alias一覧を読み取った。08:48 JSTには環境変数metadata APIとVercel UI、08:50 JSTごろにはGitHub REST APIとUIでbranch/PR状態を追加確認した。各操作はread-onlyで、サービス設定とsecret値は変更・表示していない。

| 確認項目                   | 観測                                                                                                                                                                                                                     | 判定と限界                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product Preview deployment | 2件とも`READY`、`target: null`。作成時刻は2026-10-03 06:34:34.776 UTC（15:34:34.776 JST）と06:35:48.148 UTC（15:35:48.148 JST）。                                                                                        | Preview deploymentとして一覧に残っている。`READY`は配信準備状態を示すが、一般公開可能かどうかは示さない。                                                                                                                                                                                            |
| Git接続情報                | 2件ともrepo `Dayopt/dayopt`、branch `codex/integration-calendar-poc-port`、commit `90652010f15670af6f8693ca293611913a4a662e`。                                                                                           | 2 deploymentが同じPreview branch/SHAに紐づくことを確認。個々のdeploymentが10/4に確認した全branch環境変数を実際に消費したかは、このmetadataだけでは証明しない。                                                                                                                                       |
| branch alias               | 08:43 JSTのproject-wide alias一覧は`product-git-codex-integration-calendar-poc-port-dayopt.vercel.app`をdeployment `dpl_Czq5bmAaUEaF3rdPvsAfNnV3GYiq`へ割当。最新deployment別一覧も同じalias、古いdeployment別一覧は空。 | `get_deployment`の古いdeployment詳細にもalias文字列は残るが、project-wide一覧とdeployment別一覧は最新deploymentを示す。現在の割当は最新deploymentと確認。                                                                                                                                            |
| GitHub branch状態          | 08:50 JSTごろのREST `GET branches/codex/integration-calendar-poc-port`は404。GitHub branch UIも`Ref is invalid`を表示。SHA `90652010…`のcommitページは存在。                                                             | このbranch refは現在存在しないことをAPI/UIで確認。commit自体は履歴に残る。                                                                                                                                                                                                                           |
| GitHub PR状態              | commitのpulls endpointでPR #3012は`closed`かつmerge済み（2026-10-03 06:50:17 UTC）、headは対象branch、baseは`integration`。PR #3014はopenだが、headは別branch `codex/supabase-rate-limit-poc-status`。                   | 元branchの変更はPR #3012で`integration`へmerge済み。#3014を元branchの未完了PRと誤認しない。                                                                                                                                                                                                          |
| Product Project protection | 2026-10-05 08:34:23 JSTのProject metadataで`ssoProtection.enabled=true`、scope `prod_deployment_urls_and_all_previews`、`passwordProtection.enabled=false`、`trustedIps.enabled=false`。                                 | Vercelの[Authentication protection仕様](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments/vercel-authentication)ではこのscopeはproduction deployment URLとすべてのPreviewを対象にする。該当PreviewはSSO保護の設定範囲内。実URLへの匿名アクセス試験はしていない。 |

GitHubの完全一致branch endpointとcommit pulls endpointは既存の`op://agent/github-agent/credential`を`op run`の子プロセスにだけ渡してGETした。UIでもbranch refが無効であることを確認した。MCP検索はbranch/PR状態の判定根拠にしていない。

## 10/4時点の設定との関係

10/5 08:48 JSTごろにVercel環境変数一覧APIを`decrypt=false`で読もうとしたが403で取得できなかった。続けてVercel UIで値を開かずに確認し、7項目（`POSTGRES_URL`、`POSTGRES_PRISMA_URL`、`POSTGRES_URL_NON_POOLING`、`POSTGRES_PASSWORD`、`SUPABASE_JWT_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEY`）が引き続きConfig型・Preview・branch `codex/integration-calendar-poc-port` scopeで存在することを再確認した。Vercel UIは各行をSecret型への保存を検討するよう警告していた。

該当branch refはGitHub上で削除済みだが、同じbranch/SHAのVercel Preview deploymentが2件`READY`で、Config型のbranch overrideもUIに残っている。deploymentが各値を実際に消費したか、値が有効なcredentialか、deployment URLへ一般アクセスできるかは確認していない。Config型は権限のあるproject memberが値を読める可能性があるため、値を表示せずにcredentialかどうかを確定できない。Secret型への変更やrotationはこの読み取り専用棚卸しでは実施しない。

## Supabase DashboardによるAPI blocked項目の補完

2026-10-05 09:05–09:12 JSTに、ログイン済みSupabase Dashboardを画面閲覧のみで確認した。SQL Editor、Table Editor、Auth user一覧、Restore操作は開いていない。

| 確認項目                      | 観測                                                                                                                                                                                                                                                                                         | 判定と限界                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Dayopt organization / project | Organization `Dayopt PRO`。organizationのproject一覧は1件のroot project `dayopt`（Production `yvglwblxrnrenfifsnje`）。                                                                                                                                                                      | Integrationは2つ目の独立organization projectではなく、Production配下のpersistent branchとして表示される。                                       |
| branch一覧                    | Production `main`（GitHub `Dayopt/dayopt`の`main`）とpersistent `integration`（同repoの`integration`）を表示。Preview branchはなし、scheduled deletion branchもなし。branch一覧に表示された更新時刻はmain `11 Aug 26 09:38:36`、integration `27 Sep 26 13:11:32`（画面にtimezone表示なし）。 | ProductionとIntegrationの対応をDashboardで確認。Integrationのproject refは`tilwaprottpyhlfoggbb`。branch一覧はmigrationやデータ内容を示さない。 |
| Production / Integration状態  | 両project overviewのstatusは`Healthy`。Integrationは`PERSISTENT`、branch作成8日前、Last migration `supabase_rate_limit_idempotency_poc`。                                                                                                                                                    | Dashboardの状態表示を確認。Preview projectの作成・削除は行っていない。                                                                          |
| Production backup             | `PHYSICAL` backupが7件。最新は2026-10-04 18:33:47 UTC、表示範囲は9/28–10/4。                                                                                                                                                                                                                 | scheduled backup一覧でmetadataを確認。                                                                                                          |
| Integration backup            | `PHYSICAL` backupが7件。最新は2026-10-04 19:05:46 UTC、表示範囲は9/28–10/4。                                                                                                                                                                                                                 | branch ref `tilwaprottpyhlfoggbb`のscheduled backup一覧でmetadataを確認。                                                                       |
| backupの範囲                  | Supabase画面はdatabase backupがproject regionで毎日深夜ごろ作成され、Storage APIのobjectは含まれないと説明。                                                                                                                                                                                 | backup履歴は確認したがrestoreは試しておらず、Storage objectの復旧可能性も検証していない。Restoreボタンは押していない。                          |

同時刻帯の`pnpm doctor --service supabase --format json`は19結果（`pass 11 / drift 1 / blocked 4 / manual 3`、終了コード1）。Production project・Auth config/audit・functions・database metadata・Storage auditはpass。Integration Auth config・functions・database metadataはpass、Integration Auth auditとPreview branchのDB選択はmanual、Production heartbeatとcron reviewもそれぞれdrift/manual。API readerのblockedは`supabase.branches`（403）、Production backup metadata（403）、Integration project metadata（404）、Integration backup metadata（404）。Dashboardはこれら4項目のresource存在・branch名・backup履歴を補うが、DoctorのAPI判定はblockedのまま。API権限や取得経路は変更していない。

## PostHogの読取権限

2026-10-05 09時台のPostHog MCP skill discoveryは`llm_skill:read`不足を返した。利用可能tool一覧にproject settings readerはなかった。Doctorの`posthog.settings`もAPI 403のため、project `625917`のcapture/privacy settingsと削除credential metadataは取得していない。analytics queryによるevent/personデータの代替照合は実施していない。既存接続の権限内で取得不能と記録し、権限変更やcredential作成は行っていない。

## 全体棚卸しへの反映

2026-10-05 08:51 JSTごろにNode 24.19.0と既存の`op run`認証で全サービスのDoctorを再実行した。95検査定義・100結果（`pass 47 / drift 1 / blocked 36 / manual 16 / not_applicable 0`、終了コード1）で、10/4の集計から変化はない。唯一の差異はProduction `billing-reconciliation` heartbeatで、他の判定不能はblocked 36件・manual 16件。個別のGitHub/Vercel確認は追加証拠として記録し、Doctorの自動判定件数には加えていない。

この追補内ではGitHub branch/PR状態・Vercel alias・Supabase branch/backup履歴を確認済み。Supabaseの4件はDoctorのAPI判定上blockedだがDashboard evidenceでresource存在とbackup履歴を補完した。残るのは、(1) Preview Config型7項目がcredentialかを値を開かずに特定できないため、設定所有者が分類すること、(2) PostHog project settingsを読む権限のある経路がないこと、(3) Doctorに残るblocked 36件・manual 16件・Production heartbeat drift 1件の解消または理由付きの明確化。Vercel alias割当とSSO protectionのscopeはAPIで確認したが、実URLへの匿名アクセス試験はしていない。実設定の修正やrotation、heartbeat契約の変更が必要と判明した場合は、読み取り専用棚卸しとは分けて判断する。

## 変更境界

取得元はVercel MCPのdeployment一覧・詳細・alias一覧・Project metadata、Vercel UIの環境変数metadata、GitHub REST API（`op run`経由）・branch UI、Supabase Dashboardのbranch/backup metadata、PostHog MCP tool discovery、Vercel公式のAuthentication protection仕様、およびDoctorのread-only実行。確認時刻は上記のとおり。生API応答、秘密値、顧客データは保存していない。外部サービスへの書き込み・設定変更は行っていない。
