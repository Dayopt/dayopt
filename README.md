# Dayopt

[![CI](https://github.com/Dayopt/dayopt/actions/workflows/ci.yml/badge.svg)](https://github.com/Dayopt/dayopt/actions/workflows/ci.yml)
[![Nightly](https://github.com/Dayopt/dayopt/actions/workflows/nightly.yml/badge.svg)](https://github.com/Dayopt/dayopt/actions/workflows/nightly.yml)

Dayoptは、予定（Plan）と記録（Record）を同じCalendarで扱う個人向けタイムボクシングプロダクト。このmonorepoにはproduct、marketing web、Storybook、共有package、Supabase資産を置く。

## Workspace

<!-- docs-live:workspace:start -->

正本は [pnpm-workspace.yaml](pnpm-workspace.yaml)。現在の一覧は `pnpm docs:read README.md` で生成して読む。

<!-- docs-live:workspace:end -->

各領域の責務は [アーキテクチャ](./docs/engineering/architecture.md)、Supabase 資産の運用は [インフラ](./docs/engineering/infra.md)、内部ドキュメントは [docs の地図](./docs/README.md) を参照する。

人間向けの閲覧は `pnpm docs:serve`、仕組みを辿る対話画面は `pnpm learn`。どちらも読込のたびに正本から表示を作る。AI / CLI は `pnpm docs:read <path>` を使う。

## Quick Start

```bash
pnpm install
cp .op-env.agent.example .op-env.agent
pnpm 1password:check
pnpm env:check
pnpm dev
```

`.op-env.agent`には実値ではなく`op://`参照だけを書く。詳細は[Secrets Management](./docs/operations/secrets.md)を参照する。AIは`pnpm dev`を実行しない。

## Commands

<!-- docs-live:commands:start -->

正本は [package.json](package.json)。現在の一覧は `pnpm docs:read README.md` で生成して読む。

<!-- docs-live:commands:end -->

個別commandの正本はroot [`package.json`](./package.json)。exact framework / library versionも各`package.json`とlockfileを参照する。

## Development Contract

- AI / contributorの入口: [`AGENTS.md`](./AGENTS.md)（provider 共通の正本。判断層・不変条件・レビュー規則・Skills 索引を持つ。[`CLAUDE.md`](./CLAUDE.md) はそれを import するだけのシム）
- 内部docsの地図: [`docs/README.md`](./docs/README.md)
- architecture: [`docs/engineering/architecture.md`](./docs/engineering/architecture.md)
- coding conventions: [`docs/engineering/conventions.md`](./docs/engineering/conventions.md)
- product behavior: [`docs/product/specs/`](./docs/product/specs/)
- component contract: `pnpm storybook`

変更に応じた検証と ready 化前の検査は `AGENTS.md` の検証・PR 運用規約に従う。

## Stack

Next.js App Router、React、TypeScript strict、Tailwind CSS、Zustand、TanStack Query、tRPC、Supabase、Zod、Sentry。major / patch versionを判断に使う場合はmanifestを確認する。

## License and Credits

依存ライセンスの正本は生成済みcreditsと`pnpm license:check`。第三者資産の帰属は[`docs/operations/legal.md`](./docs/operations/legal.md)を参照する。
