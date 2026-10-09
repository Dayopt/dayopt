# docs Frontmatter テンプレート

## テンプレート

```yaml
---
title: 'ページタイトル'
description: 'ページの説明（SEO用 + AI要約として流用。1-2文で簡潔に）'
tags: ['feature-name', 'tutorial', 'getting-started']
author: 'Dayopt Team'
publishedAt: '2026-02-19'
updatedAt: '2026-02-19'
order: 1 # サイドバー表示順序（昇順）
featured: false # 注目コンテンツ
draft: true # 下書き（レビュー後に false に変更して公開）
category: 'features' # getting-started / features / guides / troubleshooting / account
slug: 'features/plans' # URLパスに対応

ai:
  relatedQuestions: # 手動で書く（3-5個）
    - 'この機能の使い方は？'
    - '設定方法を教えて'
    - 'よくある問題は？'
  prerequisites: # 前提知識（任意）
    - 'Dayoptアカウントを作成済み'
  relatedDocs: # 関連ドキュメント（任意）
    - '/docs'
    - '/docs/plan/calendar'
  chunkStrategy: 'h2'
  searchable: true
  difficulty: 'beginner' # beginner / intermediate / advanced
  contentType: 'tutorial' # tutorial / reference / guide / troubleshooting / concept
---
```

## フィールド定義

| フィールド    | 型       | 必須 | 説明                                       |
| ------------- | -------- | ---- | ------------------------------------------ |
| `title`       | string   | ✅   | ページタイトル                             |
| `description` | string   | ✅   | 説明文（SEO + AI要約）                     |
| `tags`        | string[] | ❌   | Web UI フィルタリング + RAG + SEO（3-6個） |
| `author`      | string   | ❌   | 著者名（通常 `"Dayopt Team"`）             |
| `publishedAt` | string   | ❌   | 公開日（ISO 8601: `YYYY-MM-DD`）           |
| `updatedAt`   | string   | ❌   | 更新日（ISO 8601）                         |
| `order`       | number   | ❌   | サイドバー表示順序（昇順）                 |
| `featured`    | boolean  | ❌   | 注目コンテンツか（デフォルト: `false`）    |
| `draft`       | boolean  | ❌   | 下書き（`true` で非公開）                  |
| `category`    | string   | ✅   | カテゴリ（ディレクトリに対応）             |
| `slug`        | string   | ✅   | URLスラッグ（ファイルパスに対応）          |
| `ai`          | object   | ❌   | AI/RAGメタデータ                           |
