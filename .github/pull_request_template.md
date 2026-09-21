## 関連 Issue

<!-- Issueごとに1行。`Closes #1, #2` は #1 しか閉じない罠に注意 — 複数ある場合は行を分けて `Closes #1` / `Closes #2` と書く。完了するものは `Closes #N`、epic・部分対応や参照だけなら `Refs #N`。該当なしの場合は理由を書く。 -->

## 復唱（チケットの理解を自分の言葉で）

<!-- 着手時（Draft PR を開いた直後）に記入する。何を・なぜ・どこまでやるか。**チケット本文のコピペ禁止** — 言い換えで埋めると誤解検知の機能が死ぬ。Main はレーン起動直後にここだけを読み、チケットとの齟齬があれば即座に issue コメントで訂正する（実装後に気づくと往復 1 日、復唱なら 5 分）。 -->

## 作業計画

<!-- 着手時に記入し、進行に応じて更新する。 -->

- [ ]

## 触るファイル領域

<!-- 着手時にディレクトリ / パッケージ単位で記入する。ここから出ないと解決できないと判明したら、変更を進めずに停止して報告する（`AGENTS.md §レーン運用` §停止条件）。 -->

## 目的と invariant

<!-- ユーザーに何が変わるかと、この変更後も必ず守る挙動を簡潔に書く。 -->

## Review focus

<!-- 該当する境界だけを書く: auth / RLS / billing / webhook / migration / time boundary / cache / observability。該当なしなら「なし」。 -->

## 検証

<!-- 実行したcommand（pnpm check 等）、確認した画面・API・DB状態、実施したレビューがあれば対象。再現可能な証拠を書く。 -->

## Rollback・外部状態

<!-- rollback不能な変更、外部サービスやproduction state、段階展開の有無を書く。`scripts/ci/production-config-audit.mjs` / 各 `production-build-gate.mjs` / `production-config-audit.yml` に触れる場合は trusted dispatch が必要（`production-config-audit.yml` の self-change 検出を参照）。該当なしなら「なし」。 -->

## 例外・後続対応

<!-- 意図した例外、未検証事項、別Issueへ送った作業を書く。該当なしなら「なし」。 -->
