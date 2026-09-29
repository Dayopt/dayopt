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
