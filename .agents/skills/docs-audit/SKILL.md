---
name: docs-audit
description: 公開 docs（apps/web/content/docs）の監査の明示依頼時と月次ガーデニングの公開コンテンツ監査で発動。プロダクトの実機能と公開 docs を突き合わせ、未カバー機能・鮮度乖離・en/ja 非対称を検出して報告し、承認後に area:docs ラベルで起票する。docs 本文の生成や内部 docs/ の監査では発動しない。
user_invocable: true
---

# 公開 docs 監査スキル

プロダクトの実機能とユーザー向け公開 docs（`apps/web/content/docs/`）を突き合わせ、不足・陳腐化を検出して報告する。本文は生成しない。

## When to Use

**明示発動型** — explicit な監査依頼のみを契機とする。

- `/docs-audit` で手動実行する時
- 月次ガーデニング（`/gardening`）の公開コンテンツ監査ステップから呼ばれる時
- リリース後に docs 更新漏れを確認したい時
- en/ja の翻訳対称性だけを確認したい時

## When NOT to Use

この skill は **explicit な監査依頼のみを契機とする**。参考として近接するが発動しないケース:

- 検出したギャップの docs 本文執筆 → `docs-writing` skill
- 内部ドキュメント（repo 直下 `docs/`）の鮮度チェック → `/gardening` の Step 2
- ブログのネタ出し → `blog-ideas` skill

## 実行手順

### Step 1: 情報収集

**まず `pnpm docs:coverage` を実行する。** 機能 ⇄ 公開 docs ⇄ LP の対応表が出力され、A（未カバー）と C（en/ja 非対称）の一次情報になる。目視の棚卸しから始めない。

その上で以下を並行で読み込む:

1. **プロダクトの機能一覧**: `ls apps/product/src/features/` と `apps/product/src/app/` のルート構造
2. **最近の変更**: `git log --oneline -30 -- apps/product/`
3. **既存 docs 一覧**: `apps/web/content/docs/{en,ja}/**/*.mdx`（frontmatter + 冒頭を読む）
4. **既存 Issue**: `gh issue list --label "area:docs" --state all --limit 50`（重複チェック用）

### Step 2: ギャップ検出

#### A. 未カバーの機能

`docs:coverage` の出力で `なし` / `placeholder（未執筆）` の行を起点にする。加えて次の 2 つを見る。

- **`public_docs` 未記入の spec** — レジストリに載っていない機能。`public_docs` を書く（公開 docs 不要なら `[]`）こと自体が起票対象
- **LP が約束しているのに対応する spec が無いもの** — 公開 docs 以前に内部 spec が欠けている。docs より spec の作成が先

`apps/product/src/features/` 側にあってレジストリのどこにも現れない機能も洗い出す。判定基準は「ユーザーが操作する主要機能に対応する docs があるか」。内部専用 feature は対象外。

`docs:coverage` の「どの spec にも紐づかない公開docs」に出たページは、機能仕様が欠けているのか、そもそも spec を持たない汎用ページなのかを判定する。**faq / getting-started / troubleshooting のように特定機能ではなく製品全体・操作全般を扱うページは、frontmatter に `generic: true` を付けて意図的な spec 外と明示する**（`pnpm docs:coverage` の「意図的に spec 外の公開docs」節に分離される）。それ以外（特定機能を説明しているのに spec が無い）は spec 側 `public_docs` への登録漏れとして扱い、該当 spec に追記するか新規 spec を起票する。

#### B. 鮮度チェック

既存 docs が説明する機能の product 側コードが docs より後に大きく変わっていないか確認する。

```bash
git log --oneline -5 -- apps/product/src/features/<feature>/
git log --oneline -5 -- apps/web/content/docs/ja/<section>/<feature>.mdx  # section = getting-started / plan / track / review / organize / data / faq / troubleshooting
```

docs の最終更新と product 側の最終コミットを比較し、乖離が大きいものをフラグする。

#### C. en/ja 対称性

`docs:coverage` の「en / ja が揃っていない」節を使う。ファイルの有無だけでなく、片側だけ draft / placeholder のものも含まれる。`pnpm --filter @dayopt/web validate:content` の warning（公開ページから未公開ページへのリンク）も併せて見る。

### Step 3: 報告

```
## ギャップ検出結果

### 未カバーの機能（docs なし）
| 機能 | product 側パス | 優先度 | 理由 |
|---|---|---|---|

### 鮮度チェック（更新が必要な可能性）
| docs ファイル | 最終更新 | product 側最終変更 | 乖離 |
|---|---|---|---|

### en/ja 翻訳の不足
| 存在する側 | 欠けている側 |
|---|---|
```

### Step 4: ユーザー選択

候補を番号付きで並べ、複数選択できる形で対応するものを選んでもらう（runtime に選択 UI があればそれを使う。Claude Code なら AskUserQuestion の **multiSelect: true**）。

### Step 5: GitHub Issue 起票

承認されたものを `gh issue create` で起票する（monorepo ルートで実行）。

```bash
gh issue create \
  --title "[docs] [機能名]: [新規作成 or 更新 or 翻訳追加]" \
  --label "area:docs" \
  --body "$(cat <<'EOF'
## 種別

新規作成 / 更新 / 翻訳追加

## 対象機能

[機能名]

## product 側の参照パス

- `apps/product/src/features/[該当feature]/`

## 現状の docs

[既存ファイルパスまたは「なし」]

## 検出理由

[ギャップ / 鮮度乖離 / 翻訳不足]

---
🤖 Generated with `/docs-audit` skill
EOF
)"
```

## docs の運用方針

- **薄く書く**: 各機能の概要 + 主要な使い方のみ（文章基準は `docs/business/content/writing-style.md`、役割分担は `docs/business/content/docs-policy.md`）
- **都度更新**: プロダクトの振る舞いを変えたら同じ流れで docs も更新する（`docs/business/content/content-operations.md`）
- **AI 更新**: 執筆は `docs-writing` skill が `draft: true` で行い、開発者レビュー後に公開する

## やらないこと

- docs の本文を自動生成する（検出と報告のみ。執筆は `docs-writing` skill）
- 全機能の docs を一気に書く（優先度の高いものから段階的に）
- 内部開発ドキュメント（repo 直下 `docs/`）の監査（`/gardening` Step 2 の領域）
