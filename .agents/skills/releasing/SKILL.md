---
name: releasing
description: Dayopt の release 作業を end-to-end で実行する時に発動。明示的な release 意図（「v0.X.0 をリリース」「リリースしたい」「タグを切る」）を契機に、現在の git state（feature branch / main / tag 状態）を自動判定し、適切な Phase（version bump → 品質チェック → PR merge → tag → GitHub Release → リリースノート）から開始する。明示的な release 意図がない限り他のトリガーでは発動しない。
effort: medium
maxTurns: 25
---

# Releasing Skill

Dayoptプロジェクトのリリース作業を安全かつ確実に実行するためのスキルです。

## When to Use

**明示発動型** — この skill はユーザーの explicit な release 意図のみを契機に発動する（コード変化や他 skill からの handoff では発動しない）。

- 「v{n}.{n}.{n} をリリースしたい」「リリース作業を進める」等、明確な release 意図が発話された時
- tag 作成（`git tag v...`）や GitHub Release 作成を明示的に指示された時
- `package.json` の `version` フィールドを bump する作業を指示された時
- 既存タグに対応する GitHub Release / リリースノートを更新・作成する指示時

## When NOT to Use

この skill は **explicit release 意図のみを契機とする**。暗黙的な invocation ケースは該当なし（型の穴埋めとして明記）。参考として近接するが発動しないケース:

- 単なる `main` への merge（tag / release を伴わない）→ 通常の git 操作
- commit 作成のみで version bump を含まない時 → 通常の development flow
- Breaking change を含む変更が release 作業と分離されている時 → `docs-writing` skill で ADR / 技術ドキュメント更新を先行

## 状態自動判定

スキル起動時、まず現在の状態を判定して適切なフェーズから開始する：

```
ユーザー: 「v0.17.0リリースしたい」
│
├─ featureブランチにいる？（PRがオープン）
│  └─ Phase 0 から: version bump → 品質チェック → PRマージを促す → タグ → リリースノート
│
├─ mainにいてタグがまだ？
│  └─ Phase 1 から: promote 完了確認 → 観察 → タグ作成・push → リリースノート
│     （Production Release status が success になるまでタグを打たない）
│
├─ タグはあるがReleaseがまだ？
│  └─ Phase 2 から: GitHub Actions確認 → リリースノート
│
└─ タグもReleaseも既にある？
   └─ Phase 3 から: リリースノート上書きのみ
```

### 判定コマンド

```bash
# 1. 現在のブランチを確認
git branch --show-current

# 2. タグの存在確認
git tag -l "v${VERSION}"

# 3. GitHub Releaseの存在確認
gh release view v${VERSION} 2>/dev/null && echo "exists" || echo "not found"

# 4. package.json の現在バージョン
node -p "require('./package.json').version"
```

## リリースワークフロー

```
Phase 0: 準備（featureブランチにいる場合）
  ├── 0.1 バージョン番号決定・重複チェック ← 最重要
  ├── 0.2 package.json バージョン更新（このPRに含める）
  └── 0.3 コード品質確認（lint, typecheck, test, build）
  → ユーザーにPRマージを促す

Phase 1: Production公開の確認とタグ作成（mainブランチ）
  ├── 1.1 mainブランチ最新取得
  ├── 1.2 Production Release の promote 完了を待つ
  ├── 1.3 Production を観察する（主要route / Sentry）
  ├── 1.4 Gitタグ作成・プッシュ（promote成功の証跡）
  └── 1.5 GitHub Release作成の確認（auto-generated notes）

Phase 2: リリースノート反映
  ├── 2.1 前回リリース以降の全PRを取得
  ├── 2.2 詳細なリリースノートを作成
  └── 2.3 gh release edit で GitHub Release に反映

Phase 3: リリース後作業
  ├── 3.1 デプロイ確認
  └── 3.2 Sentry監視
```

## 必須チェック項目

### Phase 0.1: バージョン重複チェック（スキップ厳禁）

```bash
# 1. 既存リリースを確認
gh release list

# 2. 重複チェック
VERSION="0.X.0"  # リリースするバージョン
gh release view v${VERSION} 2>/dev/null && echo "❌ Already exists!" || echo "✅ OK"
```

**重複が見つかった場合**: 必ず「v0.X.0ではなくv0.Y.0じゃないですか？」と確認する

### Phase 0.2: package.json バージョン更新

```bash
# 現在のPRブランチでバージョンを更新
npm version ${VERSION} --no-git-tag-version
# → コミットに含める（タグ打ち前にmainのpackage.jsonが正しい状態になる）
```

**ポイント**: リリース前の最後のPRにversion bumpを含めることで、タグ打ち後の後片付けがゼロになる。

### Phase 0.3: コード品質

