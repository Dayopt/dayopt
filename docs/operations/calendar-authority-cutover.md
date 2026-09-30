---
status: current
last_verified: 2026-09-30
code:
  - scripts/runbook/calendar-authority-cutover.sql
  - supabase/migrations/20260730090013_calendar_authority_fence_commands.sql
---

# Calendar authority 本番有効化

## Goal

既存の Google 接続を保持し、本番の Calendar authority を登録・有効化してから fenced OAuth を配信する。

## Minimum Viable Approach

既存の provision / readiness RPC を使う設定 DML を [実行SQL](../../scripts/runbook/calendar-authority-cutover.sql) に固定する。DDL / migration の手動適用ではない。Google credential / scope を変更しない。SQL の既定終端は ROLLBACK。独立レビュー、隔離DBでのdry-runと確定テスト、バックアップ確認後だけ COMMIT に置き換えて実行する。Production は `yvglwblxrnrenfifsnje` に限定し、固定 Integration へ流用しない。

## Reversibility Table

| 操作                          | 可逆性                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| 読み取り確認・SQL手順の変更   | [minutes]                                                                      |
| ROLLBACKを終端とするdry-run   | [minutes] transaction内の変更を破棄。lock中は書き込みが待つ                    |
| provisionとactivationのCOMMIT | [irreversible] DBのidentityと有効化はroll-forward-only。以後は保持して修復する |
| 新runtimeの配信               | [hours] 旧deploymentへ戻せるがauthorityの無効化はしない                        |

有効化を確定する理由は、接続・同期・失効処理を同じGoogle project / subjectの権限境界に揃えるため。誤identityの登録は後から差し替えないので、Vercelで使用する本番clientとGoogleの本番clientの一致を先に確認する。

## Existing Code to Reuse

- `provision_calendar_authority_project_v1` は既存NULL fenceへsubject fenceを付ける。generation不一致では失効待機を作るため、この手順では不一致を事前に拒否する。
- `get_calendar_authority_readiness_v1` はidentity一致、有効化、pending、unboundを集計する。
- [既存の実DBテスト](../../apps/product/src/lib/test/integration/calendar-revoke-authority.integration.test.ts) で同じSQLのrollback、確定、generation不一致、再実行拒否を検証する。fixtureのidentityのみ置き換え、Productionデータを持ち込まない。

## What I'm Not Doing

既存接続・原本予定の削除、資格情報のローテーション、Googleの同意画面変更、固定Integrationへの設定反映はこの手順に含めない。全体DBのrestoreを通常の取り消し操作にしない。

## 読み取り確認の結果

2026-09-30のProduction集計は以下。実行直前に再確認し、変わっていたらSQLの条件を緩めず再評価する。

- latest migration `20260924120643`。PR #2903 の4 migrationは未適用、repair RPCも未反映。
- authority project / fence は0件。Google接続は1件、activeかつfence / epochがNULL。
- generation不一致、revoke outbox、revoke operationのpending、有効なPlan / Recordの外部予定参照重複はすべて0件。
- 本番Google clientは既存 `Dayopt Calendar Import`、callbackは `https://app.dayopt.app/api/integrations/google-calendar/callback` のみ。Integration / Supabase Auth clientとは別。2026-09-30にユーザーが1Passwordの本番CLIENT_IDとの一致を確認。
- Vercelの本番CLIENT_IDはSecret型で再表示不可。設定値を本レーンで変更していない。今回の確認はユーザーの一致確認に基づき、実runtimeからsecret値を取得した証明ではない。
- 最新本番deployment `dpl_HZ37XXz8DRy5uchUer9j8YmXHV6B` はReady、main `96cc9798be302b307fc6bb6d7e20e16e2d9c9268`。PR #2903 のruntimeは本番未配信。
- Dashboardの最新物理backupは2026-09-29 18:35:32 UTC（9月30日03:35:32 JST）。確認時点で7日分。これはauthority変更直前の専用snapshotではない。全体restoreはこの時刻以降の他機能の書き込みを失うので、最終手段として別途判断する。

本番RPCのprosrc MD5をrepoの同じ関数本文と照合して一致確認。SQLはその2つのfingerprintも検査し、別定義へ変わった場合は停止する。MD5は同一定義の照合であり、権限・信頼性の代用ではない。

## 適用順序と停止条件

1. 隔離CIでSQLのdry-run / COMMIT /拒否を確認し、公開HEADのCI成功後に保護対象の独立レビューを依頼する。既存P1は本番実測が終わるまで未解決に保つ。
2. backupの最新成功時点、Production ref、Google identity、migration、現在のdeploymentを再確認する。別レーンの本番反映と同時に実行しない。
3. SQLは5秒lock / 60秒statement上限。authority・revocation・接続・generation管理表をロックし、監査した初期状態と関数定義の一致を確認する。既定のROLLBACKで本番dry-run、結果は集計だけ記録する。外部Google APIは呼ばない。
4. dry-run成功後、同じSQLの終端だけCOMMITへ変更して1回実行する。登録、legacy backfill、有効化、readiness検査が同じtransactionなので途中失敗は全体を破棄する。応答消失時は再実行せず、read-onlyでidentity・activation・fenceを確認する。
5. readinessのactivated=true、project_state=ready、pending_operations / unbound_connections / unbound_outbox=0を確認。既存接続のstatus・generation・token ciphertextの保持はSQL内/隔離テストで確認し、秘匿値を会話やPRへ出さない。
6. #2903のmigrationとruntimeを正規のmerge/配備経路で適用する。手動db pushはしない。旧runtimeのcallbackが配備中にNULL fenceを新規作成し得るため、配備後に同じ集計とlegacy repair経路を再確認する。管理設定だけでOAuth準備完了とはしない。
7. 共有保留の解除が確認できた環境で、接続・一覧・同期・明示変換・切断を実測する。本番ユーザーデータの変更を伴う試験は具体的な対象を決めて実施する。

### 失敗時

- lock timeout / precondition不一致 / readiness不合格ならCOMMITしない。スナップショットを取り直し、条件を消して再試行しない。
- COMMIT後はsingletonの削除・identity書換え・activation=0への巻き戻しをしない。旧runtimeへのrollbackとauthorityの保持を分け、必要なら再接続または修復する。
- backup restoreはDB全体と他作業へ影響するため、この手順で自動実行しない。

## 検証状態

SQLと隔離DB回帰テストを作成済み。実行結果・独立レビュー・本番dry-run / COMMITはPR #2903へ記録する。作成やunit成功を本番適用済みの証明にしない。
