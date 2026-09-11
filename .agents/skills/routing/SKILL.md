---
name: routing
description: 複数ファイル・複数手順・調査を伴うタスクの着手時、委譲の直前、同じ tool 呼び出しを繰り返した時、作業の成功条件や検証方法が曖昧な時に発動。成功条件を固定し、決定的な道具・直接実行・scoped delegation を費用対効果で選び、証拠付きの出力契約を適用する。1 行修正や既存パターン追従の単発編集では発動しない。
---

# Routing（分解と実行方法の選択）

目的は、最少の context と往復で検証可能な outcome を得ること。OpenAI / Codex を primary harness とするが、特定 model の序列を workflow に埋め込まない。provider や model は、必要な能力・可用性・privacy・費用をその時点で比較して選ぶ。

## When to Use

以下の状況で発動:

- 複数ファイル・複数手順・調査を伴うタスクに着手する時
- subagent、別 session、外部リサーチへ作業を渡す直前
- issue を受け取り、成功条件・対象範囲・検証方法を具体化する時
- 同じ種類の tool 呼び出しを 3 回以上繰り返していると気づいた時
- task の分解や委譲が、実行そのものより高くなりそうな時
- 委譲先の報告を受け取り、次の作業や完了判定を決める時

## 手順

1. **成功条件を先に書く**。ユーザーが確認できる結果、触る範囲、pass すべき検証、外部 state 変更の有無を 1〜5 行で固定する。issue / PR があればそこへ残す
2. **事実と仮説を分ける**。repo / docs / issue / command output で確認した事実には path や出力を添える。原因・効果・前提が未実測なら「仮説」と書き、安く検証できるものは分解前に確認する
3. **候補を順に比較する**
   - 既存 script / CLI / test だけで閉じる
   - 担当 agent が同じ context で直接完了する
   - bounded subtask を scoped delegation する
   - 別 provider の独立反証、Chat での資料整理・分析、外部リサーチを追加する
4. **委譲の採算を判定する**。次のすべてが yes の時だけ委譲する
   - 他の作業と独立して進められる
   - allowed path と禁止事項を短く指定できる
   - 成功条件と出力を親が独立検証できる
   - context の受け渡し・待ち・統合の費用より、独立視点・専門性・利用枠分散の便益が大きい
5. **出力契約を渡す**。下記 template に従い、model 名より能力要件を先に書く。issue / PR があれば `pnpm ctx <N>` の振り分けを確認し、採用する層・理由・実際の model を引き継ぎ時に記録する。model 指定が可能な runtime では下記の候補から選び、選べない時は変更済みと報告しない
6. **outcome を検証する**。diff、検証コマンドの出力、必要なら UI / API / data flow を成功条件と突き合わせる。「passed」「done」という申告だけでは完了にしない
7. **永続 handoff を更新する**。issue / PR に、確認した事実、残る仮説、判断、検証結果、次の一手を書く。会話 transcript だけに状態を残さない

## 実行方法の比較

| 方法               | 適する作業                                                               | 選ぶ条件                                 | 主な検証                              |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------- |
| 決定的な道具       | search、git history、diff、lint、typecheck、test、JSON 変換、CI 状態取得 | 既存 script / CLI が対象を表現できる     | exit code、機械可読出力、対象件数     |
| 直接実行           | context が一体で、小さく分けると往復が増える実装・調査                   | 担当 agent が scope 内で安全に完了できる | diff と end-to-end の成功条件         |
| scoped delegation  | 独立した列挙、調査、実装、検証                                           | bounded scope と出力契約を固定できる     | 親が一次情報と突合                    |
| 別 provider の反証 | auth / RLS / billing / migration / 公開契約などの高リスク変更            | 独立視点の便益が実行コストを上回る       | failure scenario と diff の到達可能性 |

外部 provider の反証は任意であり、可用性を merge gate にしない。OpenAI / Codex で実装した変更に他 provider を使う場合も、その provider へ渡す context と権限を必要最小限にする。

## Chat・外部 AI を選ぶ時

資料整理、実装前の反証、公開説明の整合、外部調査、分析、説明作成は、主担当が必要性を判断して候補へ入れる。User が毎回「Chat に回す」と指示することを前提にしない。ただし、実際の送信・会話作成は User の許可範囲と runtime の規則に従う。

