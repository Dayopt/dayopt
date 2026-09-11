# @dayopt/web

`dayopt.app`のmarketing site、blog、公開docs、release notesを配信するNext.js app。monorepo全体の規約や環境運用は複製せず、root docsを正とする。

## Responsibilities

- marketing landing page
- blog / public docs / release noteのMDX表示
- site search index
- contact form、Turnstile、rate limit
- SEO metadataとlocale routing

## Commands

rootから実行する。

```bash
pnpm dev:web
pnpm build:web
pnpm lint:web
pnpm typecheck:web
pnpm test:web
pnpm --filter @dayopt/web test:e2e:smoke
pnpm --filter @dayopt/web validate:content
```

exact commandとdependency versionは[`package.json`](./package.json)を参照する。

## Local Environment

repo rootの`.op-env.agent`に`op://`参照だけを置き、通常はroot commandから起動する。実値を`apps/web/.env.local`へ保存しない。

- secret運用: [`docs/operations/secrets.md`](../../docs/operations/secrets.md)
- environment / deployment: [`docs/engineering/infra.md`](../../docs/engineering/infra.md)
- web env schema: [`src/platform/config/env.ts`](./src/platform/config/env.ts)

## Content

| Path               | 内容                 |
| ------------------ | -------------------- |
| `content/blog`     | blog記事             |
| `content/docs`     | 外部ユーザー向けdocs |
| `content/releases` | 公開release notes    |
| `messages/{en,ja}` | web用copy            |

公開コンテンツの執筆規約は`.agents/skills/docs-writing/SKILL.md`を使う（`.claude/skills` は互換 symlink で正本ではない）。内部設計・開発規約はroot [`docs/README.md`](../../docs/README.md)へ置き、このapp配下に二重管理しない。

## Verification

webだけの変更では、変更内容に応じて次を実行する。

```bash
pnpm lint:web
pnpm typecheck:web
pnpm test:web
pnpm build:web
```

monorepo横断変更ではroot `pnpm check`も通す。
