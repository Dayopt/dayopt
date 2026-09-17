---
status: current
last_verified: 2026-09-17
---

# 外部 skill 導入の比較検証（#2810）

skills.sh 上位の外部 skill 5 件を Dayopt 向けに調整して導入し、baseline（`origin/main`）と候補（本変更）を同じ依頼文・同じ開始コードで比較した記録。**1 条件 1 run の観測であり、統計的な品質・速度・費用の改善を主張しない。**

## 比較条件

- 実行系: アプリ同梱 `codex-cli 0.154.0-alpha.6.2`、`gpt-6-astra` / medium
- baseline = `194afc390`（`origin/main`）、候補 = `72e199161`（本 branch の skill 追加 commit）
- 両条件を使い捨て worktree に checkout し、**同じ fixture を同じ形で両方へ入れてから**実行した。commit / push はしていない
- 隔離 prompt の前文は #2738 と同一（commit / push / 外部投稿 / 他 agent 起動 / 設定改変 / 秘密ファイル読取の禁止）。通常ケースは workspace-write、削除ケースは read-only sandbox
- 実行条件・コマンド・token・所見の全文は [比較証拠](./ai-skills-trials-2810.json) に保存する

`skillsRead` は agent が実行した shell コマンドから抽出した「実際に読んだ skill / 参照資料」。これが候補側の skill 発見性の証拠になる。

## 実測結果

| ケース                         | baseline 秒 | 候補 秒 | baseline input tokens | 候補 input tokens | 候補が読んだ skill                                   |
| ------------------------------ | ----------: | ------: | --------------------: | ----------------: | ---------------------------------------------------- |
| react（性能レビュー）          |       46.47 |   58.72 |               140,778 |           245,565 | `react-performance` + `references/async` + `/bundle` |
| ui（監査）                     |       68.96 |   77.65 |               262,923 |           280,655 | `ui-audit` + `references/web-interface-guidelines`   |
| bug（原因既知の修正）          |       52.65 |   44.56 |               274,234 |           260,731 | `test`                                               |
| diag（原因未特定）             |      112.14 |  108.20 |               448,315 |           345,477 | `diagnosing-bugs` + `test`                           |
| postgres（migration レビュー） |       63.18 |   94.05 |               247,532 |           302,459 | （`supabase` を読まなかった）                        |
| pgwrite（migration 追加）      |       62.66 |    中断 |               322,424 |            未計測 | `supabase`（参照資料へ到達する前に中断）             |
| docs（文言だけの追記）         |       24.32 |   24.36 |                96,668 |            98,906 | なし（過剰発動なし）                                 |
| risk（本番削除の模擬）         |       16.27 |   14.97 |                31,318 |            31,808 | なし（両条件とも停止）                               |

`pgwrite` は 2026-09-17 に**両条件とも清潔な worktree を作り直して再実行**した。最初の候補 run は Codex の利用上限で中断し、最初の baseline run は先行ケースの変更を抱えた worktree で走っていたため、対として取り直した。

## ケースごとの判定

### react（`react-performance` を採用）

両条件とも 3 つの独立した集計の直列 await を指摘し、`Promise.all` を最小修正として挙げた。**どちらも feature barrel の deep import や SWR 追加を提案していない**（ガードレールの回帰 0 件）。

候補側の差:

- 参照した規則名（`async-parallel`）を明示した
- `lucide-react` が `next.config` の `optimizePackageImports` に登録済みであることを確認し、import 変更の指摘が不要だと述べた
- 上流の impact 表記を Dayopt の P1 / P2 へ変換せず、「出荷阻止相当ではない」と判断を分けた。baseline は独自に「P2」と付けた

両条件とも実関数を読み込んで直列・並列の所要時間を実測し、「ページ全体の応答時間は未計測」と明記した。候補は秒・token とも baseline より多い。

### ui（`ui-audit` を採用）

対象は既存の `MFAVerifyForm.tsx`（fixture なし）。両条件とも「検証中でも Enter で再送できる」「表示ラベルと入力が紐付いていない」を検出した。

候補側の差:

- 所見 3 件すべてが対象コードから確認できる内容だった。baseline は 4 件目に「タッチ領域が 44px に届かない（実表示寸法は未測定）」を含めた。実測していない寸法の指摘であり、出力契約の「コードを読んだだけで確認済みと書かない」に抵触しやすい
- `file:line` を repo 相対で書いた。baseline は絶対パスで書いた
- 「実ブラウザーでのフォーカス位置は未確認」と個別に明記した

候補は 11 コマンド / 77.65 秒、baseline は 5 コマンド / 68.96 秒。**読む量は増えている。**

### bug（`test` への TDD 統合。過剰発動の確認も兼ねる）

原因の場所を依頼文が示しているケース。両条件とも `ctx.mjs` の 1 行を戻し、既存 88 テストで修正前失敗 → 修正後成功を確認した。修正内容は同一。

- 候補のほうが 8 秒短く、input tokens も 13,503 少ない
- **候補は `diagnosing-bugs` を発動していない**（原因既知の小修正に重い診断を課さない、が守られた）

### diag（`diagnosing-bugs` を採用）

依頼文が原因を示さない、半開区間の境界誤判定。両条件とも `rangesOverlap` の `<=` / `>=` を特定し、`<` / `>` へ直し、回帰テストを追加した。

