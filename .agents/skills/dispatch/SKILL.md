---
name: dispatch
description: GitHub Issue を新しく起票する時、または既存 Issue を別の担当へ実際に引き渡す時に使う。重複・着手可否・作業範囲を確認し、Issue 本文と引き渡しコメントを整える。通常の作業開始、進捗確認、定期棚卸しには使わない。
---

# Issue の起票と引き渡し

Issue の分類・停止・作業順は [AGENTS.md](../../../AGENTS.md) §Issue の進め方、ラベルの一覧は [github-labels.md](../../../docs/operations/github-labels.md) に従う。この skill は Issue を作る時と担当を移す時だけ使う。Issue の実装や通常の進捗確認は担当が直接行う。

## 起票

1. `gh search issues '<対象のキーワード>' --repo Dayopt/dayopt` で open / closed の重複を調べ、既存 Issue で扱える場合はそこへ記録する。独立した受け入れ条件や時期を持つ仕事だけ新しい Issue にする。
2. 作業対象の Issue に Type を 1 つ付ける。既存 Mission に属する場合は子 Issue にする。着手できない前提があれば解除条件を本文へ書き、open Issue に `status:blocked` を付ける。`area:*` / `quality:*` は検索に役立つ時だけ使う。PR へ分類ラベルを複製しない。
3. 本文に次の 4 節を埋める。事実と推定を区別し、検証できる受け入れ条件を含める。形式は実装・判断の許可ではない。外部作用や不可逆操作は §注意 に明記し、実行には AGENTS.md の権限境界を適用する。

```markdown
## 背景

解決する問題、確認済みの事実と未確認の仮説、関連 Issue / PR

## やること

目的、範囲、受け入れ条件、未解決事項

## 注意

触らない範囲、権限境界、外部作用、停止・復帰条件

## 検証

受け入れ条件を確認する具体的な手順。実行前の計画と実行済み結果を区別する
```

調査・Question のように成果物が判断なら、必要な証拠と回答形式も本文へ書く。Issue Form や API からの起票でも同じ内容を満たす。milestone は対象リリースへ入れると決めた時、または着手時に付ける。

## 担当へ引き渡す時

4. 対象 Issue が open で `status:blocked` を持たないことを `gh issue view <N> --json state,labels` で確認する。ブロック解除は本文の解除条件を確かめ、前提と作業範囲を見直してから行う。
5. リンク済み open PR と `git worktree list` を見て、既に担当がいるか、対象 path が衝突しないか確認する。重なる仕事は可能なら同じ担当に束ねる。
6. Issue 本文の 4 節、受け入れ条件、検証手順を整える。未解決の前提があれば着手させず `status:blocked` にする。
7. Issue コメントに担当、範囲、完了条件を 1〜3 行で記録する。担当には Issue URL と `pnpm ctx <N> --reuse-brief-l1` を渡し、本文を要求の正本とする。実装では最初の commit の後に Draft PR を作る。PR と Issue に対象 milestone を付ける。

定期棚卸しや自分の作業の開始にはこの引き渡し手順を要求しない。Issue の open / closed、PR、コメントと worktree を直接見る。
