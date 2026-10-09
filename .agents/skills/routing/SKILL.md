---
name: routing
description: 非自明な作業の方針・検証方法を決める時、前提と実測が食い違う時、委譲が必要な時に使う。Issue 本文と一次資料から最小の進め方を決める。手順が確定した小修正では不要。
---

# 作業方針

## When to Use

- 成功条件・対象範囲・検証方法が未整理の作業を始める時
- 前提と実測が矛盾し、進め方を見直す時
- 委譲や別 session への引き渡しが必要な時

## When NOT to Use

- 手順が確定した小修正
- Issue 起票・割り当て（`dispatch`）、独立レビュー（`pr-cross-review`）

## 進め方

1. 目的・範囲・検証方法を短く示し、[判断の入口](../../../docs/decisions.md#判断する前に読む)から関連する現行の正本と判断理由を確認する。Issue がなくても、提案前に対象の機能名・旧称・却下案を決定索引で検索し、後継・適用範囲を確かめる。既決事項を人間に聞き直さず、未決・衝突・前提の変化だけを示す。
2. 文書内の現状説明は `pnpm --silent docs:read <repo-relative-path>` で取得し、[文書の標準手順](../../../docs/README.md#ai-の標準手順)に従う。`rg` は所在の検索に使い、保存された生成本文だけで現行仕様を判断しない。
3. 同じ主担当が最小の変更と検証を進める。検索・集計・検査は既存 script / CLI を使う。
4. Cloud-first、Local-optional。クラウドを基本に、必要なら既存のローカル環境を使う。作業中の別 checkout を変更しない。
5. 証拠が増えない失敗は原因を切り分け、未決の要求・scope・権限だけ確認する。モデルや agent の切替を必須工程にしない。
6. 成功条件に実行結果を照合し、未確認事項を報告する。

高影響変更は [AI開発標準ループ](../../../docs/operations/ai-development-loop.md) の spec-first、操作の許可は AGENTS.md の authority 境界に従う。plan・Brief・助言は許可を与えない。

## Issue Context Brief

Issue / PR に着手する担当は `pnpm ctx <N> --reuse-brief-l1` で Issue 本文と Brief を取得する。本文が要求の正本、Brief は読む資料の助言。Brief にない資料を無関係とみなさない。

取得失敗・古い Brief では未取得を報告し、本文と一次資料から続ける。コメントの存在だけで取得済みと扱わない。`--reuse-brief-l1` は旧 L1 助言の互換 flag で、指定しなくても同じ L0 の Brief を返す。品質評価を Brief の日常利用の条件にしない。入力仕様は [dispatch](../dispatch/SKILL.md)。

Brief の決定ログは対象・親・リンク先の Issue / PR 番号を含む行の抜粋で、表示は各行 200 文字まで。番号で結ばれていない類似判断、撤回・後継、理由の全文を網羅しない。候補がないことを「過去判断なし」と扱わず、正本と索引を検索して補う。記録・更新・未決の扱いは [意図の継承](../../../docs/operations/ai-development-loop.md#意図の継承)に従う。

## 委譲・引き渡しが必要な時だけ

単独完遂が基本。委譲は独立した大量調査で、引き渡し・待ち・主担当の照合を含めて利益がある場合だけ比較する。判断と重要な編集は主担当が持つ。

read-only と repository scope を runtime で同時に強制・確認できない経路では調査を委譲しない。prompt や manifest を権限境界とみなさない。現行 native delegation はこの区別を持たないため使わない。専用 security harness のレビューは別契約。

許可された委譲には成功条件・対象 path・制約・返す証拠・検証方法・外部変更の可否を示す。write は同一 worktree の非重複 scope に限り、commit / push / 外部変更は明示委任が必要。主担当が現在の HEAD・diff と照合する。

別 session へ実際に引き渡す場合だけ [handoff](references/handoff.md)、Chat 連携が必要な場合だけ [chat-handoff](../../../docs/operations/chat-handoff.md) を読む。助言は担当・人間の承認・authority を移さない。
