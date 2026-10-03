---
status: current
last_verified: 2026-10-03
---

# Dayopt サービス棚卸し — 2026-10-03

前回の詳細な接続一覧・各検査定義は[10/1統合棚卸し](./inventory-2026-10-01.md)にある。この記録は10/3に再確認できた内容だけを追補する。既存の期待値・接続IDは[expected.yaml](./expected.yaml)を正本とする。Google clientの切り替えはユーザー指定により別セッションが担当しているため、そこへ立ち入らず結果待ちとする。

## 今回の全体結果

Node 24でread-only `doctor`を全サービス実行。確認時刻は**2026-10-03 13:39:03 JST**、100結果・95検査定義、`pass 45 / drift 0 / blocked 36 / manual 19 / not_applicable 0`、終了コード2。passには安全なmetadata取得も含まれ、全項目一致という意味ではない。サービス操作、書き込み、送信、課金、cron/backup起動はしていない。応答は秘密・認証付きURL・顧客情報を含めない射影で処理し、生レポートはリポジトリに残していない。

## 10/3に更新できた証拠

| 対象                      | 取得結果                                                                                                                                                                                      | 照合と限界                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub main               | 既定branch `main` のSHAは `47f5d7c414317192bcd173255c092a29cdee0035`                                                                                                                          | GitHub REST metadataとread-only `git ls-remote`が一致。secret一覧・repository hooks APIは403のまま                                                                                    |
| Product Production        | `https://app.dayopt.app/api/health/version` は `47f5d7c4` / `0.35.0`                                                                                                                          | GitHub main SHAの先頭8桁と一致。Product Productionがこのmain revisionを配信中と確認                                                                                                   |
| Vercel Product/Web        | read-only `vercel inspect` は両aliasとも`READY`, target `production`。Product deploy作成10/2 13:26 JST、Webは10/1 13:15 JST                                                                   | Webのcommit SHAはinspectの安全なmetadataに含まれず、Productのpublic version endpointもWebでは404。WebのSHA一致は未確認。project設定/env一覧/DNS bindingは引き続き未取得               |
| Vercel Integration alias  | `product-git-integration-dayopt.vercel.app` は`READY`, target `preview`、inspect作成10/1 10:18 JST                                                                                            | inspectにcommit SHAなし、public healthはDeployment Protectionで401。最新SHAとの対応は未確認                                                                                           |
| GitHub integration branch | SHA `1494df3ecb1e2d02e558b25d1cc6f34e30178b82`                                                                                                                                                | Supabase Integration branchのGit branch名と一致。Oct1のVercel Integration deployment SHAとも一致するが、VercelのOct3 SHA再確認はできていない                                          |
| Supabase Production       | project `yvglwblxrnrenfifsnje`, `ACTIVE_HEALTHY`; migration 304件、latest `20261001083000`                                                                                                    | GitHub main `47f5d7c4` のactive migration version集合304件と完全一致。missing 0 / extra 0。latest file `20261001083000_allow_billing_reconciliation_heartbeat.sql`                    |
| Supabase Integration      | persistent branch `tilwaprottpyhlfoggbb`, git branch `integration`, `with_data:false`, branch functions deployed / preview project `ACTIVE_HEALTHY`; migration 296件、latest `20260928044000` | GitHub integration SHA `1494df3e` のactive migration version集合296件と完全一致。missing 0 / extra 0。Integrationを独立project APIで読むと404だったが、branch一覧では存在を確認できる |
| GitHub Storage backup     | Oct3 00:59:46Zにmain SHA `47f5d7c` でStorage→R2 job success                                                                                                                                   | 直近10 scheduled main runのみ。後続のskipはbackup成功に数えず、job成功はR2内データの完全性・retention・restoreを証明しない                                                            |
| PostHog ingestion         | doctorの直近7日environment集計は空配列                                                                                                                                                        | この集計範囲でevent metadataなし。PostHog無効・過去のデータなし・同意処理の成功を意味しない。project設定APIは403のまま                                                                |
| Sentry                    | Product/Web双方でread-only project/release metadata取得成功                                                                                                                                   | PII rule全体やsource map適用結果は未検証                                                                                                                                              |
| Upstash                   | 既存agent資格情報のPING成功                                                                                                                                                                   | Production/Integration/Previewごとの接続先やACL分離は証明しない                                                                                                                       |
| UptimeRobot               | `https://app.dayopt.app/api/health` monitorはup、300秒間隔。通知contactは1件、type=email                                                                                                      | 通知宛先や実到達は見ていない                                                                                                                                                          |
| Cloudflare DNS / registry | 全doctorの固定DNS検査がpass。公開RDAPはName.com registrar、期限2027-01-05、Cloudflare NS、DNSSEC delegation署名なし                                                                           | DNSSECの必須方針、Name.com auto-renew/回復設定は未確認。前回UIで見たDNSSEC disabledも履歴として残す                                                                                   |