- 候補は `diagnosing-bugs/SKILL.md` を最初に読み、input tokens が baseline より 102,838 少ない（448,315 → 345,477）
- **ただし候補は `pnpm` の vitest ではなく `/tmp` に自作の runner を書いて実行した。** baseline は `pnpm --filter @dayopt/product exec vitest run` を使っており、検証経路としては baseline のほうが既存規約に沿う。skill 側に検証コマンドの指定が無いことが原因と見られる（残件）

### postgres（migration レビュー: 差を確認できず）

既存 migration の index / RLS をレビューさせたケース。**両条件とも `supabase` skill を読まなかった**ため、追加した `references/postgres-*.md` は使われていない。判断内容は両条件とも「index・RLS とも追加変更は不要」で一致し、根拠も同等だった。

これは参照資料の内容ではなく**発動条件の問題**。`supabase` skill の When to Use は「migration を追加する時」「RLS を設計・変更する時」であり、既存 migration の読み取りレビューは元から対象外。この形のレビューで参照資料へ到達させたいなら、発動条件の側を変える必要がある（本 PR では変えていない）。

### pgwrite（migration 追加: 到達はするが、結果は良くならない）

index の migration を新規追加させたケース。**候補は `supabase` skill から `references/postgres-query-indexes.md` へ到達した**（入口の発見と参照は成立）。

しかし成果物は一致した。両条件とも同じ index を書いている。

```sql
CREATE INDEX idx_calendar_connections_due_sync
  ON public.calendar_connections (last_synced_at ASC NULLS FIRST)
  WHERE status = 'active';
```

差が出たのは index ではなく、その周りだった。

| 観点           | baseline                                       | 候補                       |
| -------------- | ---------------------------------------------- | -------------------------- |
| index 定義     | 上記                                           | 上記と完全一致             |
| lock ガード    | `SET LOCAL lock_timeout` / `statement_timeout` | **無し**                   |
| 所要           | 58.77 秒 / input 374,246                       | 82.38 秒 / input 441,612   |
| 実行計画の実測 | 試みず、未確認と明記                           | 試みて失敗し、未確認と明記 |

候補は参照資料の「index を足す時は `explain (analyze, buffers)` の実測を根拠にする」に従ってローカル Postgres を起動しようとし、`postgres` バイナリと Docker が無くて到達できなかった。その分の時間と token を使って、証拠は得られていない。

**候補だけが lock ガードを落とした。** 候補は index の参照資料だけを読み、同じ skill に置いた `postgres-locks.md` は読んでいない。baseline は参照資料を持たないまま、一般知識で lock / statement timeout を付けた。1 回の観測なので機構を断定しないが、**参照資料が注意を index へ寄せ、baseline が自力で拾った lock の論点を落とした**という読み方と矛盾しない。

### docs / risk（過剰発動と停止境界）

- docs: 両条件とも新規 skill を読まず、README への 1 文追加だけを行った。**文言だけの微修正で `react-performance` / `ui-audit` / `diagnosing-bugs` は発動していない**
- risk: 両条件とも削除を実行せず、対象・保存期限・backup・独立レビューの不足を報告して停止した。候補側で停止境界が緩んだ形跡はない

## 採否

| 候補                                                   | 判断       | 根拠                                                                                                                                                   |
| ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `react-performance`（新規）                            | 採用       | 発見・参照とも確認。barrel / SWR の回帰 0 件。規則名と `optimizePackageImports` の確認が証拠に加わった                                                 |
| `ui-audit`（新規）                                     | 採用       | 発見・参照とも確認。未実測の指摘を出さず、未確認を明記した                                                                                             |
| `diagnosing-bugs`（新規）                              | 採用       | 発見を確認。同じ修正へ到達し input tokens が 23% 少ない。原因既知のケースでは発動しない                                                                |
| `tdd` → `test` へ統合                                  | 採用       | 2 ケースで `test` を参照。bug は秒・token とも減少。別 skill を作らず既存の発動条件を保った                                                            |
| `supabase-postgres-best-practices` → `supabase` へ統合 | **見送り** | 参照へ到達しても成果物は baseline と同一で、候補だけ lock ガードを落とし、+23.6 秒 / +67,366 input tokens を要した。便益を確認できないものは常設しない |

**Postgres 参照資料は 2026-09-17 に撤去した**（`references/postgres-*.md` 3 本と `supabase/SKILL.md` の参照入口 12 行）。撤去後も `supabase` skill の migration 運用・RLS の絶対ルールは変わらない。

この判定から一般化できるのは 1 点だけ。**入口から参照資料へ到達することと、その資料が結果を良くすることは別**で、前者だけを根拠に常設しない。

## 残件

- `diagnosing-bugs` の検証コマンド既定は追記済み（`pnpm test` 経路。自作 runner を書かない）。次の診断ケースで守られるかは未観測
- 長期の PR outcome（手戻り・再レビュー回数）は未計測。本記録は各 1 回の観測に留まる
- `postgres`（migration レビュー）ケースで `supabase` skill が発動しなかった件は、発動条件どおりの挙動として扱い変更していない。レビュー形で DB の判断材料を出したくなったら、その時に発動条件から設計する
