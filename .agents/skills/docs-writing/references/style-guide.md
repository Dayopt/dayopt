# 執筆スタイルガイド（skill 固有の補足）

文章の書き方そのもの（B1 基準・短文・具体語・AI 臭の排除・description の書き方）は **`docs/business/content/writing-style.md` が正本**。公開前チェックは `docs/business/content/review-checklist.md`、Docs / Blog / Release notes の役割分担は `docs/business/content/docs-policy.md` に従う。本ファイルには docs-writing skill 固有の補足（用語・タグ運用・配置）だけを残す。

## 言語

- 種別ごとの言語ポリシーは `docs/business/content/content-operations.md` §言語ポリシーが正本（docs / release 記事は en/ja 必須、blog は主言語のみで可）
- 両言語で書く場合、`en/` と `ja/` に分離配置し、直訳ではなく各言語で自然な表現にする

## Dayopt固有の用語

用語の正解は [`docs/product/glossary.md`](../../../../docs/product/glossary.md)（正本は `scripts/lib/glossary/terms.ts`）に従う。公開 docs も製品 UI と同じ呼称を使う — ここに第 2 の用語表は置かない。

公開 docs で特に間違えやすいもの:

- 時間ブロックの総称は **タイムブロック / Timeblock**（「ブロック」「箱」ではない）
- **予定 / Plan** と **記録 / Record**（「タスク」「実績」ではない）
- 分類は **アクティビティ / カテゴリー / セグメント**。**Tag 機能は #2162 で廃止済み**
- 「レビュー」ではなく **振り返り / Review**

公開 docs（`apps/web`）は `pnpm copy:check` のスキャン対象外なので、ここは人間 / AI のレビューで担保する。

## タグの役割（重要）

この節は **blog** の自由記述タグに関するもの。**releases** のタグは固定5分類（`docs/operations/runbook.md` 第4部参照）で、命名規則・個数の目安は別物。

`tags` は **3つの役割** を同時に担う:

1. **Web UI フィルタリング** — `/tags` ページ・`/tags/[tag]` ページで全コンテンツを横断検索
2. **RAG キーワード** — AIチャットボットの検索インデックス
3. **SEO** — メタデータとして検索エンジンに提供

### タグ命名規則（blog）

| ルール                   | 例                                                     |
| ------------------------ | ------------------------------------------------------ |
| 英語小文字のケバブケース | `time-tracking`, `getting-started`                     |
| 機能名はそのまま         | `calendar`, `plans`, `records`, `activities`, `report` |
| 日本語タグも可（検索用） | `トラブルシューティング`, `サインイン`                 |
| 3-6個を目安              | 少なすぎると検索にかからない、多すぎるとノイズ         |
| 空配列 `[]` は禁止       | タグ不要なら `tags` フィールド自体を省略               |

releases のタグは自由記述ではなく固定5分類からの選択なので、この「3-6個を目安」は適用しない。該当する分類だけを付ける（1-2個でも正当）。空配列 `[]` 禁止（省略ではなく該当分類を選ぶ）は releases にも共通。

## コンテンツ構造パターン

```mdx
# ページタイトル（H1は1つのみ）

導入文（1-2文で概要を説明）

## セクション1（H2 = RAGチャンク境界）

本文...

### サブセクション（H3）

詳細...

## 次のステップ

関連ページへのリンクリスト

---

**質問やフィードバック**がありましたら、[お問い合わせ](/contact)からお気軽にどうぞ。
```

## MDX記法ガイド

`remark-gfm` が有効。GFM記法がすべて使える。

### アラート / Callout

```mdx
<Alert type="info">補足情報です。</Alert>
<Alert type="warning">注意事項です。</Alert>
<Alert type="error">重要な警告です。</Alert>
<Alert type="success">成功メッセージです。</Alert>
```

### 注意点

- コードブロックには言語指定必須
- 画像は `/public/images/` 配下に配置（外部URL禁止）、`alt` 属性必須
- テーブルはGFM記法（ヘッダー行 + セパレータ行必須）
