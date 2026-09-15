# architecture/ — LikeC4 model（生成物）

`model.c4` / `views.c4` は `pnpm architecture:generate` が Architecture Inventory（実装から自動発見）と用語集（`scripts/lib/glossary/terms.ts`）、Feature DAG（`apps/product/eslint.config.mjs` + 実 import）、System Surface（HTTP route / 定期実行）から生成する。**手で編集しない**。drift は `pnpm architecture:check` が止める。

LikeC4 に手書きの事実は置かない。要素・関係・metadata・source への link はすべて生成で、人間が足すのは（必要になったら）追加の view だけ。追加する時は `views-*.c4` を別ファイルに置く。

同じ内容を Markdown で読むなら [`../architecture-inventory.md`](../architecture-inventory.md)（概念 ↔ 実装）と [`../system-surface.md`](../system-surface.md)（外部との接点・権限・関係）を見る。

## 見る

```bash
pnpm dlx likec4 start docs/engineering/data/architecture
```

ブラウザで interactive な explorer が開く。要素を選ぶと関係が highlight され、`link` から source へ飛べる。view は `index`（概念と feature）/ `features`（Feature DAG）/ `data`（テーブルと FK）/ `mcp` / `api`（HTTP route と定期実行）/ `unmapped`（どの概念からも辿れない要素）/ 概念ごとの `concept_*`。

静的 HTML 1 枚に出す:

```bash
pnpm dlx likec4 build docs/engineering/data/architecture --output-single-file -o .generated/architecture-map
```

## 検証

```bash
pnpm dlx likec4 validate docs/engineering/data/architecture
```

構文と layout drift を検査する。`likec4` は devDependency に入れていない（`pnpm dlx` で都度実行。採用判断は #2775）。