migration比較は`supabase/migrations/[14桁]_*.sql`のversion集合を使い、`_archive`は含めない。Productionは**live main SHA**、Integrationは**live integration branch SHA**のGitHub treeとDB一覧を比較した。件数・最大versionだけでなく、全version集合のmissing/extraがそれぞれ0件。これはschema本文、全ACL/RLS、Edge secret値、backup restoreの検証を含まない。

## 変わらない取得不能・未確認

10/1の結果から、自動検出driftは増えていない。ただし次の項目は今回の全実行でも取得不能・manualのまま。

- **Vercel環境変数**: production/preview/integrationごとの全metadata、branch override、Supabase/Redis/PostHog/Stripe/Googleのbinding。CLIはdeployment inspectのみ取得。秘密値・replica一致も確認できない。
- **Stripe Live**: 現agent `op run` 経路ではLive資格情報を取得できない。Test accountとprice/webhookはdoctorで継続取得。Liveは別accountとして現行照合できていない。
- **Resend / Cloudflare管理 / Supabase backup**: 既存reader用credential経路または権限のエラーが続く。Resend API/webhookとCloudflare管理APIのAPI不存在とは扱わない。
- **PostHog project settings**: API 403。読み取りscope不足。計測削除資格情報・同意設定の最新値は未取得。
- **GitHub**: APIはrepository/admin領域の403。Oct1 UIで読んだenvironment secret名・Installed Apps名は履歴証拠であり、Oct3の再取得ではない。App permissionsとorg hooksも未確認。
- **Google**: provider client/callback/production-vs-nonproductionの現在値と実Calendar接続は別セッションの最終確認待ち。
- **実動作**: R2 restore、OAuth交換、Calendar同期、メール到達、通知到達、source map適用、削除・課金は読み取りだけでは証明していない。

1Passwordに既存の参照がない場合や現在のagent scopeで開けない場合、secretを作成・移動せず、許可済みの読取経路が用意されるまでunknownで残す。保存済みsecretはUIからも再表示できない場合があり、その値一致は最後まで証明不能のことがある。

## 次にできる読み取り照合

1. Vercel `env ls` に必要なDayopt project linkと既存read scopeが利用可能になったら、Project/Web・全target・branch overrideを対象にbinding metadataを取得する。今回のCLI inspectはdeploy metadataのみ。
2. Stripe Live・Resend・Cloudflare管理・Supabase backup・PostHogの各readerを既存認証で実行し、account/project固有metadataを更新する。token発行やscope拡張を棚卸しの一部にしない。
3. GitHub Appsの権限と対象repo、Name.com更新設定、SMTP設定は既存Dashboardで確認できるが、10/3は再訪していない。環境の現在の認証状態が利用できる範囲で読み取りのみ行う。
4. Google担当セッションから完了時のsource SHA・client/project metadata・provider callback・Vercel配信bindingを受け取り、この台帳と照合する。

ここまででmigration集合とProduction Productのrevisionについては前回より確実性が上がった。棚卸しcatalogは95検査全件を追跡しているが、**全サービス実設定100%の現行確認・全件正常とは結論できない**。残りは権限と検査対象の境界を保ったまま、最新read-only証拠を得られた箇所から更新する。
