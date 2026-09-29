---
status: current
last_verified: 2026-09-29
code: .github/dependabot.yml
---

# GitHub ラベル運用（namespace:value）

## 最上位ルール

- ラベル名は `namespace:value`。
- ラベル自体の「名前」と「説明（Description）」を運用ルールの正本とし、色は参照用にのみ使う。
- ここは現行運用の参照先（SSOT）で、運用手順は `.github/` 配下の設定/ワークフローと整合させる。
- 未知のラベルを AI が推測して作成しない。
- Issue の分類は Issue に付ける `type:*` / `priority:*` / `status:blocked` ラベルを使う。PR には分類ラベルを複製せず、リンク先 Issue の分類を正本にする。
- `size:` は **deprecated**（2026-08-10、#1912。編成時に issue 本文から毎回判定する方式へ移行）。新規 issue に付けない。既存 issue からは剥がさない。
- `type:` は 0/1 個、`priority:` は 0/1 個、`status:` は `status:blocked` のみ。
- `risk:` は 0/1 個。
- `area:`、`quality:` は複数可。
- 技術名、担当者名、Workflow名、Phase、実装ファイル種別をラベル化しない。
- namespace の無い裸のラベルを作らない。`ops` は 2026-08-11（#1915）に `area:operations` へ付け替えたうえで削除した。
- 新しいラベルが必要な場合は、既存 namespace（`type` / `area` / `scope` / `quality` / `risk` / `db` / `review`）では表現できないことを確認したうえで判断する。

## Issue 分類ラベル

### type（0/1 個）

- `type:mission` — 大きな目的を独立した Mission / Task / Bug / Question の sub-issue に分解する。Mission 自体は実装しない。
- `type:task` — 合意済みの範囲を実装し、検証する。
- `type:bug` — 不具合を再現し、回帰検証を加えて修正する。
- `type:question` — 一次資料と証拠を Issue コメントにまとめ、人の判断を待つ。PR や実装を作らない。

### priority（0/1 個）

| ラベル        | 意味   |
| ------------- | ------ |
| `priority:p0` | Urgent |
| `priority:p1` | High   |
| `priority:p2` | Medium |
| `priority:p3` | Low    |

値が空の Issue には優先度ラベルを付けない。PR へは複製しない。

### status

- `status:blocked` — 前提条件が満たされず、作業を止めている open Issue にだけ付ける。解除条件を確認したらこのラベルを外す。
- `ready` / `in progress` / `review` / `watching` などの状態ラベルは作らない。GitHub の open / closed state、リンク済み PR、Issue / PR のコメントと worktree を見て進行を判断する。
- Closed Issue の状態ラベルは運用しない。PR に status label を付けない。

## 旧分類からの移行記録（2026-09-29）

移行時は Organization Issue Type を優先し、未設定の場合だけ、競合のない旧ラベルを次のように対応させた。この表は移行記録であり、現行 Issue の Type を再判定する入力には使わない:

| 旧情報            | 移行先          |
| ----------------- | --------------- |
| `scope:epic`      | `type:mission`  |
| `type:bug`        | `type:bug`      |
| `type:discussion` | `type:question` |
| `type:spike`      | `type:question` |
| `type:feature`    | `type:task`     |
| `type:refactor`   | `type:task`     |
| `type:docs`       | `type:task`     |
| `type:test`       | `type:task`     |
| `type:chore`      | `type:task`     |
| `type:board`      | 未分類          |

旧候補が食い違った 26 件は User が振り分けを承認し、Mission 21 件、Task 3 件（#1524 / #2292 / #72）、Question 2 件（#591 / #590）へ統合した。旧 `type:*` ラベル 8 種類は削除し、`type:board` だけを持っていた 9 件は Type 未設定とした。現行 Type は上記 4 種類のラベルだけを使う。

Priority の値は優先度ラベルへ移して照合後、Organization の Priority field と Issue Type 定義 4 種類を削除した。Workflow status field と Project #3 は最終確認時点で存在しなかった。

## 正規ラベル一覧

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
  - **PR に付いている場合**: User 自身が重点的に確認する印。Codex review の起動条件には使わず、独立レビューは `scripts/ci/protected-path-gate.mjs` だけで判定する
  - **Issue に付いている場合**: 実装着手前に User 自身が目を通すべき合図（機械 gate はない）
  - ラベルの有無は merge / 着手可否の機械判定に使わない

### quality

- `quality:security`
- `quality:performance`
- `quality:accessibility`
- `quality:monitoring`
- `quality:cost`

## Dependabot ラベル（推奨）

- npm 更新: `type:task`
- GitHub Actions 更新: `type:task` + `area:infrastructure`
