---
status: current
last_verified: 2026-09-29
code:
  - scripts/runbook/mission-inventory.mjs
  - scripts/runbook/mission-mutations.mjs
---

# テスト耐性ミッションの再現

達成条件別の結果と未達理由は root の [missionissue](../../missionissue)、
機械可読な証拠は [inventory](../../mission-evidence/inventory.json) と
[mutation結果](../../mission-evidence/mutations.json) に保存する。

Node 24、依存関係インストール済みの repo root から実行する。

```sh
node scripts/runbook/mission-inventory.mjs
node scripts/runbook/mission-mutations.mjs artifacts/test-mission/replay 20260929
```

棚卸しは構文上の候補列挙であり、正常系・異常系の網羅を保証しない。
Mutation は時間・カレンダー・課金の純粋ロジック内の二項演算子から20箇所を抽出する。
元ソースを一時ディレクトリへコピーして1箇所ずつ変え、同じ suite を実行する。
専用設定に共通 mock setup は入れない。選択・元ソースのSHA・baseline・失敗assertion・
復元後の結果を出力先に保存し、未検出・検証不能・baseline不成立なら非ゼロ終了する。

同じ seed は同じ候補集合に対して選択を再現する。ソース更新で候補集合や位置が変わるため、
過去の結果との比較には選択ファイル・元SHAも照合する。20/20成功は全リポジトリの保証ではない。

テストの件数だけでなくsuite名とtest名もbaselineと照合する。候補が20箇所未満、
seed不正、選択後のソース変更、途中終了、収集不全、skip、復元後の欠落は成功にしない。
判定関数自身の正常・異常系も通常のscriptsテストで検証する。

## API境界の追加検証

`activities` の13 procedureは、実際のtRPC middleware → Service → Supabase clientを通す。
`router.test.ts` ではDBへのHTTP通信だけを置換し、内部Service・認可・billing・write fenceは実装を使う。
テスト用DBにはRLSを実装せず、所有者filterを落とした場合に他人の行が漏れるfixtureにする。
DBのRLS/FKそのものやHTTP cookie/token検証の証明ではなく、検証済みContextから先の契約を守る。
追加E2Eは0本。

```sh
pnpm --filter @dayopt/product exec vitest run --project unit src/features/activities/server/router.test.ts src/features/timeblock/schemas/plan-template.test.ts
node scripts/runbook/mission-api-mutations.mjs artifacts/test-mission/api-replay
```

後者は認証・MFA・OAuth・課金・write fence・所有者filter・入力境界の13変更を固定した追加実験。
先の無作為20試行とは分けて記録する。隔離コピーだけを変更し、各回復元、最後にbaselineと同一testの成功を要求する。
収集エラー・中断は検出成功に数えず、VitestのPromise assertionもstack markerとともに判定する。
**1件でも生存すれば終了コード1**。Routerの名前上限50→500はServiceの上限50が残るため
不正入力が引き続き拒否され、現在の振る舞いtestでは生存する。これを隠して20/20へ混ぜない。
