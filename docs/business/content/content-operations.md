---
status: current
last_verified: 2026-08-09
---

# コンテンツ運用（正本）

プロダクト更新 → Storybook / 公開 docs 更新 → ブログという一連のコンテンツ運用の正本。決定の経緯は log/2026-07-23-content-operations.md（削除済み、git 履歴参照）。

## 3 面の役割分担

| 面                                  | 対象読者                                  | 責務                                                      | 公開                       |
| ----------------------------------- | ----------------------------------------- | --------------------------------------------------------- | -------------------------- |
| Storybook                           | 開発者・AI                                | 単一 component の使い方・variant・visual state            | 内部専用（デプロイしない） |
| 内部 docs（repo 直下 `docs/`）      | 創業者・開発者・AI                        | 仕様・設計・判断・運用の SSOT                             | 内部専用                   |
| 公開 content（`apps/web/content/`） | エンドユーザー・検索エンジン・AI クローラ | docs（usage）/ blog（context）/ リリースノート（changes） | dayopt.app                 |

Storybook は公開ヘルプ化しない。ヘルプページの役割は `apps/web/content/docs` が担う（同じ説明の二重管理を避ける。`docs/README.md` §情報面の責務）。

公開 content 内の 3 種類の役割分担は [docs/business/content/docs-policy.md](./docs-policy.md)、文章基準は [docs/business/content/writing-style.md](./writing-style.md) を正とする。

## リリースノートは blog の release カテゴリ

独立した `/releases` ページは持たない（2026-07-23 廃止）。リリースノートは `apps/web/content/blog/{en,ja}/vX-Y-Z.mdx` に `category: 'release'` の blog 記事として書き、`/blog/release` タブに表示する。書式は `.agents/skills/docs-writing/templates/blog-frontmatter.md`。

## 更新の連鎖（リリース駆動）

プロダクトの振る舞いが変わったら、この順で連鎖させる。

| タイミング     | 更新するもの                                                                                | 担当ルール                                                      |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 実装 PR        | Storybook story を同時更新                                                                  | `docs/engineering/storybook.md`                                 |
| 実装 PR        | `docs/product/specs/` の該当 spec を同じ変更で更新                                          | `CLAUDE.md` §Docs 運用責務                                      |
| リリース       | GitHub Release（毎リリース）                                                                | `releasing` skill                                               |
| milestone 締め | blog の `release` 記事（en/ja）を**書くか判断する**。公開ローンチ後に運用開始。義務化しない | `releasing` skill Phase 3.1 が判断を促す → `docs-writing` skill |
| リリース       | 公開 docs の該当ページ更新（`draft: true` → レビュー → 公開）                               | `docs-writing` skill                                            |
| リリース       | ブログネタを issue 起票**だけ**する                                                         | `blog-ideas` skill                                              |

ブログは起票までを自動リズムに入れ、執筆は切り離す。docs は網羅性が価値なので更新を義務化し、ブログは `docs/business/content/voice.md` の 3 本柱に合うものだけ選んで書く（義務化すると禁止している「AI 大量生成の没個性コンテンツ」になる）。

## 公開 docs の情報構造（タスクベース）

第 1 階層は**ユーザーがやりたいこと**で切る。画面名・機能名で切ると製品側の改名で陳腐化し、検索意図とも合わない。最大 3 階層（カテゴリー → ページ、または カテゴリー → グループ → ページ）で、第 3 階層は見出しではなく独立したページでよい。4 階層以上は `validate:content` が error で止める。

ディレクトリはナビ構造だけを決め、URL は決めない。routing の slug はファイル名由来なので、ページを移しても `/docs/<slug>` は変わらない。**例外は FAQ だけ**で、`/docs/faq/<slug>` に階層化してある（FAQ はタスクではなく形式なのでカテゴリー間を移動せず、フラット URL の利点が発生しない一方、`pricing` のような一般名を占有するコストだけ負っていたため）。経緯は FAQ の URL 階層化（削除済み、git 履歴参照）。ナビは実在の公開ページから自動生成されるため、draft のページは出ない。

内部 docs（`docs/product/specs/`）は機能ベースのまま。1 つの機能変更が複数のタスクページへ波及する分は、下記の `public_docs` による N:M 対応で吸収する。決定の経緯は タスクベース IA の決定（削除済み、git 履歴参照）。

## 機能 ⇄ 公開 docs ⇄ LP の対応（`pnpm docs:coverage`）

