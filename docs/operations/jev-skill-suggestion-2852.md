---
status: current
last_verified: 2026-09-25
---

# skill-suggestion 採用評価記録（#2852）

**判定: No-Go。運用には採用しない。** holdout は一度だけ明示承認を得て再開したが、19件中3件が `provider_error` で利用不可だった。評価できた範囲でも macro-F1 は Jev 0% / baseline 69% で基準を満たさず、複数 skill で recall も基準以上に低下した。

## 条件と実行範囲

- 実行日: 2026-09-25（JST）
- 評価対象の main revision: `93bb3544cc90541dc9e3c996378d017cf075463d`
- モデル識別子: `typesafe-ai/jev`。Node.js `24.19.0`、pnpm `11.26.0`
- 実行入口: `AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:pack skill-suggestion evaluate --split tune --max 1` で疎通確認後、`--split tune` で続行。最初の holdout 実行は3件連続の provider error で停止し、明示承認後に同じ条件で一度だけ再開
- 閾値は tune の `0.5` / `0.6` を比較し、集計が同一だったため既定の `0.5` に固定してから holdout を開始
- Issue本文に残る過去の母集団は 136 件（tune 108 / holdout 28）。現行 manifest は 105 件（tune 86 / holdout 19）で、tune の #2827 は入力上限超過だった。母集団は変更せず、現行収集結果を記録する

## 結果

### Tune

対象 86 件のうち、64 件を評価し、21 件が `provider_error`、1 件（#2827）は `input_too_large` で未評価となった。評価対象ペアは 20 件。

閾値 `0.5` と `0.6` の集計は同一だった。`jev ∪ rule` の macro-F1 は 40%、`rule ∪ B1` は 44%。micro-F1 はそれぞれ 48% と 41% だった。採用条件は holdout の macro-F1 が baseline を 0.10 以上上回り、どの skill でも recall を 0.2 以上落とさないことなので、tune の結果だけで Go 判定はしない。

### Holdout

閾値 `0.5`、質問セット `skill-suggestion-v1`、評価対象 revision を変えずに一度だけ再開した。runner は既評価で同一入力の #1893 を skip し、残る18件を送信した。再開分は15件が成功、#2596・#2627・#2658 の3件が HTTP 503 の `provider_error`。3件連続の失敗はなく runner は完了し、最終状態は19件中16件評価済み・3件利用不可・未評価0件となった。前回失敗した #2460・#2556・#2583 は再開時に成功した。

再開分の最初と最後の評価記録は `2026-09-25T00:52:55Z` と `2026-09-25T01:10:17Z`（17分22秒の timestamp span）。これは最初と最後の provider 評価時刻で、依存関係準備を含むプロセス全体の wall time は計測していない。再開試行の集計は [holdout retry JSON](jev-skill-suggestion-2852-holdout-retry.json) に保存した。

threshold `0.5` の report では、holdout macro-F1 は `jev ∪ rule` 0% / `rule ∪ B1` 69%、micro-F1 は 0% / 48%。error-handling、security、test、docs-writing で recall が baseline より低く、事前条件（macro-F1 を10ポイント以上改善し、各 skill の recall 低下を20ポイント未満にする）を満たさない。さらに3件が利用不可のため、欠測を Go と扱わない。

### 利用量

評価済みの成功応答に記録された usage と Gateway の market-cost は次の通り。market-cost は Gateway の市場価格推定で、実請求額ではない。

| split / 範囲                     | input tokens | output tokens | market-cost 推定 | Gateway cost / `costUsd` |
| -------------------------------- | -----------: | ------------: | ---------------: | -----------------------: |
| tune（64 件）                    |      501,725 |        15,232 |      $0.02107245 |                       $0 |
| holdout 初回成功分（1 件）       |        7,415 |           238 |      $0.00031143 |                       $0 |
| holdout 再開分の成功応答（15件） |      112,414 |         3,570 |     $0.004721388 |                       $0 |
| holdout 成功応答の累計（16件）   |      119,829 |         3,808 |     $0.005032818 |                       $0 |
| tune + holdout 成功応答の累計    |      621,554 |        19,040 |     $0.026105268 |                       $0 |

Gateway credits は実行前後で残高 `$4.99944644`、`totalUsed` `0.000567084` のまま変化しなかった。provider error の応答には成功 usage がないため上表の token / market-cost 合計に含めていない。

## 運用判断

- `skill-suggestion` は No-Go とし、`PACK_STATUS` を `disabled` に保つ。`collect` と `report` は引き続き利用できるが、`evaluate` は新たな明示承認まで停止する
- Context Brief と routing は既存の L0 / rule-only のまま維持する。未評価を合格扱いせず、#2891 の「採用済み pack の実配達」条件も満たしたことにしない
- 人手ラベルを要する #2853 はユーザーの指示により保留する
- 生の case 記録は共有 Git metadata の `.git/jev/packs/skill-suggestion/` に保存されており、この記録は集計を commit 可能な形で残す

## 検証

- `pnpm jev:check`: 17 件すべて OK（Node.js `24.19.0`）
- `pnpm jev:pack skill-suggestion report --split tune`: 上記 tune 集計を確認
- `pnpm jev:pack skill-suggestion report --split tune --threshold 0.6`: `0.5` と同じ集計を確認
- `pnpm jev:pack skill-suggestion report --split holdout --threshold 0.5`: 16 evaluated / 3 unavailable / 0 unevaluated、macro-F1 0% / 69% を確認