```bash
pnpm lint && pnpm typecheck && pnpm test:run && pnpm build
```

### Phase 1.1: mainブランチ最新取得

```bash
git checkout main
git pull origin main
```

### Phase 1.2: Production promote が完了していることを確認する

**promote は毎晩 03:00 JST に main HEAD で自動的に走る**（2026-10-09 以降。`promote.yml` の `schedule`）。
夜間 run の後に merge した commit を今日 release するなら `gh workflow run promote.yml --ref main` で出す。workflow は `impact →（影響のある層 3）→ release`
の 3 段で、層 3（E2E / Web Build & E2E）が green の時だけ promote する。

やることは「main HEAD が既に promote 済みか」の確認だけ:

```bash
git fetch origin main
gh api "repos/Dayopt/dayopt/commits/$(git rev-parse origin/main)/status" \
  --jq '.statuses[] | select(.context == "Production Release") | "\(.state) \(.description)"'
```

- `success` → Phase 1.3 へ進む。`unaffected`（どの app にも影響しない merge）も success で、
  production の artifact はその commit と等価なので tag を打ってよい
- `failure` → **tag を打たない**。run を開いて止まった段まで特定する
  （`gh run list --workflow=promote.yml --branch main --limit 5`）。層 3 の赤なら
  promote は走っておらず production は無傷。復旧は `docs/operations/runbook.md` Playbook 2
- **status が 1 件も無い** → その commit の run を見る
  （`gh run list --workflow=promote.yml --branch main --limit 5`）。走行中なら待つ。
  **run の release job が `skipped` で終わっている場合は、待っても status は来ない**
  —— 層 3 が赤い、または後続 run に層 3 を cancel された run。その commit を
  release 対象にするのは諦め、**main HEAD を対象にする**（次の夜間 run か dispatch が
  live 基準で拾い直すので、その後 HEAD には status が付く）

#### promote をやり直したい / 緊急で通したい時（break-glass）

自動経路が壊れている、または層 3 の赤を承知で通す必要がある場合だけ手動 dispatch する。
**production への操作なので `EXPLICIT AUTHORITY`（ユーザー明示指示）が必要。**

```bash
# 層 3 を再実行して promote をやり直す（force なし。main HEAD が対象）
gh workflow run promote.yml --ref main

# 層 3・smoke・Production Config Audit をすべて skip する break-glass
gh workflow run promote.yml --ref main -f force=true -f reason='<なぜ gate を飛ばすか>'
```

`sha` input は廃止した（2026-09-03）。対象は常にその run の commit で、**古い SHA を本番へ戻すのは
promote ではなく rollback**。Vercel の `Instant Rollback` を使う（runbook Playbook 2）。

`gh workflow run` は run が Actions 側へ登録される前に返るため、直後の `gh run list --limit 1` は
**まだ存在しない新 run ではなく前の run を返しうる**。`--event=workflow_dispatch` で絞り、
dispatch 前の最新 run id より大きいことを確認してから watch する。

### Phase 1.3: Production を観察する

promote 直後に主要 route と監視を確認する。異常があればタグを打たず、runbook の rollback 手順へ移る。

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dayopt.app/
curl -s -o /dev/null -w "%{http_code}\n" https://app.dayopt.app/api/health
```

Sentry の新規 issue と Vercel の runtime log も確認する。

### Phase 1.4: Gitタグ作成・プッシュ

観察まで終わってからタグを打つ。タグは deploy trigger ではなく、Production 公開が成功した証跡である。

```bash
git tag v${VERSION}
git push origin v${VERSION}
```

`create-release.yml` はタグ SHA の `Production Release` status が `success` であることを確認してから GitHub Release を作成する。未 promote の SHA にタグを打つと、この検証で止まる。

### Phase 1.5: Release 作成の確認

```bash
gh run list --workflow=create-release.yml --limit 1
gh release view v${VERSION}
```

### Phase 2: リリースノート反映（詳細化必須）

#### Step 1: PRとコミット情報を取得

```bash
# 前回リリース以降の全PRを取得
gh pr list --state merged --base main --limit 100 --json number,title,mergedAt

# 各PRのコミット詳細を取得（重要：PRタイトルだけでは不十分）
for pr in <PR番号リスト>; do
  echo "=== PR #$pr ==="
  gh pr view $pr --json title,body --jq '.title + "\n" + .body'
  echo "--- Commits ---"
  gh pr view $pr --json commits --jq '.commits[].messageHeadline'
done
```

#### Step 2: 詳細なリリースノートを作成

**粒度の基準**: 第三者が見ても「何が変わったか」がわかるレベル

**構造テンプレート**: `docs/operations/runbook.md` を参照

**❌ 悪い例（抽象的）**:

```markdown
- タグ機能リファクタリング
- パフォーマンス改善
```

**✅ 良い例（具体的）**:

```markdown
#### タグ機能の大幅強化 ([#910])

