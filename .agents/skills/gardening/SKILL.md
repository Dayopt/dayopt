---
name: gardening
description: ユーザーが月次の改善ループの実施を明示依頼した時、または `/gardening` として明示起動された時に発動。利用可能な provider ログと `pnpm trace` の実測から outcome・再作業・介入・検証漏れを評価し、変えるのは月に 1 つだけ決めて `docs/decisions.md` へ `結果(未):` 付きで残す。日次の作業判断や自動実行の設計では発動しない。
---

# 月次改善ループ（gardening）

目的は「仮説 → 1 か月運用 → 実測 → 判定」を **人が月 1 回 30 分で閉じる** こと。benchmark は持たず実際の issue / PR outcome を benchmark とし、月を試行の単位にする（`docs/decisions.md` 参照）。

**engine は月初に User が開く session**。`pnpm ai:usage` と `pnpm trace` の session / token / tool telemetry は Claude Code の local transcript だけを読む。Codex / Antigravity は未収集であり、欠けた値を 0 と扱わない。GitHub 由来の PR / review / merge outcome は repo 全体の指標として別に読み、Claude Code の効率へ帰属させない。自動パートは持たない。

## When to Use

**明示発動型** — 月初に User が `/gardening` を起動した時だけ発動する。

- 月初の改善ループを回す時
- 前月に `結果(未):` 付きで書いた決定の判定期限が来た時
- 月の途中でも「変数を 1 つ変えたい」判断が出た時（その場合も本手順 1〜2 だけを回す）

## 手順（30 分）

0. **決定的な計測**（数十秒、LLM は結果を読むだけ）
   - `pnpm ai:usage`（既定 = 前月の暦月）。Claude Code telemetry の期間と欠損を確認する。Codex / Antigravity の未収集値は 0 と比較しない
   - ready 後の commit が 3 回を超えた PR、revert、P1 / P2、User の追加介入があった PR を `pnpm trace <PR>` で見る（候補は `gh pr list --state merged --search "merged:YYYY-MM-01..YYYY-MM-31" --json number` から）。session 部分は Claude Code のみ、GitHub outcome は repo 全体として分けて読む
1. **AI 協働の 4 問**に yes / no で答える（`routing` skill の成功条件との距離）
   - issue / PR の成功条件を満たし、revert や再発を増やしていないか
   - 事実と仮説を分け、誤った前提による再作業が減ったか
   - scoped delegation は、引き渡し・待ち・統合の費用を上回る成果を出したか
   - 検証前の探索 turn と、User が補う必要のあった判断・権限確認は減ったか
   - no が複数あっても **変えるのは 1 つ**。変えたら `decisions.md` に `結果(未):`（翌月または翌々月の判定条件）付きで 1 行追記する（`decision` skill）
2. **前月の `結果(未):` を回収する**。判定材料が揃っていれば `結果(YYYY-MM-DD):` 行を追記して恒久化 / 撤回を明記する。揃っていなければ期限を 1 行で延ばす
3. **判断層の検証**（`AGENTS.md` §シンプルルール）: ①今月このルールに戻った場面はあったか（1 度も戻らないルールは削る候補）②無言で破られたルールは無いか ③先月触らなかった機能はどれか（ルール 5。削除候補は `dispatch` intake で起票）
4. **レビューの歩留まり**: provider を問わず P1 / P2 で同じ構造の指摘が当月 2 回以上、または通算 2 回以上なら機械化（test / lint / CI）の issue を起票する。指摘ゼロが続く reviewer / provider は、費用と独立性を再評価し、縮小か廃止の候補にする
5. **security sweep**: cloud Supabase MCP をオンデマンド登録して `get_advisors`（security）、あわせて `pnpm security:check`。所見は issue、使用後に登録解除（`mcp-usage` skill）。深掘りが要る月は `security-sweep` skill を 1 境界だけ回す（provider 非依存。`/claude-security` は任意の加速器で、無くても完走する）
   - `pnpm-workspace.yaml` の `overrides` / `patchedDependencies` / `audit.ignore` の棚卸しを同時に行う。**lockfile に対象 version が無いことを stale の根拠にしない** — 効いている override はその version を消すので、不在はむしろ現役の証拠。1 件ずつ外して `pnpm install` し、`pnpm audit` の advisory と lockfile の `packages:` 件数が両方とも変わらないものだけを削除する
6. **成果物**: ルール・skill・docs に変更があれば docs 束 PR（`{agent}/gardening-YYYY-MM`）。無ければ **無音**。journal ファイルも常設 issue も作らない（再計算できる数値は複製せず、残す判断は `decisions.md` に入れる）

四半期に 1 回（1 / 4 / 7 / 10 月）だけ、手順 6 の前に `docs-audit` skill と `audit-ai-config` skill を回す。provider 固有の高コストな深掘りスキャンは User の明示 opt-in がある時だけ単独で走らせ、利用できなければ同じ scope と出力契約を満たす別手段を選ぶ。

## When NOT to Use

- 日次の作業判断・issue の起票・sweep（`dispatch` skill の領域）
- 自動実行の設計や cron の追加（本 skill は engine を持たない設計）
- リリース作業（`releasing` skill の領域）

## 守ること

- **1 か月に 1 変数**。効いたかを帰属できない変更を重ねない
- **足したら 1 つ削る**。ルール・skill・決定的な道具のカタログはどれも同じ。2 か月使われない行は削る
- **数値を機械的に fail 扱いにしない**。4 問の no は判断の材料であって、それ自体で何かを止めない
- 判断は `decisions.md` に、所見は issue に。会話の中だけに置かない