対応表の正本は `docs/product/specs/` の frontmatter とし、別ファイルの対応表を持たない。実装 PR ごとに spec を更新する既存の義務にそのまま乗る。

| フィールド    | 意味                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `public_docs` | この機能に対応する公開 docs の slug（= `/docs/<slug>`）。公開 docs 不要なら `[]`      |
| `lp`          | LP がこの機能について約束している文言。`apps/web/messages/en/marketing.json` から写す |

`pnpm docs:coverage` が spec を軸に実ファイルと LP を突き合わせ、次を Markdown で出力する。判断材料を出すだけのレポートで、exit code は常に 0。

- 各 slug の en / ja の状態（公開 / draft / placeholder / なし）
- LP が約束しているのに対応する spec が無いもの（内部 spec の欠落）
- spec が書いている LP 文言が現在の LP に無いもの（LP 改稿で取り残された記述）
- `public_docs` 未記入の spec、どの spec にも紐づかない公開 docs、en/ja の非対称

未執筆のページは `draft: true` + `placeholder: true` の骨格として置く。`placeholder: true` なのに `draft: false` のページは `validate:content` が error で止める。`draft` は「隠す」、`placeholder` は「中身がまだ無い」を表し、カバレッジ上で区別する。

**公開ページの本文から draft のページへリンクしない。** draft は `getAllContent` が除外するため 404 になる。`validate:content` が error で止める。リンクしたければ先に公開する。frontmatter の `ai.relatedDocs` はユーザーが踏まない RAG 用メタデータなので、draft を指していてもよい（公開時に解決する）。ファイルごと存在しない slug は本文・`relatedDocs` のどちらでも error。

## 言語ポリシー

| 種別                                       | ポリシー                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| docs                                       | **ja を正として先行**。本文が固まってから en を後追いで揃える（2026-07-24 変更、旧: 両方必須） |
| リリースノート（blog の release カテゴリ） | **en/ja 両方必須**                                                                             |
| blog（guide / philosophy / devlog）        | **主言語 1 つで書けば公開してよい**。翻訳は任意（AI 下訳 + レビューで後追い可）                |

blog まで両言語必須にすると solo 運用で執筆が止まる。書けることが最優先で、翻訳は価値が確認できた記事から追加する。docs も同じ理由で ja 先行にする。書きかけの ja を追いかけて en を訳すと、本文が動くたびに 2 倍の修正になる。en の抜けは `pnpm docs:coverage` が常に一覧するので、追いつく対象を見失うことはない。

## 公開 docs の監査

依頼時に `docs-audit` skill を実行し、機能 ↔ 公開 docs のギャップ・鮮度乖離・en/ja 非対称を Issue 化する。ギャップと非対称の一次情報は `pnpm docs:coverage` の出力を使い、目視の棚卸しから始めない。翌月のコンテンツバックログはここから補充する。Search Console / Vercel Analytics の数字（指名検索・docs/blog 流入・上位クエリ）は各ツールが時系列を持つので docs には転記しない。

## SEO 方針

- **docs = 機能リファレンス層。** 機能名・指名クエリを受ける。網羅・正確・更新が命。言語は上の[言語ポリシー](#言語ポリシー)に従う（ja 先行、en は後追い）
- **blog = 課題起点層。** 非指名クエリ（例: "time blocking vs todo list"）で新規読者を獲得し、本文の内部リンクで docs へ送る（topical cluster 構造）
- **AI クローラは全面許可**（2026-07-23 決定）。AI 検索・AI アシスタント経由の言及を獲得チャネルとして扱い、frontmatter の `ai.*` メタデータ（relatedQuestions / relatedDocs / chunkStrategy）を全コンテンツで整備する
- 数より質。`docs/business/growth.md` の禁止事項（煽らない・AI 大量生成を流さない）を上位とする
- サイト内検索は `minisearch` による全文検索（本文込み）。コンテンツが数百件に増えても耐える前提で組んである。日本語は分かち書きしないため、CJK は文字 bigram に分解するトークナイザを使う（`apps/web/src/features/search/lib/search-index.ts`）

## 関連

- 発信の思想・3 本柱: [voice.md](./voice.md)
- グロース全体: [growth.md](../growth.md)（グロース戦略）
- 執筆手順: `.agents/skills/docs-writing/SKILL.md`
- ネタ出し: `.agents/skills/blog-ideas/SKILL.md` / 監査: `.agents/skills/docs-audit/SKILL.md`
