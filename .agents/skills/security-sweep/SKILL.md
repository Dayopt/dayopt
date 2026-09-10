---
name: security-sweep
description: security sweep の実行を明示依頼された時、月次ガーデニングの sweep 周期、`/claude-security` の所見を候補集合として記録する時、中断した sweep を再開する時に発動。scope と SHA を pack で固定し、researcher / critic / reproducer の envelope を機械検査する provider 非依存の advisory。実装では発動しない。
effort: medium
maxTurns: 25
---

# security sweep

PR の差分ではなく、**1 つの SHA における scope** を読む security 調査の標準手順。provider を問わず同じ pack を入力にし、同じ envelope を出力にし、同じ機械検査で判定する。

merge gate ではない。所見は issue と PR コメントに残す。`/claude-security` は Claude を使う時の任意の加速器であり、この手順の必須要件ではない（plugin が無い環境でも完走できる）。

## When to Use

**明示発動型** — 通常のコード変更では発動しない。次の explicit な契機だけを扱う。

- User が security sweep の実行を依頼した時
- `/gardening` の月次セキュリティ sweep で、advisors と `pnpm security:check` の先に深掘りを行う時
- `/claude-security` を回した後、その所見を候補集合として記録・再検証する時
- 上限や中断で途中終了した sweep を、未判定の候補から再開する時

## When NOT to Use

この skill は **explicit な sweep 意図のみを契機とする**。暗黙的な invocation ケースは該当なし（型の穴埋めとして明記）。参考として近接するが発動しないケース:

- PR の diff を merge 前に読む → `pr-cross-review` skill の領域
- 実装中に認可・RLS・入力検証の観点を確認する → `security` skill の領域
- 依存の脆弱性を確認する → `pnpm security:check` と Dependabot（`docs/operations/security.md` の層マップ）
- 所見を issue にする → `dispatch` skill の intake

## 前提

- `docs/engineering/threat-model.md` が対象境界を含んでいること。含んでいなければ先に書く。攻撃面の記述は毎回**現在のコードと照合**し、不足した関連範囲を「未検査」として明示する
- pack を作る SHA は commit 済みであること。未コミットの編集は pack に入らない

## 手順

### 1. scope と成功条件を固定する

**1 つの信頼境界に絞る。** repo 全体を 1 回で通そうとしない（2,634 ファイルの全体スキャンはセッション上限に当たる実測がある。`docs/operations/security.md`）。

context.md に次を書く。ここが後で「何を読ませなかったか」の正本になる。

- この run の目的と、なぜその境界を選んだか
- scope に**入れなかった**関連範囲と、その理由
- 評価目的の run なら、入力から意図的に外したもの（既知の所見、issue、修正履歴）

### 2. pack を作る

```bash
pnpm review:sweep \
  --at <commit-ish> \
  --scope <repo 相対 path（ディレクトリ可、複数指定可）> \
  --context <context.md> \
  --threat-model docs/engineering/threat-model.md \
  --out <新規ディレクトリ>
```

pack は targetSha、scope の展開結果、source snapshot、role ごとの prompt と schema を manifest に固定する。`baseSha` / `headSha` は持たない。binary・不在・1 MiB 超は `omissions` に記録されるので、**0 件や「確認済み」と解釈しない**。

出力先は新規ディレクトリ。既存へは上書きしない。

### 3. researcher を回す（read-only）

pack 内の `security-researcher.prompt.md`、`security-researcher.schema.json`、`sources.json`、`context.md`、`threat-model.md` を provider へ渡す。reviewer は read-only で実行する（資料を読む `cat` / `rg` / `git show` は可。コード実行・test・install・state 変更・nested agent は不可）。

結果は次の envelope で保存する。

```json
{
  "packId": "<manifest の packId>",
  "targetSha": "<manifest の targetSha>",
  "provider": "<実際に使った provider>",
  "model": "<実際に使った model>",
  "modelFamily": "<model family>",
  "sessionId": "<session ID>",
  "independence": "separate-session",
  "role": "security-researcher",
  "result": {}
}
```

**provider / model / sessionId は実測値を書く。** 不明値を空文字や推測で埋めない。`baseSha` / `headSha` は入れない（入れると PR envelope の流用として落ちる）。

### 4. 候補集合を確定させる

```bash
pnpm review:validate --pack <pack> --result <researcher.json> --emit-candidates <run-dir>/candidates.json
```

`candidateSetHash` と各候補の `signature` は**生成側が導出する**。reviewer の申告を採らない。UUID でない candidateId、同一 run 内の重複はここで落ちる。

`/claude-security` の出力を候補集合へ変換する場合は、元の出力（`CLAUDE-SECURITY-<timestamp>/`）を run dir へ残し、`candidateId` と元 finding id の対応表を併置する。変換で候補が減っていないことを件数で確かめる。

### 5. critic を回す（read-only）

`candidates.json` を prompt と一緒に渡す。critic は**入力の全候補に verdict を返す**。

```bash
pnpm review:validate --pack <pack> --result <critic.json> --candidates <run-dir>/candidates.json
```

**`rejected` と `undetermined` には `counterevidence` が要る。** `confirmed` には要らない（落とす判断にだけ反証を求める）。

分割実行した場合は `--result` を複数回渡して合流させる。

```bash
pnpm review:validate --pack <pack> \
  --result <critic-round1.json> --result <critic-round2.json> \
  --candidates <run-dir>/candidates.json
```

### 6. reproducer を回す（実行可、隔離環境）

critic が `needs-execution` とした候補だけを対象にする。

**隔離条件**（この手順の保証境界）:

