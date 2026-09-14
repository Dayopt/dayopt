# Dayopt

[![CI](https://github.com/Dayopt/dayopt/actions/workflows/ci.yml/badge.svg)](https://github.com/Dayopt/dayopt/actions/workflows/ci.yml)
[![Nightly](https://github.com/Dayopt/dayopt/actions/workflows/nightly.yml/badge.svg)](https://github.com/Dayopt/dayopt/actions/workflows/nightly.yml)

Dayoptは、予定（Plan）と記録（Record）を同じCalendarで扱う個人向けタイムボクシングプロダクト。このmonorepoにはproduct、marketing web、Storybook、共有package、Supabase資産を置く。

## Workspace

| Path             | 責務                                     |
| ---------------- | ---------------------------------------- |
| `apps/product`   | 認証後のDayopt本体とAPI                  |
| `apps/web`       | `dayopt.app` のmarketing・公開コンテンツ |
| `apps/storybook` | product componentのStorybook host        |
| `packages`       | app間で共有するdomain、UI、config等      |
| `supabase`       | PostgreSQL schema、migration、local seed |
| `docs`           | 内部仕様・設計・運用の正本               |

## Quick Start

```bash
pnpm install
cp .op-env.agent.example .op-env.agent
pnpm 1password:check
pnpm env:check
pnpm dev
```

`.op-env.agent`には実値ではなく`op://`参照だけを書く。詳細は[Secrets Management](./docs/operations/secrets.md)を参照する。AIは`pnpm dev`を実行しない。

## Main Commands

```bash
pnpm check              # typecheck / lint / static checks / unit tests
pnpm docs:check         # internal docs contract
pnpm build              # product build
pnpm build:web          # marketing web build
pnpm build-storybook    # Storybook build
pnpm test:integration   # local Supabaseを使うintegration test
pnpm test:e2e:smoke     # product + web smoke test
```

個別commandの正本はroot [`package.json`](./package.json)。exact framework / library versionも各`package.json`とlockfileを参照する。

## Development Contract

- AI / contributorの入口: [`AGENTS.md`](./AGENTS.md)（provider 共通の正本。判断層・不変条件・Codex レビュー規則・Skills 索引を持つ。[`CLAUDE.md`](./CLAUDE.md) はそれを import するだけのシム）
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
