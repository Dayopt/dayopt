---
name: react-performance
description: データ取得の waterfall を疑う時、RSC / service 層で独立した await が直列になっている時、重い component や第三者 package で初期表示が遅い時、性能 regression の原因を絞る時に発動。async → bundle の順に参照資料を読み、Dayopt の feature 境界・tRPC・ユーザー分離を保った性能判断を行う。文言のみ・型のみの変更では発動しない。
effort: medium
maxTurns: 15
---

# React / Next.js 性能判断（react-performance）

データ取得・描画・bundle の性能判断に使う参照資料への入口。**アプリ全体の設計規約ではない**。上流（Vercel Engineering）の規則を Dayopt の境界に合わせて抜粋した調整版で、公式原文そのままではない。

## When to Use

以下の状況で発動:

- RSC page / layout / service 層で、独立した `await` が直列に並んでいる実装を書く・レビューする時
- 重い component や第三者 package を新規に読み込む実装で、初期表示・cold start への影響を判断する時
- Suspense 境界・streaming の粒度を決める時
- 計測で初期表示・API 応答の regression が出て、原因の当たりをつける時
- レビューで「遅い」と指摘された経路の根拠を確認する時

## When NOT to Use

- UI 文言・型定義のみの変更（挙動が変わらず、実行経路に差が出ない）
- 体感差・計測の根拠がない微最適化（対象・条件を固定した計測が先）
- feature 間の import 構造の変更（AGENTS.md の依存方向に従う、`pnpm lint:boundaries` が正本）
- UI の操作性・アクセシビリティの監査（`ui-audit` skill の領域）

## 参照資料

必要なものだけ読む。両方読む必要はない。

| 資料                                             | 読む時                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| [`references/async.md`](./references/async.md)   | データ取得が直列に見える、Suspense 境界を決める、API が遅い   |
| [`references/bundle.md`](./references/bundle.md) | 重い component / package を足す、初期 JS を減らす、cold start |

上流には server / client / rerender / js 系の規則もあるが、Dayopt では取り込んでいない（下記の適用除外）。必要になったら `docs/operations/tooling.md` の固定 SHA から上流を読む。

## Dayopt の適用除外（上流をそのまま適用しない点）

- **feature 間の barrel を壊さない**。上流の `bundle-barrel-imports` は第三者 package の規則として読む。`features/*/index.ts` 経由の import は Dayopt の依存規則であり、性能を理由に deep import を解禁しない。`pnpm lint:boundaries` を緩める提案をしない
- **第三者 package は `optimizePackageImports`**（`apps/product/next.config.ts`）で扱う。未登録の重い package があればそこへ足す
- **SWR を足さない**。上流は `client-swr-dedup` で SWR を例示するが、Dayopt は tRPC + TanStack Query が正本。重複取得は既存の query key / `React.cache()` で解く
- **cache はユーザー・認可・リクエスト境界を確認する**。module スコープの LRU / Map cache は、キーにユーザーを含めない限りユーザー間でデータが混ざる（REVIEW-1）。性能を理由にユーザー分離を弱めない
- **memo は計測付きでのみ**。React Compiler は現在無効（`apps/product/next.config.ts` の `reactCompiler` はコメントアウト）。無条件の `memo` / `useMemo` 追加は提案しない
- **データ取得方式・RSC 化の一括置換はしない**。既存の tRPC / Zustand / `useCalendarData` の構造を保ったまま、局所の直列・重複を直す
- **上流の HIGH / CRITICAL を P1 / P2 に変換しない**。Dayopt の優先度は AGENTS.md §レビュー規則の failure scenario で決める

## 出力契約

- 対象の `file:line`、実際に直列化・重複している経路、ユーザーに出る影響（初期表示 / 操作の待ち）
- 最小の修正方針。既存の依存・state 管理で解けることを示す
- 性能改善を主張する場合は、同じ対象・同じ条件で測った前後の値を添える。測っていないなら「未計測」と書く
- 参照した規則名（例: `async-parallel`）を挙げる

## 関連スキル

- `ui-audit` - 操作性・アクセシビリティの監査
- `diagnosing-bugs` - 原因不明の regression の切り分け
- `trpc-router-creating` - service 層の構造
