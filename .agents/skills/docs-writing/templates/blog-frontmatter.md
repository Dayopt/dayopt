# blog Frontmatter テンプレート

## テンプレート

```yaml
---
title: 'How to Master Timeboxing with Dayopt'
description: "Learn practical timeboxing techniques using Dayopt's planning and tracking features."
publishedAt: '2026-02-19'
updatedAt: '2026-02-19'
tags: ['timeboxing', 'productivity', 'plans', 'tips']
category: 'Product' # Product / Technology / Tips / Update
author: 'Dayopt Team'
authorAvatar: '/avatars/dayopt-team.jpg'
coverImage: '' # 空なら /api/og が OGP 画像を生成する
featured: false
draft: true # レビュー後に false に変更して公開

ai:
  relatedQuestions:
    - 'How do I use timeboxing effectively?'
    - 'What are some productivity tips?'
  chunkStrategy: 'h2'
  searchable: true
  difficulty: 'beginner'
  contentType: 'guide'
---
```

## フィールド定義

| フィールド     | 型       | 必須 | 説明                                           |
| -------------- | -------- | ---- | ---------------------------------------------- |
| `title`        | string   | ✅   | 記事タイトル                                   |
| `description`  | string   | ✅   | 説明文（SEO + AI要約）                         |
| `publishedAt`  | string   | ✅   | 公開日（ISO 8601）                             |
| `updatedAt`    | string   | ❌   | 更新日                                         |
| `tags`         | string[] | ✅   | タグ（3-6個）                                  |
| `category`     | string   | ✅   | カテゴリ                                       |
| `author`       | string   | ✅   | 著者名                                         |
| `authorAvatar` | string   | ❌   | アバター画像パス                               |
| `coverImage`   | string   | ❌   | カバー画像パス。通常は空（`/api/og` が生成）   |
| `featured`     | boolean  | ❌   | トップページ表示（デフォルト: `false`）        |
| `draft`        | boolean  | ❌   | 下書き（デフォルト: `false`、`true` で非公開） |
| `ai`           | object   | ❌   | AI/RAGメタデータ                               |

## リリースノート記事（blog の `category: 'release'`）

リリースノートは独立した content 種別ではなく、blog 記事として書く。ファイルは `apps/web/content/blog/{en,ja}/v0-16-0.mdx` のようにバージョンをケバブケース化した名前にする。frontmatter は blog スキーマそのままで、以下を固定する。

```yaml
---
title: 'v0.16.0 — Bulk Operations'
description: 'Added support for bulk edit/delete operations for plans and records.'
publishedAt: '2026-02-19'
tags: ['new-features', 'improvements']
category: 'release'
author: 'Dayopt Team'
authorAvatar: '/avatars/dayopt-team.jpg'
featured: false
draft: false

ai:
  relatedQuestions:
    - "What's new in v0.16.0?"
  chunkStrategy: 'h2'
  searchable: true
  difficulty: 'beginner'
  contentType: 'reference'
---
```

- `title` は `vX.Y.Z — 内容の要約` 形式（バージョン番号を先頭に含める）
- `publishedAt` はリリース日（ISO 8601）
- `category` は必ず `'release'`（`/blog/release` タブに表示される条件）
- `ai.relatedDocs` で該当する docs ページへリンクする

### リリースノート専用タグ

タグは `new-features` / `improvements` / `bug-fixes` / `breaking-changes` / `security-updates` の5種類のみを使う。この5分類は GitHub Release 本文とも共通のカテゴリ定義であり、`docs/operations/runbook.md` 第4部「リリースノート執筆規約」を正とする（ここでは再定義しない）。`category: 'release'` 記事に限り、タグは該当する分だけ付ける（1-2個でも可。通常 blog の3個下限は適用されない。`apps/web/scripts/validate-content.js` 参照）。

### リリースノートの本文構造

見出しは上記5タグと1対1対応させる（該当カテゴリがなければ見出しごと省略）。カテゴリの意味は `docs/operations/runbook.md` 第4部と共通だが、GitHub Release本文とは異なりPRリンクを含めず、エンドユーザー向けに平易な言葉で書く（`references/style-guide.md` 参照）。

```mdx
# v0.16.0 - Bulk Operations

## New Features

- **Bulk Operations**: Select and edit/delete multiple plans at once

## Improvements

- Improved drag & drop performance on mobile
- Tag selector now supports keyboard navigation

## Bug Fixes

- Fixed time overlap validation not clearing on time change
- Fixed inspector close button delay

## Breaking Changes

（該当がある場合のみ）

## Security Updates

（該当がある場合のみ）
```
