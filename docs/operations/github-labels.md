---
status: current
last_verified: 2026-09-11
code: .github/dependabot.yml
---

# GitHub ラベル運用（namespace:value）

## 最上位ルール

- ラベル名は `namespace:value`。
- ラベル自体の「名前」と「説明（Description）」を運用ルールの正本とし、色は参照用にのみ使う。
- ここは現行運用の参照先（SSOT）で、運用手順は `.github/` 配下の設定/ワークフローと整合させる。
- 未知のラベルを AI が推測して作成しない。
- `priority:` は 0/1 個、`status:` は 0/1 個を付与する（通常 1 個）。
- `size:` は **deprecated**（2026-08-10、#1912。編成時に issue 本文から毎回判定する方式へ移行）。新規 issue に付けない。既存 issue からは剥がさない。
- `risk:` は 0/1 個。
- `type:`、`area:`、`quality:` は複数可。
- 技術名、担当者名、Workflow名、Phase、実装ファイル種別をラベル化しない。
- namespace の無い裸のラベルを作らない。`ops` は 2026-08-11（#1915）に `area:operations` へ付け替えたうえで削除した。
- 新しいラベルが必要な場合は、既存 namespace（`type` / `priority` / `status` / `area` / `scope` / `quality` / `risk` / `db` / `review`）では表現できないことを確認したうえで判断する。

## 正規ラベル一覧

### type

- `type:feature`
- `type:refactor`
- `type:docs`
- `type:test`
- `type:bug`
- `type:spike`
- `type:discussion`
- `type:chore`
- ~~`type:board`~~（**廃止済み。2026-09-01、[#2525](https://github.com/Dayopt/dayopt/issues/2525)**。日次盤面 issue の運用ごと廃止した。ラベル自体は過去 issue の履歴として残すが、新規 issue には付けない）

### priority

- `priority:p0`
- `priority:p1`
- `priority:p2`
- `priority:p3`

### status

- `status:ready`
- `status:in-progress`
- `status:review`
- `status:blocked`
- `status:watching`

### area

- `area:frontend`
- `area:backend`
- `area:database`
- `area:ui`
- `area:search`
- `area:settings`
- `area:calendar`
- `area:auth`
- `area:inbox`
- `area:tag`
- `area:infrastructure`
- `area:operations`
- `area:analytics`
- `area:billing`
- `area:deployment`
- `area:tooling`
- `area:github`
- `area:blog`
- `area:docs`

### size（deprecated）

新規 issue に付けない（最上位ルール参照）。既存 issue の記録として残る:

- `size:xs`
- `size:s`
- `size:m`
- `size:l`
- `size:xl`

### scope

- `scope:epic`

### risk

- `risk:authority` — issue の実行自体に `EXPLICIT AUTHORITY` の不可逆操作を含む場合のみ付与。運用は `.agents/skills/dispatch/SKILL.md` 操作 B

### review

- `review:full` — **Issue / PR 共通の「User 自身が重く見て目を通す」印**（2026-09-04、[#2596](https://github.com/Dayopt/dayopt/issues/2596) で機械 gate から情報ラベルへ格下げ。旧: Issue / PR 共通の高リスクシグナルとして必須レビューを機械判定していた [#2529](https://github.com/Dayopt/dayopt/issues/2529) / [#2530](https://github.com/Dayopt/dayopt/issues/2530) は撤回）。手で付ける明示的なエスカレーションで、AI が自動付与する仕組みは作らない
  - **PR に付いている場合**: `pr-cross-review` skill による advisory レビューをより丁寧に行う目安になる（merge を止める機械 gate ではない）。判定材料として `scripts/ci/protected-path-gate.mjs` の保護対象 path 判定と併せて使う
  - **Issue に付いている場合**: 実装着手前に User 自身が目を通すべき合図（機械 gate はない）
  - ラベルの有無は merge / 着手可否の機械判定に使わない

### quality

- `quality:security`
- `quality:performance`
- `quality:accessibility`
- `quality:monitoring`
- `quality:cost`

## Dependabot ラベル（推奨）

- npm 更新: `type:chore`
- GitHub Actions 更新: `type:chore` + `area:infrastructure`
