# 必要な場合だけ行う永続 handoff

- `routing.level` は通常実装を L2、危険な手掛かりがあれば L3、情報不足なら `unclassified` とする。別フィールド `preparation: L1` は追加の事前整理候補で、コード変更の自動許可ではない
- `routing.ready` は入力項目の存在確認だけ。受け入れ条件・検証コマンドの検出は既存の文字列判定なので、内容が十分かは担当が確認する。`status:ready` の付与・merge・production 操作を許可しない
- path / 本文の一致は保守的な手掛かり。calendar 内の小修正も L3 候補になる場合がある。差分の実際の意味を確認して層を下げる時は理由を残す。一致なしを安全の証明にしない
- 想定原因と実測が食い違う、対象が広がる、同種の失敗が続く時は AGENTS.md の停止条件に従い、証拠を残して再判定する

### `preparation: L1` の資料を再利用する

引き渡しが必要な作業にだけ使う。同じ担当が小修正を完了できる時は資料を増やさない。

```bash
pnpm --silent ctx <N> --json > /tmp/dayopt-context.json
pnpm handoff:create --context /tmp/dayopt-context.json \
  --source scripts/tasks/ctx.mjs --source scripts/tasks/trace.mjs \
  --out /tmp/dayopt-handoff.json
pnpm handoff:validate --context /tmp/dayopt-context.json --file /tmp/dayopt-handoff.json
```

`--source` は作業ごとの関連ファイルに置き換える。repo 内のファイルを 1〜40 件まで明示する。ディレクトリ丸ごとや秘密ファイルは収集しない。生成された JSON は `draft` で、既存ファイルは上書きしない。L1 は以下を記入する:

- `goal` / `acceptance`: ユーザーの目的と完了条件
- `facts`: `{ "claim": "確認した事実", "path": "scripts/tasks/ctx.mjs", "line": 1 }` の配列。選択した source と実在する行番号を根拠にする
- `hypotheses` / `unknowns`: 推定と未確認事項を別々の文字列配列にする。未確認範囲を空配列で隠さない
- `verification`: `{ "command": "実行したコマンド", "status": "passed", "exitCode": 0, "output": "出力の要点" }` の配列。未実行は `status: "not-run"`、`exitCode: null`、`output` に理由を書く。失敗は `failed` と実際の非 0 exit を記録する
- `nextAction`: 次の担当に判断してほしい問い。記入後に `status` を `ready` または `partial` にする

対象 HEAD・選択した source の作業中の内容・ctx のハッシュが変われば再利用できない。引き渡す前に ctx を再取得して検査する。資料の生成時点から対象が変わったら新しい出力先へ作り直し、変化した事実だけ再確認する。PR は現在の HEAD が PR head SHA と一致する checkout で作る。snapshot と snapshotId は編集しない。

検査結果は `ready` / `partial` / `stale` / `invalid`。`ready` 以外は非 0 exit で、未実行や未確認を完了扱いしない。これは鮮度・形式・根拠参照の検査であり、記述の真偽・コマンドの実行・安全性は証明しない。選択していないファイルの変化も保証外。L2・L3 は論点に必要な一次資料と結果を確認する。独立レビューへ L1 の安全性の結論を引き継がない。保護対象 PR だけ GitHub の `@codex review` を使い、追加 reviewer は User が明示的に再開を指示するまで停止する（`pr-cross-review` skill）。

### 効果の回収

最初の数件は issue / PR に「採用した層と model、再利用した根拠、調べ直した範囲、手戻り・User 介入」を短く残す。評価単位は完了 1 件あたりの総消費と再探索・手戻り。`pnpm ai:usage` の Codex は現状未収集なので、0 消費や節約済みと扱わない。Codex の利用量を実測できる経路が揃うまでは、定性的な改善と消費量の主張を分ける。

## 委譲 prompt の骨格

```text
目的: <ユーザーが確認できる outcome>
成功条件: <受け入れ条件>
確認済みの事実: <path / issue / command output>
未確認の仮説: <無ければ「なし」>
触ってよい path: <scope>
禁止事項・権限: <stage / commit / push / external mutation の可否>
検証: <そのまま実行できるコマンドと確認観点>
最終報告: 変更または所見、根拠、検証出力の要点、未確認事項、deferred scope
```

通常の調査委譲は read-only とし、commit / push / external mutation は含めない。
