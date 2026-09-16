# architecture/ — LikeC4 model（生成物）

`model.c4` / `views.c4` は `pnpm architecture:generate` が Architecture Inventory（実装から自動発見）と用語集（`scripts/lib/glossary/terms.ts`）、Feature DAG（`apps/product/eslint.config.mjs` + 実 import）、System Surface（HTTP route / 定期実行）から生成する。**手で編集しない**。drift は `pnpm architecture:check` が止める。

LikeC4 に手書きの事実は置かない。要素・関係・metadata・source への link はすべて生成で、人間が足すのは（必要になったら）追加の view だけ。追加する時は `views-*.c4` を別ファイルに置く。

同じ内容を Markdown で読むなら [`../architecture-inventory.md`](../architecture-inventory.md)（概念 ↔ 実装）と [`../system-surface.md`](../system-surface.md)（外部との接点・権限・関係）を見る。

## 見る

```bash
pnpm dlx likec4 start docs/engineering/data/architecture
```

ブラウザで interactive な explorer が開く。要素を選ぶと関係が highlight され、`link` から source へ飛べる。view は `index`（概念と feature）/ `features`（Feature DAG）/ `data`（テーブルと FK）/ `mcp` / `api`（HTTP route と定期実行）/ `unmapped`（概念を足す候補。語彙を持たない層は除く）/ 概念ごとの `concept_*`。

静的 HTML 1 枚に出す:

```bash
pnpm dlx likec4 build docs/engineering/data/architecture --output-single-file -o .generated/architecture-map
```

## 検証

```bash
pnpm dlx likec4@1.59.3 validate docs/engineering/data/architecture
```

構文と layout drift を検査する。

`likec4` は **devDependency に入れていない**。unpacked 11.6MB に加えて `playwright 1.60.0`（repo は `^1.63.0` なので二重になる）と vite 8 が全開発者の install へ入るのに対し、守りたいのは「生成器を壊した時に無効な DSL を黙って吐く」だけだから（#2775 の判断 2）。

代わりに `pnpm docs:check` の `likec4-validate` が、`scripts/lib/architecture-map/` か このディレクトリが変わった PR でだけ同じコマンドを走らせる。**advisory** で、失敗しても merge は止めず GitHub Actions の annotation として出す。version は `scripts/tasks/docs-guard/checks/likec4-validate.ts` の `LIKEC4_VERSION` が正本で、上のコマンドと揃える。
