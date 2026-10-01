---
status: current
last_verified: 2026-10-01
---

# 非本番Google OAuth切替の実行準備

設定方針とcredential台帳は[Secrets正本](../../operations/secrets.md#google-oauth-の本番非本番分離)、確認結果は[棚卸し記録](triage-2026-09-30.md)。本書は未実行工程の順序と停止条件。doctorの読み取り処理へ変更操作を追加しない。

## 固定する対象

| 対象                     | 値                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Google project           | `dayopt-nonproduction` / `279051514343`                                                       |
| Supabase Integration ref | `tilwaprottpyhlfoggbb`                                                                        |
| Auth client              | `Dayopt Auth Nonproduction`、台帳の`google_auth_nonproduction_client`参照                     |
| Calendar client          | `Dayopt Calendar Nonproduction`、台帳の`calendar_nonproduction_client`参照                    |
| Calendar replica         | Vercel ProductのPreview、git branch `integration`限定                                         |
| Calendar callback        | `https://product-git-integration-dayopt.vercel.app/api/integrations/google-calendar/callback` |

Calendar client IDと`GOOGLE_CALENDAR_PROJECT_NUMBER`はDBのcanonical identityと一致させる。通常のPR PreviewへCalendar設定を広げない。

2026-10-01、Vercel MCPのdeployment GETで固定Integration aliasの所属を確認した。Product projectは`prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa`、deploymentは`dpl_cRoZbbZRjhNXaHbLTY5kXoDQdPuC`、状態はREADY、branchは`integration`、SHAは`1494df3ecb1e2d02e558b25d1cc6f34e30178b82`。APIの`target`はnullで、返却metadataだけから環境種別やruntimeのDB接続を追加推論しない。Git objectの同revisionではproject番号とclient ID prefixの照合、Calendarのnarrow pair / offline / consent要求を確認した。DBのruntime接続先・env replica・実交換は未確認。

## 実行順序

1. テストに使うGoogleアカウントをUserが指定し、非本番OAuthのテストユーザーへ登録する。サポートメールの選択をtest user追加の許可とみなさない。Calendar用データは専用テストカレンダーに用意する。
2. Calendar APIの有効状態と、同意画面のscopeを確認する。Authの基本scopeと、Calendarコードの`openid` / `email` / `calendar.calendarlist.readonly` / `calendar.events.readonly`を照合する。未保存のscopeや未実施の認可を成功と扱わない。
3. 固定Integration aliasが指すdeploymentの完全SHA、Preview target、git branch、Supabase refを取得し、その配信revisionのauthority契約を照合する。現在のcheckoutのコードだけでは判定しない。
4. 下記のDB基線を実行直前に再確認し、安全に射影したbackupを取得する。登録するproject / clientは後から通常操作で変更できないため、DB登録案を独立レビューし、既存手順の停止条件を非本番基線へ合わせたdry-runを用意する。対象refと正当なservice-role実行経路を確認するまではprovision / activationを呼ばない。読み取り経路での権限拒否を、role / claim変更で回避しない。
5. dry-runはtransaction内でprovision → readiness → activation → postconditionを確認して`ROLLBACK`する。保存済み状態を変えないdry-runの成功と、COMMITの成功は区別する。COMMITは明示許可・独立レビュー・dry-run / backupが揃ってから実行する。
6. Auth用masterのclient ID / secretを、非本番Supabase Google providerへ設定する。redirectは`https://tilwaprottpyhlfoggbb.supabase.co/auth/v1/callback`。nonce / email検査を緩和しない。UIによる新credentialの入力・保存はUserが行う。
7. Calendar用masterから`GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`を固定Integration branchへ設定し、`GOOGLE_CALENDAR_PROJECT_NUMBER=279051514343`と上記callbackを揃える。既存のtoken暗号鍵の確認・master対応を別に行い、今回のclient移行と同時にrotationしない。Vercel変更・再配信は承認済みの実行経路で行う。
8. 新deploymentのSHA / DB / credential identityを再取得する。新clientでGoogleログインとCalendar再認可・同期を実行し、旧clientのtokenを流用しない。secretの存在確認だけでは、値の正しさや認可成功を証明できない。
9. 新projectで発行した非本番tokenの切断を確認する。旧projectのgrant取消・client削除は別工程。External / TestingのCalendar refresh token期限を含め、再認可手順を残す。

## DB基線と停止条件

2026-10-01（JST）の固定metadata queryはSupabase MCPで`BEGIN TRANSACTION READ ONLY` / `ROLLBACK`内に実行した。

| 項目                          | 確認値                             |
| ----------------------------- | ---------------------------------- |
| Google接続件数                | 0                                  |
| 未割当Google接続件数          | 0                                  |
| authority project / fence件数 | 0 / 0                              |
| revoke operation / outbox件数 | 0 / 0                              |
| provision RPCの`md5(prosrc)`  | `306d817b323f64c7ca042ecd1fd431ae` |
| readiness RPCの`md5(prosrc)`  | `53b065dcb498575e668202d275865d31` |

関数は現在のmain `67dcc653266b45ddf53e9d50cc44ec6c2c58672b`の[本番cutover手順](https://github.com/Dayopt/dayopt/blob/67dcc653266b45ddf53e9d50cc44ec6c2c58672b/scripts/runbook/calendar-authority-cutover.sql)と一致する。ただしその手順は**本番専用**で、project / client / Google接続1件の条件を持つ。そのまま実行・流用しない。このcheckoutには同fileがないため、他worktreeを変更せずGit objectから読んだ。

基線の変化、対象ref不一致、RPCの相違、既存Google接続や取消処理の出現、readinessの権限拒否、配信revision不明は停止条件。DBのGoogle接続が空でも、他のDayoptデータが空とはみなさない。reset / purgeや旧grant取消を復旧手段にしない。

## 完了判定

API有効化とclient / master作成は確認済み。テストユーザー、scope、配信revisionのruntime接続照合、DB登録、replica切替、新clientでの実動作は未完了。切替前ならreplicaは旧状態を保持する。DBのidentity登録後は通常の設定巻き戻しだけでは復旧できないため、失敗時は再認可を止め、登録済みidentityを変更・削除せず原因を調べる。
