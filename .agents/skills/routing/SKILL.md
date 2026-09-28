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

1. 目的・範囲・検証方法を短く示し、既存実装と判断を確認する。
2. 同じ主担当が最小の変更と検証を進める。検索・集計・検査は既存 script / CLI を使う。
3. Cloud-first、Local-optional。クラウドを基本に、必要なら既存のローカル環境を使う。作業中の別 checkout を変更しない。
4. 証拠が増えない失敗は原因を切り分け、未決の要求・scope・権限だけ確認する。モデルや agent の切替を必須工程にしない。
5. 成功条件に実行結果を照合し、未確認事項を報告する。

高影響変更は [AI開発標準ループ](../../../docs/operations/ai-development-loop.md) の spec-first、操作の許可は AGENTS.md の authority 境界に従う。plan・Brief・助言は許可を与えない。

## Issue Context Brief

Issue / PR に着手する担当は `pnpm ctx <N> --reuse-brief-l1` で Issue 本文と Brief を取得する。本文が要求の正本、Jev の L1 候補は読む資料の助言。候補外の資料を無関係とみなさない。

再利用は trusted `ctx-brief` の Issue 番号・URL・入力 snapshot・公開 HEAD SHA・投稿者を照合できる場合だけ。欠落・古い Brief・取得失敗では未取得を報告し、本文と一次資料から続ける。コメントの存在だけで取得済みと扱わない。

通常読取は Jev API を呼ばない。dispatch 担当だけが既存の key 注入経路で `pnpm ctx <N> --post` を使い、同じコメントを更新する。Cloud 担当へ key を渡したり、`--post` を要求したりしない。品質評価を Brief の日常利用の条件にしない。入力仕様は [dispatch](../dispatch/SKILL.md)、Jev の仕組みは [jev.md](../../../docs/operations/jev.md)。

## 委譲・引き渡しが必要な時だけ

単独完遂が基本。委譲は独立した大量調査で、引き渡し・待ち・主担当の照合を含めて利益がある場合だけ比較する。判断と重要な編集は主担当が持つ。

read-only と repository scope を runtime で同時に強制・確認できない経路では調査を委譲しない。prompt や manifest を権限境界とみなさない。現行 native delegation はこの区別を持たないため使わない。専用 security harness のレビューは別契約。

許可された委譲には成功条件・対象 path・制約・返す証拠・検証方法・外部変更の可否を示す。write は同一 worktree の非重複 scope に限り、commit / push / 外部変更は明示委任が必要。主担当が現在の HEAD・diff と照合する。

別 session へ実際に引き渡す場合だけ [handoff](references/handoff.md)、Chat 連携が必要な場合だけ [chat-handoff](../../../docs/operations/chat-handoff.md) を読む。助言は担当・人間の承認・authority を移さない。