- 作業 worktree とローカル Supabase（`127.0.0.1:54321`）だけを使う
- production の credential を持たない。`op run` と `.op-env.*` を消費しない。cloud サブコマンドを使わない。`E2E_ALLOW_NONLOCAL_SUPABASE` を設定しない
- 再現は既存の test 基盤（`*.integration.test.ts`）の test ファイルとして書く。任意コード実行の PoC は作らない

**この隔離は container ではない。** Mantis の「host 実行禁止」より弱い。弱くてよいと判断したのは、Dayopt の候補が TS / SQL の到達可能性であって任意コード実行を伴わず、既存の integration 基盤で再現できるため。最終の壁は `apps/product/src/lib/test/service-role-target-guard.ts`（production project ref を opt-in でも拒否する）と `AGENTS.md` の EXPLICIT AUTHORITY で、この skill の記述ではない。

status は 5 択で、**到達証拠のない失敗を `failed-to-reproduce` にしない**。ビルド失敗・setup 失敗・コマンド不在からの negative は `not-run`、環境が揃わない場合は `environment-missing` へ落とす。

`reproduced` と `failed-to-reproduce` は「実際に実行した」という主張なので、`command` と `testPath` の両方を要求する（`reachedTargetPath` の自己申告だけでは通らない）。`review:validate` がこの条件を機械で落とす。

**reproducer の母集合は critic envelope から再計算する。** 実行待ち集合をファイルとして残さないのは、分割した critic の round1 だけで書いた部分集合が古いまま残り、round2 の `needs-execution` が母集合にも `missing` にも現れないまま `reviewed` に到達しうるため。

```bash
pnpm review:validate --pack <pack> --result <reproducer.json> \
  --candidates <run-dir>/candidates.json \
  --verdicts <critic.json> [--verdicts <critic-round2.json>]
```

分割した critic envelope は**すべて**渡す。裁定が全候補に届いていない critic に対しては、reproducer だけを `reviewed` にできない。

### 7. 裁定して記録する

`review:validate` の status は次を区別する。**どれも「指摘 0 件」と数えない。**

| status     | 意味                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-run`  | envelope が無い                                                                                                                                                                                       |
| `stale`    | packId / SHA が pack と一致しない                                                                                                                                                                     |
| `partial`  | (a) 判定が返っていない候補がある (b) 判定は返ったが裁定が決まっていない（critic の `undetermined`、reproducer の `not-run` / `environment-missing`） (c) reviewer が coverage=partial を申告した      |
| `reviewed` | schema と入力整合性が確認できた。**品質の合格ではない**                                                                                                                                               |
| `invalid`  | schema 不一致、別 run の候補集合、集合外 id、食い違う判定、到達証拠のない失敗、`reproduced` / `failed-to-reproduce` の command / testPath 欠落、裁定が全候補に届いていない critic に対する reproducer |

`partial` の理由は `reasons` に分けて出る。**(a) と (b) を混同しない** — 全候補を `undetermined` にした critic は「指摘 0 件」ではなく「何も裁定していない」。

`confirmed` の候補は `AGENTS.md §レビュー規則` の P1 / P2 に正規化し、`dispatch` skill の intake で起票する。修正へ進む場合は別 PR とし、**回帰 test が修正前の SHA で fail し、修正後に pass すること**と、正当な操作を妨げないことを PR に証跡として添える。

`rejected` は捨てない。`docs/engineering/threat-model.md` の却下記録へ、`targetSha`・成立前提・反証・**再評価条件**を書いて残す。将来のスキャンを無条件に免除するルールにはしない（対象 path が変わった、前提が変わった、別 SHA で再出現した場合は再び候補として扱う）。

reflect（threat model の更新）は正本への直接追記ではなく、**PR の diff としてレビューする**。

### 8. summary を残す

issue / PR コメントに次を書く。

```text
[sweep-summary]
targetSha: <40 hex>
scope: <path 数と代表 path。除外した関連範囲>
provider: <実測> / model: <実測>
candidates: <件数> / confirmed: <件数> / rejected: <件数> / needs-execution: <件数>
reproducer: reproduced <n> / failed-to-reproduce <n> / statically-confirmed <n> / not-run <n> / environment-missing <n>
status: researcher=<status>, critic=<status>, reproducer=<status>
未確認: <partial の中身と、scope から外した領域>
```

**scope から外した領域は「見て問題なし」ではない。** 所見ゼロを clean と読む前に、除外範囲と `omissions` を先に書く。

## provider adapter

pack と envelope と `review:validate` が共通要件で、orchestration は provider の裁量に置く。

| provider           | researcher / critic                                                                                          | reproducer                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| OpenAI / Codex     | role ごとに read-only の別 session。pack のファイルを渡す                                                    | 隔離条件を満たす session で test を実行 |
| Claude Code        | read-only subagent。`/claude-security` を researcher の代替に使ってよい（出力は手順 4 で候補集合へ変換する） | 同上                                    |
| その他             | 同じ pack と envelope を手で受け渡す                                                                         | 同上                                    |
| 反証を足したい場合 | 別 provider で critic をもう 1 本回し、`--result` で合流させる                                               | —                                       |

**固定 model や専用 tool を共通要件にしない。** provider の可用性を sweep の実施条件にもしない。

## 参考

| ファイル                             | 用途                                               |
| ------------------------------------ | -------------------------------------------------- |
| `docs/engineering/threat-model.md`   | 信頼境界・攻撃面・既往クラス・却下記録             |
| `docs/engineering/invariants.md`     | 不変条件の正本                                     |
| `docs/operations/security.md`        | レビュー体制の層マップと `/claude-security` の実測 |
| pack 内の `*.schema.json`            | role ごとの result schema（pack が同梱する）       |
| `scripts/ci/protected-path-gate.mjs` | 外部契約 or 不可逆な path の目安                   |
| `AGENTS.md §レビュー規則`            | P1 / P2 の正本                                     |
