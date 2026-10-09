---
name: test
description: バグ修正・挙動変更の着手時（実装前に症状を検出する失敗テストを書く）、新機能実装の完了時（tRPC procedure / React hook / pure function / component の新規作成後）、既存テストの assertion 追加が必要な実装変更時に発動。Vitest + Testing Library の配置規約（対象ファイルの隣に `X.test.ts`）と red → green の規約に従う。型定義のみ・UI 文言のみの変更では発動しない。
effort: medium
maxTurns: 15
---

# テスト作成スキル

Dayoptのテスト作成を支援するスキル。Vitest + Testing Libraryを使用。

## When to Use

以下の状況で発動:

- バグ修正・挙動変更に着手する時（**実装前に**対象症状を検出する失敗テストを書く）
- 新規 tRPC procedure / service 関数 / React hook / pure function を実装完了した時
- 複雑な状態遷移を持つ component を新規追加した時
- Zod schema の制約を追加・変更した時（入力境界の test case 追加）
- 既存の実装変更で分岐や境界条件が増えた時（未カバーの path が生まれる）
- バグを修正した直後（実装前に置けなかった場合に、同じ回帰を検知するテストを追加する）

## When NOT to Use

- 型定義のみの変更（挙動が変わらず、テスト対象の実装が存在しない）
- UI 文言・レイアウトのみの変更（`storybook` skill の視覚検証領域、test 対象外）
- 既存テストのリファクタリング（構造変更のみ、カバレッジは変わらない）

## 技術スタック

| ツール          | 用途                      |
| --------------- | ------------------------- |
| Vitest          | テストランナー            |
| Testing Library | コンポーネントテスト      |
| MSW             | APIモック（必要に応じて） |

## テスト配置ルール

**`X.test.ts` は `X` の隣に置く。`__tests__/` ディレクトリは作らない**（[#2485](https://github.com/Dayopt/dayopt/issues/2485)）。

```
apps/product/src/features/{feature}/
├── components/
│   ├── MyComponent.tsx
│   └── MyComponent.test.tsx
├── hooks/
│   ├── useMyHook.ts
│   └── useMyHook.test.ts
└── utils/
    ├── myUtil.ts
    └── myUtil.test.ts
```

## 実行環境（node / happy-dom）

`apps/product` の unit test は **2 つの project に分かれる**。全 test に happy-dom を掛けると
実行時間の大半が DOM 構築とモジュール読み込みに消えるため、**既定は `node`** で、DOM が要るものだけ happy-dom に入れる。

| project    | 環境        | 対象                                                          | setup           |
| ---------- | ----------- | ------------------------------------------------------------- | --------------- |
| `unit`     | `node`      | 上記以外の `*.test.ts`（domain / service / lib の純ロジック） | `setup-node.ts` |
| `unit-dom` | `happy-dom` | `*.test.tsx`、`use*.test.ts`、明示列挙した例外                | `setup.ts`      |

- **component / hook の test は自動で happy-dom 側に入る**（`.tsx` と `use*` の 2 パターン）。
  普通に書いていれば意識しなくてよい
- **上の 2 パターンに当てはまらない test で DOM が要る場合**は、`apps/product/vitest.config.ts`
  の `DOM_ONLY_TESTS` に path を追加する
- **分類が合っているかはローカルで判断しない。** Node 22 以降は `environment: 'node'` でも
  `localStorage` が使えてしまい、**ローカルでは通るのに CI（Node 24）で
  `ReferenceError: localStorage is not defined` になる**。分類を変えたら CI を oracle にする
- **DOM 依存は test を読んでも分からないことがある。** test 本体が localStorage に触れて
  いなくても、**実装側**が触っていれば DOM が要る。迷ったら DOM 側に置く（遅くなるだけで壊れない）
- **module mock（`server-only` / `next/navigation` / `next-intl`）は両 project 共通**。
  追加する時は `src/lib/test/setup-node.ts` に書く（`setup.ts` はこれを import している）。
  `setup.ts` にだけ足すと node 側の test が静かに素の実装を掴む

## テスト実行コマンド

```bash
# 単一ファイル
pnpm test -- path/to/file.test.ts

# 特定のディレクトリ（pnpm test は apps/product 内で vitest を起動するため package-relative）
pnpm test -- src/features/calendar/

# 全体
pnpm test

# ウォッチモード
pnpm test -- --watch
```

## テストケース設計

### 3つのカテゴリ

| カテゴリ     | 内容                           | 優先度 |
| ------------ | ------------------------------ | ------ |
| 正常系       | 期待通りの入力                 | 必須   |
| エラー系     | 異常な入力、エラーハンドリング | 必須   |
| エッジケース | 境界値、空配列、null           | 推奨   |

## red → green の規約

バグ修正と挙動変更では、**修正の前に**その症状で失敗するテストを書く。修正してから書くと、そのテストが本当に症状を検出できるか分からない。

- **red は対象の不具合で失敗する**。import error、型エラー、fixture の不備で失敗しているだけの red は red ではない。失敗メッセージが症状を説明しているか確認する
- **green は同じ検証コマンドで確認する**。red を出したコマンドをそのまま再実行する。別の条件で通しても証明にならない
- **期待値は実装から逆算しない**。実装と同じ手順で期待値を計算する test は、実装が間違っていても通る（恒真）。既知のリテラル・手計算した値・仕様を使う
- **1 cycle 1 slice**。1 つの境界に 1 つの test を書き、それを通す最小の実装を書く。テストを全部先に書いてから実装をまとめて書かない
- **refactor は loop の外**。red → green の中で構造を変えない

正しい seam（テストを置ける境界）が無い場合は、無理に作らず理由を報告する。原因調査そのものは `diagnosing-bugs` skill の領域で、この skill は signal を作る手段としての test を担当する。

例と mock の境界は [`references/tdd-loop.md`](./references/tdd-loop.md) を読む（必要時のみ）。

## Assert 対象の規約（正本）

**対象操作後にだけ生じるユーザー可視の結果または永続状態を assert する。** 操作前から存在する要素、generic な alert / class、または発火していない mock を確認しただけで test が成功すると、本番では対象操作が失敗しても回帰を検出できない（failure scenario）。

- network mock は login / render / cache warm より前に登録し、必要なら request の発生と最終 UI の両方を確認する
- **例外**: pure function の unit test など、入力と直接の返り値だけで契約を完全に証明できる場合はこの限りでない

`AGENTS.md` の TEST-1 はレビュー時の要約で、条件と例外の詳細はこの節を正本とする。

## skip 条件つき test

`skipIf` の test は条件を満たさない実行で skipped のまま緑になる。passed と skipped を読み分け、両状態で 1 回ずつ走らせる。詳細は [testing.md](../../../docs/engineering/testing.md) §緑が証拠にならない形。

## チェックリスト

テスト作成時：

- [ ] 正常系をカバーしたか
- [ ] エラー系をカバーしたか
- [ ] テストが独立しているか（他のテストに依存しない）

テスト実行時：

- [ ] `pnpm test` が通るか
- [ ] 新しいテストが既存テストを壊していないか

## 関連スキル

- `/diagnosing-bugs` - 原因調査（再現 signal の設計、仮説の潰し方）
- `/error-handling` - エラー処理のテスト
- `/storybook` - UIコンポーネントのビジュアルテスト
