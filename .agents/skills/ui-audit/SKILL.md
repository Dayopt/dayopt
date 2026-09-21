---
name: ui-audit
description: 「この UI を監査して」「アクセシビリティを確認して」など、指定した画面・component の操作性とアクセシビリティのコード監査が明示された時に発動。固定スナップショットの Web Interface Guidelines と Dayopt の既存 UI 規約で読み、file:line と実害と最小修正案を返す。デザイン探索や PR の不具合レビューでは発動しない。
effort: medium
maxTurns: 15
---

# UI 監査（ui-audit）

指定された UI コードを、アクセシビリティ・操作性の観点で読む。**デザインシステムの生成や新規デザイン探索はしない**。上流（Vercel Labs Web Interface Guidelines）の規則を Dayopt の規約に合わせて固定・調整した調整版で、公式原文そのままではない。

## When to Use

**明示発動型** — この skill はユーザーの explicit な UI 監査意図のみを契機に発動する。

- 「この画面／component を監査して」「アクセシビリティを確認して」と対象を指定された時
- 新規 UI を出す前に、操作不能・キーボード到達不可・コントラスト不足を洗い出すよう指示された時
- 既存画面の操作性の問題を、コードから列挙するよう指示された時

## When NOT to Use

この skill は **explicit な UI 監査意図のみを契機とする**。参考として近接するが発動しないケース:

- PR の不具合レビュー → AGENTS.md §レビュー規則（diff が生む不具合だけを指摘する）
- Story の新規作成・design token の選択 → `storybook` skill
- UI 文言・用語・翻訳の判断 → `i18n` skill
- 実ブラウザーでの操作検証 → 既存 Playwright / Storybook
- データ取得・bundle の性能 → `react-performance` skill

## 手順

1. 対象ファイルを読む。範囲が曖昧なら対象を確定してから始める
2. [`references/web-interface-guidelines.md`](./references/web-interface-guidelines.md) の該当セクションだけを参照する
3. 既存の機械検査（eslint / `pnpm lint:tokens` / axe / 既存 test）が既に検出する項目は**報告しない**。重複指摘は監査の価値を下げる
4. 好み（配色の趣味、余白の微差、命名）と、実害（操作不能、キーボード到達不可、読み上げ不能、タップできない、文字が切れる）を分ける。報告するのは実害
5. 修正案は `@dayopt/components` と semantic token の範囲で書く。生の色値・px や新規依存を提案しない

## 出力契約

ファイルごとにまとめ、1 件 1 行:

```text
## apps/product/src/features/x/components/Y.tsx

Y.tsx:42 - アイコンボタンに aria-label が無い → 読み上げで用途が分からない。`aria-label` を足す
Y.tsx:88 - outline-none に focus-visible の代替が無い → キーボード操作で現在位置を見失う
```

- **`file:line`、ユーザーに起きること、最小の修正案**の 3 点を書く。修正が自明なら説明は省く
- 問題が無ければ `✓ pass` と書く。数合わせの指摘をしない
- **コードを読んだだけで「実ブラウザーで確認済み」と書かない**。挙動の確認が要る指摘には「未確認」と明記し、必要なら既存 Playwright / Storybook で確認する
- スタイルの好みを新しい merge gate にしない。監査結果は advisory であり、PR を止める根拠は AGENTS.md §レビュー規則の failure scenario

## 関連スキル

- `storybook` - Story 作成・design token
- `i18n` - 文言・用語・禁止表記
