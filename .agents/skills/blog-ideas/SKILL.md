---
name: blog-ideas
description: ブログ記事のネタ提案と GitHub Issue 起票の明示依頼時に発動。docs/business/content/voice.md の3本柱と最近の開発・意思決定ログからネタを3-5個提案し、承認後に area:blog ラベルで起票する。記事本文のドラフト作成では発動しない。
user_invocable: true
---

# ブログネタ提案スキル

ブログ記事のネタを marketing 戦略 + monorepo の最新状態から提案し、承認後に GitHub Issue として起票する。

## When to Use

**明示発動型** — explicit なネタ出し依頼（`/blog-ideas`、「ブログのネタを出して」）のみを契機とする。

- `/blog-ideas` で手動実行する時
- リリース後にブログ候補を洗い出したい時（`docs/business/content/content-operations.md` のリリース駆動フロー）
- 月次ガーデニングでコンテンツバックログを補充する時
- ネタの重複確認だけを依頼された時

## When NOT to Use

この skill は **explicit なネタ出し依頼のみを契機とする**。参考として近接するが発動しないケース:

- 記事本文の執筆・ドラフト作成 → `docs-writing` skill
- 公開 docs のギャップ検出 → `docs-audit` skill
- issue の worker への dispatch 準備 → `dispatch` skill

## 実行手順

### Step 1: ソース収集

以下のソースを並行で読み込む:

1. **コンテンツ原則**: `docs/business/content/voice.md`（3本柱・6原則の正本）と `docs/business/growth.md`
2. **文章基準**: `docs/business/content/writing-style.md`（提案タイトルもこの基準で書く）
3. **意思決定ログ**: `docs/decisions.md` の最新 5 件程度
4. **開発の動き**: `git log --oneline -30` と直近の `docs/decisions.md` の行）
5. **既存ブログ記事**: `apps/web/content/blog/ja/*.mdx` のタイトル一覧（重複チェック用）
6. **既存 Issue**: `gh issue list --label "area:blog" --state all --limit 50`（重複チェック用）

### Step 2: ネタ提案

`docs/business/content/voice.md` の **3本柱** に基づいてネタを 3-5 個提案する。プロダクトに係る内容のみ。一般論は書かない。

| 柱                           | 内容                                           | 内包する原則                          |
| ---------------------------- | ---------------------------------------------- | ------------------------------------- |
| **課題起点の開発ストーリー** | 読者の課題 → なぜこう作ったか → 過程と結果     | 1(読者優先), 3(プロセス), 2(生々しさ) |
| **迷いと判断の記録**         | 選択肢A vs B、撤回した判断、失敗から学んだこと | 6(誠実), 2(生々しさ), 3(プロセス)     |
| **問いかけと連載**           | 読者への問い、同テーマの深掘り、過去記事の更新 | 4(参加促進), 5(蓄積), 1(読者優先)     |

提案フォーマット:

```
### ネタ1: [タイトル案]

**柱**: 課題起点の開発ストーリー
**カテゴリ**: guide / philosophy / devlog のいずれか
**概要**: [2-3文の説明]
**参照元**: [どのソースから着想したか]
```

重複チェック: 既存ブログ記事・既存 `area:blog` Issue と被るネタは提案から除外し、別のネタに差し替える。

### Step 3: ユーザー選択

候補を番号付きで並べ、複数選択できる形で採用するネタを選んでもらう（runtime に選択 UI があればそれを使う。Claude Code なら AskUserQuestion の **multiSelect: true**）。

### Step 4: GitHub Issue 起票

承認されたネタを `gh issue create` で起票する（monorepo ルートで実行。`cd` 不要）。

```bash
gh issue create \
  --title "[タイトル案]" \
  --label "area:blog" \
  --body "$(cat <<'EOF'
## 概要

[2-3文の説明]

## 想定読者

[この記事が刺さる人]

## 記事の柱

[3本柱のどれか] / カテゴリ: [guide / philosophy / devlog]

## 参照ソース

- [着想元のファイルやログ]

---
🤖 Generated with `/blog-ideas` skill
EOF
)"
```

## やらないこと

- 記事本文のドラフト作成（`docs-writing` skill の責務）
- AI 大量生成スパム的なネタ出し（`docs/business/growth.md` で禁止）
- Wikipedia 的な一般情報のまとめネタ（`docs/business/content/voice.md` の原則違反）
- 過度な宣伝ネタ（同上）
