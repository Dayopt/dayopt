---
status: current
last_verified: 2026-10-05
---

# Dayopt サービス棚卸し — 2026-10-05

この追補は10/5にVercelとGitHubから読み取り専用で再取得したPreview配信記録を残す。期待値は[expected.yaml](./expected.yaml)、直前までの全体照合は[10/4の棚卸し](./inventory-2026-10-04.md)を参照する。Google OAuth/Calendarは別セッションの作業範囲なので調査していない。

## Preview配信とbranchの照合

2026-10-05 08:29 JST（23:29 UTC）ごろにVercelのdeployment一覧と詳細・alias一覧、GitHubのbranch検索とPR検索を実行した。08:34 JSTにはVercel Project metadataと公式仕様を追加で読み取った。Vercel MCP / GitHub MCPのread-only操作を使い、サービス設定やsecret値は変更・表示していない。

| 確認項目                   | 観測                                                                                                                                                                                     | 判定と限界                                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product Preview deployment | 2件とも`READY`、`target: null`。作成時刻は2026-10-03 06:34:34.776 UTC（15:34:34.776 JST）と06:35:48.148 UTC（15:35:48.148 JST）。                                                        | Preview deploymentとして一覧に残っている。`READY`は配信準備状態を示すが、一般公開可能かどうかは示さない。                                                                                                                                                                                            |
| Git接続情報                | 2件ともrepo `Dayopt/dayopt`、branch `codex/integration-calendar-poc-port`、commit `90652010f15670af6f8693ca293611913a4a662e`。                                                           | 2 deploymentが同じPreview branch/SHAに紐づくことを確認。個々のdeploymentが10/4に確認した全branch環境変数を実際に消費したかは、このmetadataだけでは証明しない。                                                                                                                                       |
| branch alias               | 最新deploymentのalias一覧APIは`product-git-codex-integration-calendar-poc-port-dayopt.vercel.app`を返し、古いdeploymentのalias一覧は空。                                                 | deployment詳細APIは古いdeploymentにも同じalias文字列を返し、alias一覧APIと食い違う。現在の一意なalias割当は確定せず、Vercel画面または権威あるalias状態で要確認。                                                                                                                                     |
| GitHub branch検索          | repo内でbranch名全体を検索した結果は0件。                                                                                                                                                | 検索結果だけではbranch削除を証明しない。branch endpointでの完全一致確認は未取得。                                                                                                                                                                                                                    |
| GitHub PR検索              | repo内でdeployment SHAと`is:pr`を指定した結果は0件。                                                                                                                                     | 検索結果だけではPR不存在・close・mergeを証明しない。                                                                                                                                                                                                                                                 |
| Product Project protection | 2026-10-05 08:34:23 JSTのProject metadataで`ssoProtection.enabled=true`、scope `prod_deployment_urls_and_all_previews`、`passwordProtection.enabled=false`、`trustedIps.enabled=false`。 | Vercelの[Authentication protection仕様](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments/vercel-authentication)ではこのscopeはproduction deployment URLとすべてのPreviewを対象にする。該当PreviewはSSO保護の設定範囲内。実URLへの匿名アクセス試験はしていない。 |

GitHubはMCPのbranch/PR検索で確認した。完全一致branch endpointの読み取りは未実施。このcheckoutには`.op-env.agent` / `.op-env.human`がなく、既存の`op run`参照を使う`gh api`経路を確認できなかったため、既存CLIログインへfallbackしていない。

## 10/4時点の設定との関係

10/4にVercel UIでPreview branch overrideとして確認した7項目（`POSTGRES_URL`、`POSTGRES_PRISMA_URL`、`POSTGRES_URL_NON_POOLING`、`POSTGRES_PASSWORD`、`SUPABASE_JWT_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEY`）は、VercelがSecret型への保存を検討するよう警告するConfig型だった。値は表示していない。

同じbranch/SHAのPreview deploymentが現在も2件`READY`であるため、該当branchのConfig型記録を単なる残存設定とは扱えない。一方、個別deploymentでの各変数の使用・実値の内容・一般公開の可否は確認できていない。project memberに対する値の可読性を含むリスクとして残し、Secret型への変更やrotationはこの読み取り専用棚卸しでは実施しない。

## 全体棚卸しへの反映

10/4のDoctor実行結果は95検査定義・100結果（`pass 47 / drift 1 / blocked 36 / manual 16 / not_applicable 0`、終了コード1）。この追補ではDoctorを再実行しておらず、MCP検索結果を自動判定の件数へ加えていない。Production heartbeatの差異1件と、他のblocked/manual項目は[10/4記録](./inventory-2026-10-04.md)のとおり継続。

100%到達に向けて残るのは、(1) GitHub branch/PRの権威ある状態確認、(2) Vercel alias APIの食い違いの解消、(3) Preview Config型7項目が実credentialかの所有者確認、の3点。SSO Protectionのproject scopeは確認できたが、実際のアクセス試験はしていない。実設定の修正やrotationが必要と判明した場合は、読み取り専用棚卸しとは分けて判断する。

## 変更境界

取得元はVercel MCPのdeployment一覧・詳細・alias一覧・Project metadata、GitHub MCPのbranch・PR検索、Vercel公式のAuthentication protection仕様。確認時刻は上記のとおり。生API応答、秘密値、顧客データは保存していない。外部サービスへの書き込み・設定変更は行っていない。
