---
name: docs-writing
description: 新機能実装完了後のユーザー向けドキュメント（`apps/web/content/docs/**/*.mdx`）執筆時、リリース完了後のリリースノート（`apps/web/content/blog/{en,ja}/` の `category: 'release'` 記事）作成時、Breaking change を含む変更の merge 前の技術ドキュメント更新時、`docs-audit` skill からの docs gap フィードバック受領時に発動。AI 生成時は `draft: true` 初期値を適用する。意思決定ログの追記（`decision` skill の領域）やコード内コメント・一時メモでは発動しない。
effort: medium
maxTurns: 25
---

# ユーザー向けドキュメント執筆スキル

web側（`apps/web/content/`）へのユーザー向けコンテンツを執筆するスキル。
app側の技術ドキュメント（`docs/`）とは別物。

## 執筆前の読取と更新

既存文書と関連する仕様を `pnpm --silent docs:read <repo-relative-path>` で読み、[文書の標準手順](../../../docs/README.md#ai-の標準手順)に従う。コード・manifest から作れる現状の一覧は正本や生成器を更新し、生成された表・件数を手書きで複製しない。判断理由・利用手順は意味を持つ正本として執筆する。

新しい live 生成対象は `LIVE_DOCUMENT_VIEWS` に登録し、保存本文を `storedLiveBlock(path, view)` の正本リンクに合わせる。既存生成器で出せない一覧は、生成器と検査を同じ変更に追加する。登録済みの節では marker の外にも手書きの一覧を置かない。

変更後は対象文書を同じコマンドで読み直し、`pnpm docs:check` を通す。公開 MDX は加えて既存の content 検証と公開 renderer で表示を確認する。内部 viewer の成功だけで公開画面の確認済みとは扱わない。

## When to Use

**副次トリガー型** — この skill は「コード変化」ではなく「上位イベント確定後のドキュメント化タイミング」で発動する。

**上位イベント起点（何が確定したか）:**

- 新機能の public API 仕様が確定し、ユーザー向け使い方ドキュメントが必要になった時
- リリース作業完了後、`apps/web/content/blog/{en,ja}/` に `category: 'release'` のリリースノート記事を書く時
- Breaking change を含む変更を merge する前、影響を受ける技術ドキュメントの更新が必要な時

**診断起点（何に気付いたか）:**

- 機能実装は完了しているが対応するユーザードキュメントが未整備と気付いた時
- `docs-audit` skill から docs gap / 鮮度低下のフィードバックを受けた時

## When NOT to Use

- 意思決定ログの追記 → `decision` skill（`docs/decisions.md` へ 1 行追記。#2475 で domain log/ を廃止）
- コード内コメント（`AGENTS.md` のコメント・コード規約に従う、skill 層の範囲外）
- 一時メモ・個人メモ・ミーティングノート（公開されない情報）
- 自明な内容の重複記録（型定義・命名で自己説明できる内容）

---

## レビューワークフロー（AI生成コンテンツ）

AI が記事を作成する場合は必ず `draft: true` で作成し、開発者がレビュー後に公開する。

```
1. AI が draft: true で記事を作成（en/ja 両ファイル）
2. 開発者がレビュー（内容・フロントマター・リンク確認）
3. OK → draft: false に変更してコミット → 本番公開
4. NG → フィードバックして AI に修正依頼
```

**`draft: true` のファイルはビルドから除外され、本番に公開されない。**

**既に公開されている page の更新では draft を付けない**（付けると `getAllContent()` の draft フィルタと `dynamicParams = false` の組み合わせで当該 URL が本番 404 になる。#2118）。`draft: true` は新規 page の初期値であり、既存公開 page の編集には適用しない。

---

## 対象コンテンツ種別

| 種別         | ディレクトリ                                          | 用途                                                    |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| **docs**     | `apps/web/content/docs/**/*.mdx`                      | 機能ドキュメント（Getting Started, Features, Guides等） |
| **blog**     | `apps/web/content/blog/{en,ja}/*.mdx`                 | ブログ記事（機能紹介、Tips、開発裏話等）                |
| **releases** | blog と同じ。`category: 'release'` を付けた blog 記事 | リリースノート（`/blog/release` タブに表示）            |

リリースノートは独立ページを持たない。blog の `release` カテゴリ記事として書く（旧 `/releases` ページは廃止済み。経緯は git 履歴参照）。役割分担は `docs/business/content/docs-policy.md`、文章基準は `docs/business/content/writing-style.md` に従う。

---

## Frontmatterテンプレート

種別ごとのテンプレートとフィールド定義は以下を参照：

| 種別            | テンプレートファイル            |
| --------------- | ------------------------------- |
| docs            | `templates/docs-frontmatter.md` |
| blog / releases | `templates/blog-frontmatter.md` |

---

## 多言語対応

ロケールは **`en`（英語）** と **`ja`（日本語）** の2言語。

```
URL構造:
  英語: /docs/plan/plans      （デフォルト、プレフィックスなし）
  日本語: /ja/docs/plan/plans  （/ja/ プレフィックス）
```

**基本方針**（`docs/business/content/content-operations.md` §言語ポリシーが正本）:

- **docs / リリースノート（release カテゴリ）**: en/ja 両方必須
- **blog（guide / philosophy / devlog）**: 主言語 1 つで公開してよい。翻訳は任意で後追い可

日英両方を作る場合は直訳ではなく、それぞれの言語で自然な表現にする。

---

## ファイル配置ルール

```
apps/web/content/
├── docs/
│   ├── en/                    # 英語版（必須）
│   └── ja/                    # 日本語版（必須）
└── blog/
    ├── en/                    # リリースノート（category: 'release'）もここに置く
    └── ja/
```

### ファイル名規則

| 種別     | ファイル名                     | 例                                      |
| -------- | ------------------------------ | --------------------------------------- |
| docs     | ケバブケース                   | `plans.mdx`, `weekly-review.mdx`        |
| blog     | ケバブケースで内容を表す       | `timeboxing-tips.mdx`                   |
| releases | バージョン番号をケバブケース化 | `v0-16-0.mdx`（URL は `/blog/v0-16-0`） |

---

## navigation.ts の更新

新しいドキュメントページを追加した場合、`apps/web/src/shell/navigation.ts` の `generateDocsNavigation()` にもエントリを追加する。

---

## 文体・スタイル

詳細は `references/style-guide.md` を参照。要点：

- ユーザー視点、平易な表現、能動態、具体的に
- **「：」（全角コロン）をテキスト中で使わない**（AI臭い文体）
- description は体言止め（メタ的な宣言を避ける）

---

## 品質チェックリスト

### Frontmatter

- [ ] 必須フィールドがすべて記述されている
- [ ] 日付は ISO 8601 形式（`YYYY-MM-DD`）
- [ ] `tags` は空配列 `[]` にしない（blog は3-6個を目安、`category: 'release'` 記事は固定5分類から該当する分だけ・1-2個でも可）
- [ ] `ai.relatedQuestions` は 3-5個（手動で記述）
- [ ] `pnpm --filter @dayopt/web validate:content` でエラーがないことを確認した

### コンテンツ

- [ ] H1 は 1つのみ
- [ ] H2 で主要セクションを区切っている（RAGチャンク境界）
- [ ] コードブロックに言語指定がある
- [ ] 画像は原則使わない（blog の cover は空のままにし `/api/og` が生成する）。本文に足す時だけ `apps/web/public/images/` を作って置き（外部URL禁止）、`alt` 属性あり
- [ ] テンプレート文言（`[xxx]`等）が残っていない

### 多言語

- [ ] `en/` と `ja/` の両方にファイルを作成した
- [ ] 日英の内容が一致している（自然な表現で）
- [ ] 同一ファイル名で対応している

### ナビゲーション

- [ ] 新規ページの場合、`navigation.ts` にエントリを追加した

---

## 内部ドキュメント（app側 `docs/`）

app側の技術ドキュメント・APIドキュメントもこのスキルで対応する（判断の記録は `decision` skill）。

### ドキュメント種類の判断

```
何を記録したいか？
├─ 機能の仕組み → 技術ドキュメント（docs/engineering/）
├─ なぜこの方法を選んだか（意思決定） → docs/decisions.md へ 1 行追記（decision skill）
└─ APIの使い方 → APIドキュメント（docs/engineering/conventions-api.md）
```

### 内部ドキュメントのルール

1. **日本語で記述**（グローバル展開時は英語も検討）
2. **`docs/`ディレクトリに配置**
3. **過度に詳細にしない**（メンテナンスコストを考慮）
4. **コードが自明なら書かない**（型定義で十分な場合も多い）

---

## 詳細ドキュメント

| ドキュメント                    | 内容                              |
| ------------------------------- | --------------------------------- |
| `templates/docs-frontmatter.md` | docs用フロントマター定義          |
| `templates/blog-frontmatter.md` | blog/releases用フロントマター定義 |
| `references/style-guide.md`     | 執筆スタイルガイド・用語・MDX記法 |

## 参考ファイル

| ファイル                                     | 用途                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `apps/web/content/docs/ja/plan/calendar.mdx` | 模範例（Feature Doc）                                 |
| `apps/web/src/lib/content-schemas.ts`        | Frontmatterスキーマの正式定義（Zod）                  |
| `docs/operations/runbook.md` 第4部           | リリースノートのカテゴリ定義（GitHub Release と共通） |
