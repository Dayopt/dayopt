---
status: current
last_verified: 2026-10-05
code: scripts/ci/db-upgrade-check.mjs
---

# POC DB の安全な退役（#3022）

実装準備中の手順。外部 DB への適用・稼働確認は未実行。

## 適用順序

1. Phase A（PR #3023）で Calendar / Resend の POC backend を退役する。元 migration、RPC、状態テーブルとデータは維持する。
2. integration の稼働 SHA が Phase A を含むこと、旧 deployment / worker が POC RPC を呼ばないことを確認する。アプリのエラーと Upstash の正常経路を確認する。freeze 解除・merge・外部適用には別の明示承認が必要。
3. Phase B は別 PR。元 SQL を byte-identical に `_archive` へ保存し、同一 version の active path を固定 no-op tombstone にする。既存 ledger は修復・削除しない。fresh DB は実験用 schema を作らない。
4. forward migration は既知の 5 RPC だけを `DROP FUNCTION … RESTRICT` で退役する。`rate_limit_poc` の 2 テーブル・データ・RLS・ACL は保持する。未知の関数 overload、欠測、想定外テーブル、依存がある場合は transaction 全体を停止する。
5. Phase B の検証と適用確認が完了するまで Production candidate を保留する。原本・改変 POC SQL が active path にある候補は gate が拒否する。

## 検証と証拠

retirement contract は原本 hash、固定 tombstone、forward migration path、base 世代の runtime 退役、無関係な migration の不変性を検査する。基準は作業 tree ではなく base Git SHA。

DB Upgrade shadow で実際の元 SQL を disposable baseline に復元し、既存状態へ forward migration を適用する。finally で入力を元へ戻す。fresh と upgraded の app schema、RLS、生成型、catalog を比較する。旧契約の例外は退役済み 5 RPC だけ。他の互換性破壊は拒否する。POC 状態は count と全行 fingerprint で前後一致を確認する。

これらは runner の合成 DB の証拠である。Persistent Integration の稼働確認、適用前 backup、隔離 Preview の dry-run、独立レビュー、適用後確認が別途必要。未実行を成功と扱わない。

## 復旧

state は削除しないため RPC 定義だけを戻せる。`node scripts/runbook/poc-retirement-recovery.mjs > /tmp/poc-rpc-recovery.sql` は hash を検証した原本から 5 RPC・元の GRANT・セキュリティ assertion の復旧 SQL を生成する。DB に接続しない。旧 migration 全文を実行すると既存 schema/table と衝突するため実行しない。

失敗した退役 transaction は rollback される。適用後の復旧が必要なら、明示承認と独立レビューの下で生成 SQL の新しい forward migration を作り、隔離環境で検証して既存 migration owner に渡す。ledger repair、履歴削除、共有 DB reset、CASCADE、テーブル削除は禁止。

## Disposable CI recovery rehearsal

既存 POC baseline の場合、forward 適用直後に original archive から5 RPCを復旧し、元の security assertion を実行する。同じ table OID・合成行 fingerprint・schema/table ACL・RLS・policy・index・constraint・trigger が保たれることを確認してから、固定 forward SQL を再適用する。復旧後の exact5 signatures と再退役後の RPC不在を確認する。最後の fresh reset では POC schema と named RPC がないことを直接検査する。実行結果は DB Upgrade artifact に残る。共有 DB の復旧・backup を実行した証拠にはしない。