- repo 文脈が濃い実装・不具合調査、小さな公式仕様確認は直接進める。範囲と検証が明確な実装は既存の L1/L2 候補を使う
- 長い待ち時間を許容できる時は、取得できた利用枠の余裕も比較する。別会話・別 model を別枠と推定しない。確認できない消費量は未計測とする
- 外部依頼は短い要約と根拠の保存先を返させ、主担当が全文を繰り返し読む負担を減らす。独立案には目的と制約、反証には提案と一次資料を渡し分ける
- 人の受け渡しが必要な経路を、離席中の必須工程にしない。使える経路で続行するか、依存する判断を保留して進捗と再開条件を残す

実行時は [Chat 連携手順](../../../docs/operations/chat-handoff.md) の依頼・返却テンプレート、投稿権限、完了照合、待機・復旧を使う。通常の往復、Deep Research、GitHub 投稿、自動再開は別々に検証し、機能名を書いた依頼だけで起動済みとしない。新しい強制レビューや独自の常駐システムは追加しない。

## 決定的な道具の入口

既定出力は判断できる大きさに射影し、失敗を空出力で隠さない。

| 分類             | 入口                                                     | 射影                                          |
| ---------------- | -------------------------------------------------------- | --------------------------------------------- |
| Repository       | `rg -n`、`git diff --stat`、`git log -S`、`git blame -L` | 件数・stat から入り、必要 path だけ読む       |
| Validation       | `pnpm check`、`pnpm typecheck`、`pnpm lint`、対象 test   | 失敗行と末尾を残す                            |
| Context          | `pnpm ctx <issueまたはPR>`                               | 成功条件・関連 path・次の一手に絞る           |
| CI / PR          | `gh pr checks`、`gh run view`、`pnpm trace <PR>`         | `--json` / `--jq` で必要 field だけ読む       |
| External service | repo script、公式 CLI、必要時だけ MCP                    | metadata と対象 1 件へ絞り、secret を出さない |

同じ tool 連鎖が繰り返される場合は script 化の候補にするが、今回だけの短い処理を先回りして恒久化しない。巨大出力は context に入れる前に範囲指定、`--jq`、head / tail で射影する。

## L0〜L3 の振り分けと引き継ぎ

`pnpm ctx <N>` / `--json` は機械判定による助言を返す。既存の保護対象判定は外部契約・不可逆性の信号として再利用し、時間・操作の不変条件は別に検出する。`review:full` は人間向けの印なので機械入力に使わない。実装・判断の層と、事前整理の層を分ける。L3 の変更でも事実収集は L0・L1 に渡せる。

| 層  | 成果                                             | Codex の候補（運用上の目安） |
| --- | ------------------------------------------------ | ---------------------------- |
| L0  | CLI による情報取得・集計・検証                   | model を起動しない           |
| L1  | 指定範囲の根拠付き事実・既存パターン・未確認事項 | Spark / Luna                 |
| L2  | 仕様と検証方法が明確な通常実装                   | Terra、範囲が狭い場合は Luna |
| L3  | 不変条件・権限・外部契約・設計の判断             | Sol / Astra                  |

この表は能力の保証でも自動起動設定でもない。runtime の可用性と実際の結果で選び直す。Spark の速さを消費量の少なさと同一視しない。毎回 L1 から順に昇格させず、初めから適切な層へ渡す。

- `routing.level` は通常実装を L2、危険な手掛かりがあれば L3、情報不足なら `unclassified` とする。L1 は事前整理の候補で、コード変更の自動許可ではない
- `routing.ready` は入力項目の存在確認だけ。受け入れ条件・検証コマンドの検出は既存の文字列判定なので、内容が十分かは担当が確認する。`status:ready` の付与・merge・production 操作を許可しない
- path / 本文の一致は保守的な手掛かり。calendar 内の小修正も L3 候補になる場合がある。差分の実際の意味を確認して層を下げる時は理由を残す。一致なしを安全の証明にしない
- 想定原因と実測が食い違う、対象が広がる、同種の失敗が続く時は AGENTS.md の停止条件に従い、証拠を残して再判定する

