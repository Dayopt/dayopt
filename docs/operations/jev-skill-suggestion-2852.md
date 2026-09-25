---
status: current
last_verified: 2026-09-25
---

# skill-suggestion 採用評価記録（#2852）

**状態: 判定不能。運用には採用しない。** tune は一部の評価で baseline を下回り、holdout は provider error の連続で完走しなかった。holdout の追加実行には別途明示承認が必要。

## 条件と実行範囲

- 実行日: 2026-09-25（JST）
- 評価対象の main revision: `93bb3544cc90541dc9e3c996378d017cf075463d`
- モデル識別子: `typesafe-ai/jev`。Node.js `24.19.0`、pnpm `11.26.0`
- 実行入口: `AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:pack skill-suggestion evaluate --split tune --max 1` で疎通確認後、`--split tune` で続行。holdout は `--split holdout` を1回だけ開始
- 閾値は tune の `0.5` / `0.6` を比較し、集計が同一だったため既定の `0.5` に固定してから holdout を開始
- Issue本文に残る過去の母集団は 136 件（tune 108 / holdout 28）。現行 manifest は 105 件（tune 86 / holdout 19）で、tune の #2827 は入力上限超過だった。母集団は変更せず、現行収集結果を記録する

## 結果

### Tune

対象 86 件のうち、64 件を評価し、21 件が `provider_error`、1 件（#2827）は `input_too_large` で未評価となった。評価対象ペアは 20 件。

閾値 `0.5` と `0.6` の集計は同一だった。`jev ∪ rule` の macro-F1 は 40%、`rule ∪ B1` は 44%。micro-F1 はそれぞれ 48% と 41% だった。採用条件は holdout の macro-F1 が baseline を 0.10 以上上回り、どの skill でも recall を 0.2 以上落とさないことなので、tune の結果だけで Go 判定はしない。

### Holdout

19 件中、#1893 の 1 件だけ成功し、#2460・#2556・#2583 の 3 件は `GatewayInternalServerError` / `AI_APICallError`、HTTP 503 `Service temporarily unavailable` となった。3 件連続した時点で runner を停止し、残る 15 件は未評価。macro-F1・recall を比較できないため Go 判定はできない。holdout の追加実行は行わない。

### 利用量

評価済みの成功応答に記録された usage と Gateway の market-cost は次の通り。market-cost は Gateway の市場価格推定で、実請求額ではない。

| split           | input tokens | output tokens | market-cost 推定 | Gateway cost / `costUsd` |
| --------------- | -----------: | ------------: | ---------------: | -----------------------: |
| tune（64 件）   |      501,725 |        15,232 |      $0.02107245 |                       $0 |
| holdout（1 件） |        7,415 |           238 |      $0.00031143 |                       $0 |
| 合計            |      509,140 |        15,470 |      $0.02138388 |                       $0 |

Gateway credits は実行前後で残高 `$4.99944644`、`totalUsed` `0.000567084` のまま変化しなかった。provider error の応答には成功 usage がないため上表の token / market-cost 合計に含めていない。

## 運用判断

- `skill-suggestion` を採用せず、`PACK_STATUS` を `disabled` にする。`collect` と `report` は引き続き利用できるが、`evaluate` は追加送信の明示承認まで停止する
- Context Brief と routing は既存の L0 / rule-only のまま維持する。未評価を合格扱いせず、#2891 の「採用済み pack の実配達」条件も満たしたことにしない
- 人手ラベルを要する #2853 はユーザーの指示により保留する
- 生の case 記録は共有 Git metadata の `.git/jev/packs/skill-suggestion/` に保存されており、この記録は集計を commit 可能な形で残す

## 検証

- `pnpm jev:check`: 17 件すべて OK（Node.js `24.19.0`）
- `pnpm jev:pack skill-suggestion report --split tune`: 上記 tune 集計を確認
- `pnpm jev:pack skill-suggestion report --split tune --threshold 0.6`: `0.5` と同じ集計を確認
- `pnpm jev:pack skill-suggestion report --split holdout --threshold 0.5`: 1 evaluated / 3 unavailable / 15 unevaluated を確認