**データモデル変更**

- タグの親子階層モデルへ移行（`tag_groups` テーブル → `parent_id` カラム）
- 子タグの昇格処理を含むタグマージ機能

**UI/UX改善**

- タグ作成モーダルをポータルで実装（モーダル内でも正常動作）
- カレンダーサイドバーでのタグドラッグ&ドロップ並び替え
- 未タグ付けフィルターにアイコンと件数表示

**楽観的更新**

- タグ作成・編集・削除・マージ・並び替えに楽観的更新を実装
```

#### Step 3: 必須セクション

カテゴリは `docs/operations/runbook.md` 第4部「リリースノート執筆規約」の5分類に従う（Web版リリースノート `docs-writing` skill とも共通のタクソノミー。ここでは再定義しない）:

1. **新機能**: 機能名 + 具体的な実装内容。**Storybook-only（本番コードからの呼び出し元が無い）変更は「新機能」に書かない**（[#2442](https://github.com/Dayopt/dayopt/issues/2442)。実例: PR #2413 で誤記載しユーザーが本番で見つけられない実害が発生）。対象 component/関数を `rg` し、`*.stories.tsx` や自 feature 内以外からの呼び出しが無ければ Storybook-only と判定する。どうしても記載する場合は「Storybook 上のみ・本番未接続」と明記し、ユーザーには見えないことを分かる形にする
2. **改善**: 何がどう変わったか + 影響範囲（パフォーマンス最適化を含む）
3. **バグ修正**: 問題の原因 + 修正内容
4. **破壊的変更**: DB変更、削除されたAPI/コンポーネント
5. **セキュリティ**: セキュリティ関連の対応

#### Step 4: GitHub Release に反映

```bash
# 一時ファイルにリリースノートを書き出してから反映
gh release edit v${VERSION} --notes-file /tmp/release-notes-v${VERSION}.md
```

#### Step 5: Web 公開リリースノート

エンドユーザー向けの Web 版リリースノートは、`docs-writing` skill で `apps/web/content/blog/{en,ja}/` に `category: 'release'` の blog 記事として作成する（`/blog/release` タブに表示。独立した releases ページは持たない）。GitHub Release 本文と同じ5分類タクソノミーを使い、PR リンクを含めず平易な言葉で書く。

#### チェックリスト

- [ ] 各PRのコミットを確認した
- [ ] 抽象的な記述を具体化した
- [ ] データモデル変更を明記した
- [ ] 削除されたコンポーネント/機能をリストした
- [ ] Full Changelogリンクがある

### Phase 3: リリース後作業

```bash
# デプロイ確認
# Vercel Dashboard で本番環境の動作確認

# Sentryでエラー監視
# エラーが急増していないことを確認
```

#### Phase 3.1: milestone の締めと次の開設（minor リリース時のみ）

milestone は「次の minor version」を単位に常に 1 個だけ open にする運用（経緯は git 履歴参照）。minor リリースを出したらここで世代交代する。patch リリースでは何もしない。

```bash
# リリースした version の milestone を閉じる（open issue が残っていれば次へ移す）
gh api repos/Dayopt/dayopt/milestones --jq '.[] | select(.title=="vX.Y") | .number'
gh api -X PATCH repos/Dayopt/dayopt/milestones/<number> -f state=closed

# 次の minor の milestone を開く
gh api repos/Dayopt/dayopt/milestones -f title="vX.Y+1"
```

- 閉じる前に open のまま残った issue は、自動で外れないため**明示的に次の milestone へ移すか、milestone を外してバックログへ戻す**
- 閉じる時に「この束は外部共有（blog release 記事）に値するか」を一言添えてユーザーに判断を仰ぐ。義務ではなく判断ベース（`docs/business/content/content-operations.md` §更新の連鎖）

## よくある失敗

| 失敗                   | 対策                                           |
| ---------------------- | ---------------------------------------------- |
| バージョン重複         | Phase 0.1で必ず `gh release view`              |
| リリースノートが抽象的 | 各PRのコミットを取得して具体的な変更内容を記載 |
| 破壊的変更の記載漏れ   | DB変更、削除コンポーネントを明記               |
| 一部PRのみ記載         | `gh pr list --state merged` で全件取得         |
| Full Changelog抜け     | template.mdの構造を参考にする                  |
| version bump忘れ       | Phase 0.2でPRに含める（タグ前に完了）          |

## スクリプト

### バージョン重複チェック

```bash
.agents/skills/releasing/scripts/check-version.sh 0.X.0
```

### マージ済みPR取得

```bash
.agents/skills/releasing/scripts/get-merged-prs.sh
```

## 詳細ドキュメント

完全なチェックリスト: `docs/operations/runbook.md`
