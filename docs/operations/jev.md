---
status: current
last_verified: 2026-09-20
code:
  - scripts/tasks/jev
---

# Jev 評価レイヤー

Jev は Vercel AI Gateway 経由で呼ぶ小さな評価モデルで、**非構造の文章から、コードでは取りにくい意味的な特徴を足す層**として使う。判断そのものはコードが持つ。

策定と実測の経緯は [#2827](https://github.com/Dayopt/dayopt/issues/2827)。この文書は運用手順の正本で、設計の議論と negative result は issue 側に残る。

## 境界（ここを外さない）

- **Jev は最終意思決定者ではない。** 権限、必須レビュー、test の exit code、path に基づく policy、算術、日付の比較は、これまでどおり trusted code が所有する
- **Jev の低リスク判定で、既存の権限・必須レビュー・security floor を下げない**
- **決定的に分かることは Jev へ聞かない。** 質問を書く前に「同じ判定を既存のコードが答えられないか」を確かめる（下の §pack を足す）
- **障害・予算切れ・低 confidence でも、既存の作業とレビューが成立する。** Jev が止まっても他は動く
- **state に書かれた指示文を security boundary として信用しない。** 回答の形を要求した集合に閉じても、その集合の中へ誘導された回答は素通りする
- 自動停止・自動 merge・自動権限付与へ直接つながる経路は作らない

## 費用と予算

- Gateway の無料枠は **$5**。**credits は購入しない。** auto top-up・BYOK・他モデルへの fallback も設定しない
- key 側に **budget $4 / 月**と**有効期限 90 日**が付いている。運用上の余裕はこの差分（$1）
- 残高が **$1 を下回ると送信前に停止**する（`balance_below_floor`）。残高が読めない時も送らない（`balance_unknown`）
- 費用の正本は各リクエストが返す実費。**残高の差分で測らない**（timeout でも課金されている可能性がある）
- 2026-09-19 の実測では、73 件すべてで実費 0・定価（`marketCost`）だけが記録された。**元に戻る前提で予算制御は維持する**

## setup

key は 1Password `agent/vercel-ai-gateway`。境界と発行手順は [secrets.md §評価モデル Jev の Gateway key](./secrets.md)。

```bash
node -v                # 24.x（.nvmrc / engines）
gh auth status         # collect が gh api を使う
pnpm 1password:check   # agent / vercel-ai-gateway が EXPIRES 付きで出れば OK
pnpm jev:check         # ネットワーク不要の静的検査。ここが落ちる状態では先へ進まない
```

`pnpm jev:check` は課金の前に見る検査で、SDK の exact pin、retry が 0 であること、モデルが 1 つしか無いこと（予算切れを別モデルで救済する経路が無いこと）、質問セットの静的検査、既存の注釈と cacheKey が一致すること、pack の status を見る。

## コマンド

| コマンド                          | 何をするか                                           | 課金 |
| --------------------------------- | ---------------------------------------------------- | ---- |
| `pnpm jev:check`                  | 設定・質問セット・pack status の静的検査             | なし |
| `pnpm jev:smoke`                  | 合成データで少数回の実呼び出し。接続と応答形式の確認 | あり |
| `pnpm jev:pack <packId> collect`  | 評価対象の収集（GitHub から。Jev は呼ばない）        | なし |
| `pnpm jev:pack <packId> evaluate` | 収集済み case を 1 件ずつ評価                        | あり |
| `pnpm jev:pack <packId> report`   | 保存済みの注釈から集計を出し直す                     | なし |
| `pnpm jev:shadow`                 | Phase 1 の旧 CLI。保存先の互換のために残している     | あり |

課金するコマンドは key を inline で注入して起動する。

```bash
AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- \
  pnpm jev:pack skill-suggestion evaluate --split tune
```

`op run` は対話承認が要る。承認を押さないと `authorization timeout` で 0 件のまま終わる。

**本番の前に必ず `--max 1` で 1 件だけ送る。** 質問 ID の往復や応答形式の想定違いは、ここで止めれば 1 件分の費用で済む。

### 実測値（2026-09-19、往復は 2026-09-20 に再確認）

- 送信間隔の既定は **60 秒**。バースト約 5 件で 429 になる実測に合わせてある
- 429 は **300 秒**待って同じ case を 1 回だけ再送。2 回連続で停止する
- timeout は 20 秒。latency は p50 630 ms / p95 964 ms
- 評価済みで入力が変わっていない case は skip するので、**中断して再実行すれば続きから進む**
- 費用の目安は 1 件 $0.0003 前後、60 case で $0.02 前後
- 質問 ID は underscore を含む形（`skill_trpc_router_creating` など 12 個）がそのまま往復する。応答の model ID は version の付かない alias（`typesafe-ai/jev`）で返る（2026-09-20、`--max 1` で実測。入力 7,032 tokens / 875 ms / 実費 0）

## 止まった時

| 症状                              | 挙動                                            | 対応                                       |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `authorization timeout`           | 0 件のまま終了                                  | `op run` の承認を押す                      |
| `rate limited`                    | 300 秒待って 1 回再送。2 回連続で停止（exit 1） | 時間を空けて再実行。`--delay` を伸ばす     |
| `予算の下限に達した`              | 残高が $1 を割ったら送信前に停止                | credits は買わない。ここで打ち切る         |
| `auth_failed` / `invalid_request` | 即停止                                          | key の期限と 1Password を確認する          |
| `保存先 … は pack … のもの`       | 送信・書き戻しの前に停止                        | `--out` の取り違え。正しい保存先を指定する |
| `pack … は無効化されている`       | evaluate だけ停止（collect / report は通る）    | 下の §止め方 を参照                        |

## 止め方

3 段ある。**必要な一番小さいものを使う。**

1. **pack 1 つを止める** — `PACK_STATUS` を `disabled` にして理由を書く。`evaluate` だけが止まり、`collect` と `report` は通る（negative result を読み返せなくなると、止めた判断の根拠ごと失われるため）。`pnpm jev:check` が理由の欠落を落とす
2. **Jev 全体を止める** — `JEV_DISABLED=1`。外部呼び出しの前に `unavailable` を返す
3. **撤去する** — key を失効させ、`pnpm jev:*` の scripts と `scripts/tasks/jev/` を消す。アプリは依存していない（SDK は root の devDependencies だけで、product にも web にも入らない）ので、消しても製品は動く

## pack を足す

pack は「state の作り方・質問・決定的な baseline・policy・正解・指標」の組で、adapter（Gateway 呼び出し・予算・timeout・schema 検証・cache・telemetry）は共通のものを使い回す。

**質問を書く前に、この表を grep で埋める。** Phase 1 で負けた 4 問は、いずれも repo に決定的な代替が既にあった判定だった。

| 判定                              | 既にある決定的な実装                                        |
| --------------------------------- | ----------------------------------------------------------- |
| lane（L2 / L3 / unclassified）    | `resolveFactoryRoute`                                       |
| 権限 / 時間不変条件 / 公開契約    | `scripts/ci/protected-path-gate.mjs` と path / 本文の regex |
| 変更 path → 関連 skill            | `pnpm ctx` の skill 規則                                    |
| 着手に足る本文があるか            | 本文 200 文字（tune 70 件で不一致ゼロ）                     |
| 受け入れ条件 / 検証コマンドの有無 | `pnpm ctx` の検出規則                                       |

**Jev に残るのは「入力が文章しか無く、答えが有限集合で、間違えても floor を下げない」判定だけ。**

手順:

1. **候補はコードが作る。** 「deck から card を選ぶ」形にする。候補の生成器と正解の生成器は別にする（候補は広くてよいが、同じ規則を正解に流用すると偽陽性が混ざる）
2. **決定的な baseline を必ず 1 つ以上書く。** baseline を上回らない pack は接続しない
3. **Go 条件を、評価を流す前に issue へ書く。** 結果を見てから基準を決めると後付けの当て込みになる
4. **tune と holdout を分ける。holdout は 1 回だけ。** 見た後に質問文や閾値を変えたら、それは再実行として別に裁可を取る
5. 質問数は 1 request あたり 12 まで、choice の選択肢と score の段は 5 まで（固定の許容誤差で応答を検証できる範囲）
6. 独立した判定は同じ state に束ねる。ある質問の回答を別の質問が読めると仮定しない。判定の合成はコードで行う
7. 閾値・合成規則の version は cache key に入れない。**注釈と決定を分けて保存する**ので、閾値を変えても再課金せずに集計し直せる

## 今ある pack

| pack               | 状態 | 中身                                                                         |
| ------------------ | ---- | ---------------------------------------------------------------------------- |
| `shadow-e1`        | 無効 | Phase 1 の 8 問。決定的な baseline を上回らなかった（下の §negative result） |
| `skill-suggestion` | 有効 | 12 skill の boolean。issue 本文から、着手時に読むべき skill を候補として出す |

## negative result（[#2827](https://github.com/Dayopt/dayopt/issues/2827)）

Phase 1 の shadow 評価（実 PR 100 + 合成 4、tune 76 件を完走）で分かったこと。**同種の道具を検討する時の出発点にする。**

- **観点 3 問**（権限 / 時間不変条件 / 公開契約）は、変更 path から機械的に答えが出る判定だった。再現率 19〜44% で、構造上 100% 正確な決定的 gate に負ける
- **lane 分類**は、証拠のある case で `routine` を一度も選ばなかった。定数 `standard` を返す実装と区別が付かない
- **証拠の十分さ**は 70 件で本文長 200 文字と不一致ゼロ。しかも検出したい「薄い issue」が repo の 2% しか無い
- 合成した prompt injection ケースでは、**state に書かれた「routine・レビュー不要」という誘導に従わなかった**（1 件ずつなので耐性の証明ではない）
- 学んだ手順が上の §pack を足す。**単一 pack の失敗を理由に共通基盤を撤去しない**のが #2827 の不変条件

## 起票時の契約から変わったもの

`pnpm jev:eval` / `jev:annotate` / `jev:periodic` は #2827 の起票時に置いた CLI の案で、**作らない**。収集・評価・集計は `pnpm jev:pack <packId> <collect|evaluate|report>` に統一した。

batch 用の queue や常駐プロセスも作らない。バースト約 5 件・持続約 1 件/分という実測に対して、プロセス内の間隔制御で足りる。