### L1 の資料を再利用する

引き渡しが必要な作業にだけ使う。同じ担当が小修正を完了できる時は資料を増やさない。

```bash
pnpm --silent ctx <N> --json > /tmp/dayopt-context.json
pnpm handoff:create --context /tmp/dayopt-context.json \
  --source scripts/tasks/ctx.mjs --source scripts/tasks/trace.mjs \
  --out /tmp/dayopt-handoff.json
pnpm handoff:validate --context /tmp/dayopt-context.json --file /tmp/dayopt-handoff.json
```

`--source` は作業ごとの関連ファイルに置き換える。repo 内のファイルを 1〜40 件まで明示する。ディレクトリ丸ごとや秘密ファイルは収集しない。生成された JSON は `draft` で、既存ファイルは上書きしない。L1 は以下を記入する:

- `goal` / `acceptance`: ユーザーの目的と完了条件
- `facts`: `{ "claim": "確認した事実", "path": "scripts/tasks/ctx.mjs", "line": 1 }` の配列。選択した source と実在する行番号を根拠にする
- `hypotheses` / `unknowns`: 推定と未確認事項を別々の文字列配列にする。未確認範囲を空配列で隠さない
- `verification`: `{ "command": "実行したコマンド", "status": "passed", "exitCode": 0, "output": "出力の要点" }` の配列。未実行は `status: "not-run"`、`exitCode: null`、`output` に理由を書く。失敗は `failed` と実際の非 0 exit を記録する
- `nextAction`: 次の担当に判断してほしい問い。記入後に `status` を `ready` または `partial` にする

対象 HEAD・選択した source の作業中の内容・ctx のハッシュが変われば再利用できない。引き渡す前に ctx を再取得して検査する。資料の生成時点から対象が変わったら新しい出力先へ作り直し、変化した事実だけ再確認する。PR は現在の HEAD が PR head SHA と一致する checkout で作る。snapshot と snapshotId は編集しない。

検査結果は `ready` / `partial` / `stale` / `invalid`。`ready` 以外は非 0 exit で、未実行や未確認を完了扱いしない。これは鮮度・形式・根拠参照の検査であり、記述の真偽・コマンドの実行・安全性は証明しない。選択していないファイルの変化も保証外。L2・L3 は論点に必要な一次資料と結果を確認する。独立レビューには L1 の安全性の結論を渡さず、`pr-cross-review` の review pack を使う。

### 効果の回収

最初の数件は issue / PR に「採用した層と model、再利用した根拠、調べ直した範囲、手戻り・User 介入」を短く残す。評価単位は完了 1 件あたりの総消費と再探索・手戻り。`pnpm ai:usage` の Codex は現状未収集なので、0 消費や節約済みと扱わない。Codex の利用量を実測できる経路が揃うまでは、定性的な改善と消費量の主張を分ける。

## 委譲 prompt の骨格

```text
目的: <ユーザーが確認できる outcome>
成功条件: <受け入れ条件>
確認済みの事実: <path / issue / command output>
未確認の仮説: <無ければ「なし」>
触ってよい path: <scope>
禁止事項・権限: <stage / commit / push / external mutation の可否>
検証: <そのまま実行できるコマンドと確認観点>
最終報告: 変更または所見、根拠、検証出力の要点、未確認事項、deferred scope
```

write 可能な委譲は同一 worktree・非重複 scope に限定する。commit / push / external mutation は、依頼側が明示的に委ねた場合だけ含める。

## 反例

- 成功条件を書かず、先に model や agent 数を決める
- 小さく一体な変更を、並列化できないのに分割する
- 「重要なものを選べ」のように比較基準を渡さず判断を委ねる
- CLI で再現できる集計を、自然言語の要約だけで受け取る
- provider の肩書きや価格だけで task を割り当てる
- 委譲先の報告を一次情報と突き合わせず、そのまま完了報告へ使う

## When NOT to Use

- 1 ファイル 1 行の修正、既存パターン追従の単発編集（`AGENTS.md` §委任・報告の作法で足りる）
- issue を worker へ渡す GitHub 側の手順・ラベル操作（`dispatch` skill の領域）
- merge 前のクロスレビュー（`pr-cross-review` skill の領域）
