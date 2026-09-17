---
name: dispatch
description: GitHub issue を worker へ渡す準備をする時、非 feature 作業の issue を新規起票する時、epic の sub-issue 構成や `status:*` ラベルを更新する時、`status:blocked` の凍結 issue への着手が話題になった時、並行作業の定期棚卸し（sweep）や凍結解除を行う時に発動。凍結・衝突チェック、handoff-quality 補強、既存ラベル体系を適用する。issue の中身の実装作業や意思決定ログ作成では発動しない。
---

# Dispatch Skill

feature 開発と並行する非 feature 作業を issue ベースで回す定常運用。どの provider / model でも実行できるよう、判断基準を本ファイルに明文化する。OpenAI / Codex を primary harness とするが、個人メモリや特定モデルの記憶に依存しない。

**正（source of truth）**: 状態は **GitHub issue 自身**が持つ。open / closed に加えて `status:ready` / `status:in-progress` / `status:review` / `status:blocked` / `status:watching` のラベルが着手可否を表し、大きなテーマは `scope:epic` の issue が sub-issues で束ねる。全体俯瞰は rollup issue を読むのではなく、`scope:epic` 一覧 + `status:*` クエリで都度組み立てる。

**rollup tracking issue は廃止した**。経緯は git 履歴参照（#1788）。後継 rollup は作らない。本ファイルは「手順」、issue とラベルが「状態」。

**履歴もコメントに落とす。** dispatch の記録（操作 A 手順 6）に加えて、checkpoint report、判断分岐（推奨と実際の判断が分かれた時は、該当 issue へ分岐コメント + `docs/decisions.md` へ1行、の形で残す。旧 `judgment:diverged` ラベル運用は廃止済み）、レーンからの完了報告も、該当 issue のコメントとして残す。セッションは transcript に状態を持たないため、issue コメントが唯一の永続履歴になる。

## When to Use

以下の状況で発動:

- worker に渡す issue を選定・準備する時（→ 操作 A）
- 非 feature 作業（refactor / security / ops / content）の issue を新規起票する時（→ 操作 B）
- epic issue の sub-issue 構成や、issue の `status:*` ラベルを更新する時
- 定期棚卸し（sweep）や凍結解除（unfreeze）を明示依頼された時（→ 操作 C / D）
- 提案・plan の中に `status:blocked` 付き issue への着手が含まれているのを検出した時（凍結違反の防止）
- issue 化されていない作業（監査ログの残タスク、alert、会話中の口頭依頼）がセッション内に現れた時

## When NOT to Use

- 各 issue の中身の実装作業そのもの（issue 本文の受け入れ条件と、該当する project skill に従う）
- 意思決定ログの作成（`decision` skill の領域）
- feature 実装 plan の策定（`AGENTS.md` §実装 Plan の必須セクション に従う。dispatch は「誰に渡すか」だけを扱う）

## 操作 A: dispatch — issue を worker に渡す

1. `gh issue list --milestone <現行milestone> --label status:ready --state open` で候補を選ぶ（ユーザー指定があればそれを優先）。milestone 内が空なら `--label status:ready --state open` 全体から。テーマ単位で見たい場合は該当 `scope:epic` issue の sub-issues から絞る。**`gh issue list` は既定で open のみ返すが、epic issue のコメント経由・issue 番号の直指定など一覧以外の経路で得た候補にはこの既定が及ばないため、次の state 確認（手順 4）を必ず通す**
2. **束ね**: 関連する issue（同一 area / 同一機能系統）は 1 worker セッション・1 branch・1 PR にまとめて渡す（`AGENTS.md` §PR / git 運用）。1 issue ずつ切り出さない
3. **衝突チェック**: 候補 issue が触るファイル・ディレクトリを、(a) 進行中 epic issue 本文（例: #1754 の該当 Step）の対象、(b) 他の in-progress issue（`status:in-progress` ラベル）の対象、と突合する。**重なる場合は同一 worker に束ねて直列処理するのを第一候補**とする（衝突回避が目的なら束ねる方が安全かつ安価）。束ねられない場合だけ次の候補へ
4. **凍結・state チェック**: `status:blocked` が付いていないこと、かつ候補 issue の `state` が OPEN であることを確認する。state は `gh issue view <N> --json state` の実測を根拠にする（close 済み issue にも `status:ready` 等のラベルが残留しうるため、**ラベルは state の代わりにならない**）。束ねた場合は全 issue について両方確認する。1 つでも凍結 or close 済みなら、その issue だけ束ねから外す（#1957）
5. issue 本文を **handoff-quality** に補強する（下記テンプレート）。worker が repo 探索なしで着手できる密度が基準
6. `status:ready` を `status:in-progress` へ差し替え、**その issue 自身**にコメントで dispatch 先（session / agent / provider）と scope を記録する。束ねた場合は代表 issue にコメントし、他は代表へリンクする。**この着手のタイミング（レーンへの割り当て、または PR の Closes に載せた時点）で、対象 issue に現行 milestone を付与する**（編成時(操作 B 手順 5)の判断とは独立に、着手＝付与を機械的に行う。#2006）。**レーンが draft PR を作成した時点で、PR 自身にも現行 milestone を付与する**（issue 側だけでなく PR 側にも付いていると release notes 作成時の集計が楽になる。#2065）。**差し替えたら `pnpm ctx <N> --post` を実行して brief（関連 PR / 触るファイル / 保護対象の要否 / 決定ログ / 次の一手）を issue コメントへ置く**（worker は issue URL しか受け取らないので、最初の turn より前に選別・圧縮済みの文脈を届ける。再実行すると同じコメントを更新する。`routing` skill）。**この dispatch コメントに DoD（完了の定義）を 1〜3 行で記載する**（「仕様には適合しているが意図とズレている」静かな失敗は着手時点の意図と突き合わせないと見つからない。束ねた場合は代表 issue のコメントへ一括で書く。突き合わせは PR レビュー時と、ズレを疑った時に行う。[#2273](https://github.com/Dayopt/dayopt/issues/2273)）
7. worker への指示は issue URL + 「本文の受け入れ条件と検証コマンドに従う」だけで済む状態にする。着手手順・PR 規約・報告テンプレート・検証原則はチップ prompt へ個別に書き下さず `AGENTS.md` §レーン運用 への参照 1 行で足りる

### handoff-quality テンプレート（issue 本文に含める 4 要素 + 任意 1 要素）

```markdown
## 背景 — なぜやるか。関連 issue / docs / 過去 PR へのリンク

## やること — 番号付き手順。対象ファイル path を明記。**受け入れ条件（何ができたら完了か）を 1 行以上**。外部リサーチが要る時は「外部リサーチ: <問い / 必要な一次資料 / 出力形式>」を 1 行書き、結果が前提なら `status:blocked`。provider は固定せず、結果を issue コメントへ残す

## 注意 — 既知の罠、触ってはいけない領域、関連 skill（例: supabase skill のフロー）

## 検証 — pass すべきコマンド（pnpm check 等。**そのまま実行できる形**で書く）と確認観点

## 期待出力（該当時のみ）— 返してほしい形式。分類軸、判断ごとの証拠水準、撤退・rollback 条件の明示要求
```

**「## やること」で原因・機構に触れる記述には証拠水準ラベルを必須にする**（[#2428](https://github.com/Dayopt/dayopt/issues/2428)）。「なぜそうなるか」「どう直るか」の記述は、`推定（未実測、issue本文由来）` か `実測（コマンドと出力を併記）` のどちらかを明記する。番号付き手順という命令形の書式には、起票者が未実測の推定をそのまま手順として書く誘導がある（実例: #2417 / #2419）。ラベルがあれば、レーンは §着手手順 の復唱で「推定」箇所だけを狙って着手前に実測できる。**ラベルを付けさえすれば推定を書いてよい、という逃げ道にしない** — 実測できる推定は起票前に実測してから書く。実測コストが高い（外部サービス往復・本番環境限定等）場合に限って `推定（未実測、issue本文由来）` を使う

**「## 期待出力」はレビュー / 調査 / spike 系の issue でだけ書く**（[#2468](https://github.com/Dayopt/dayopt/issues/2468)）。`type:spike`・反証レビュー依頼・監査系のように成果物がコードではなく判断である issue は、出力形式が受け手任せだと要約の粒度と証拠水準がぶれる。依頼側が先に契約（分類軸、判断ごとの repo 証拠、最小差分、rollback・撤退条件、「やらない方がいい改善」の明示など）を固定すると往復が減る（実例: #2453）。**実装系 issue では省略する** — 「## 検証」が出力契約を兼ねるため、埋めても空欄か形式的コピペになる。

### `status:ready` の定義（機械判定）

**上記テンプレートの必須 4 セクション（背景 / やること / 注意 / 検証）がすべて埋まっていない issue には `status:ready` を付けられない。**（「## 期待出力」は optional なので判定条件に入らない。）**加えて §やること に受け入れ条件、§検証 に実行できる検証コマンドが書かれていること**（`pnpm ctx <N>` の「判断の記録」行の あり / なし で機械判定する）。空見出しや「TBD」のまま残っている issue は `status:blocked` または無ラベルのままにする。この判定は主観の運用ルールではなく、`status:ready` を付けるすべての操作(操作 B 手順 4、操作 D 手順 2、sweep での戻し)の前提条件として扱う。

### 渡し方の判断（束ねた後の内容で毎回判定する）

`size:*` ラベルには依存しない（`size:*` は deprecated。操作 B 手順 3 参照）。編成のたびに issue 本文の内容から次の 3 区分のいずれかを判定する:

- **直接実装**: 手順が既存パターンの追従で完結する。plan 不要
- **plan 先行**: 複数ファイル・複数 Step にまたがる、または既存 contract に触れる。worker に `AGENTS.md` §実装 Plan の必須セクション に従った plan を先に出させてから実装。複数 issue を束ねた PR は merge 前に `pr-cross-review` skill による advisory クロスレビューを受ける対象になりやすい（merge を止めるものではない）
- **裁定 session で実施**: spike / 設計判断を含む issue、または `risk:authority` が付いた issue。権限・比較・rollback を判断できる担当が実施し、provider の model tier 名では固定しない

## 操作 B: intake — 新しい作業を issue 化する

作業依頼・発見事項・監査結果が issue の外にある状態を作らない。

Chat 等への外部依頼で生じた調査結果も、まず既存の対象 issue へ記録する。[Chat 連携手順](../../../docs/operations/chat-handoff.md) の依頼IDと投稿URLで照合し、調査結果の保存を採用・実装承認と混同しない。指定 issue へのコメント権限から、新規 issue 作成・本文変更・状態変更の権限を推定しない。新規起票を委ねる場合は repository、件数上限、対象範囲と本操作 B の規約を渡す。再送前には同じ依頼IDの投稿を確認し、既存ならそのURLを再利用する。

1. `gh search issues` で既存 issue との重複を確認（close 済み含む）
2. 重複なら既存 issue に本文追記 or コメントで統合。新規なら handoff-quality で起票。**RLS ポリシー・テナント境界・スキーマ変更に関わる起票では、攻撃シナリオ生成が issue の品質を実質的に上げる場合だけ、別 context の read-only reviewer に依頼し、出力を「## テストすべき攻撃シナリオ」として本文に貼る**。OpenAI / Codex の CLI adapter 例:

   ```bash
   codex exec --sandbox read-only \
     "supabase/migrations/ 配下のスキーマと RLS ポリシーを読み、
      テナント越えの読み書きができてしまう可能性のあるクエリ・操作パターンを
      10個列挙せよ。それぞれ悪用手順を1行で添えること。"
   ```

   同等の read-only reviewer を利用できる runtime では、上記 command の代わりに同じ prompt・scope・出力契約を渡してよい。出力をチケット本文に貼り、到達可能なシナリオだけをテスト候補へ残す。呼び出し失敗・タイムアウト時はスキップして本来のフローを続行する（best-effort）

   **これは起票時の攻撃シナリオ生成であり、実装の着手可否を決める gate ではない。** 本文を厚くするための best-effort な補助で、外部 provider の可用性を前提にしない

3. ラベルは既存体系のみ使う: `type:*` / `priority:*` / `area:*` / `quality:*` など、掲載一覧（[github-labels.md](../../../docs/operations/github-labels.md)）にあるものだけ。`size:*` は **deprecated**（新規 issue には付けない。既存 issue から剥がしはしない）。新ラベルを作らない
4. `status:*` で着手可否を表す（着手可なら `status:ready`。`status:ready` を付けられる条件は §`status:ready` の定義（機械判定）に従う。前提待ちなら `status:blocked`）。既存テーマに属するなら該当 `scope:epic` issue の sub-issue にする。最上位ティア専用 / 🔒 prod 操作である旨は issue 本文の §注意 に書く。issue の実行自体に `EXPLICIT AUTHORITY` の不可逆操作（production mutation / release / データ削除 / 不可逆 migration / 実課金。`AGENTS.md` の authority level 定義）が含まれる場合に限り `risk:authority` を付け、実行前に User の明示指示を得る。可逆な auth / RLS / billing のコード変更には付けない（`pr-cross-review` skill での確認と、必要に応じた `CHECKPOINT` で扱う）
5. **milestone を判断する**: 現行 milestone（次の minor version。open は常に 1 個、世代交代は releasing skill Phase 3.1）に入れて押し込む作業なら milestone を付ける。付けなければバックログ。「next」milestone は作らない

## 操作 C: sweep — 定期棚卸しで gap を検出する

頻度の高い項目は日次で吸収する。頻度が低い・外部サービス往復を要する項目だけ月次 backstop として `/gardening` に残す。同じ項目を両方に重複させない。朝編成は廃止済み（#2525）。

### 日次盤面 issue は廃止（[#2525](https://github.com/Dayopt/dayopt/issues/2525)）

**レーンの進行状況は、各 issue / PR 自身のコメントが正本**（冒頭の「正（source of truth）」と同じ原則。日次盤面 issue は写しに過ぎず、二重管理と更新漏れの温床だった）。俯瞰が要る時は都度クエリで組み立てる:

- ready キュー: `gh issue list --state open --label status:ready`
- 走行中レーン: `gh issue list --state open --label status:in-progress` と `gh pr list --state open`
- 要判断: `gh issue list --state open --label type:discussion` / `--label status:blocked`
- 本日の実績: `gh pr list --state merged --search "merged:>=<YYYY-MM-DD>"`

### 日次（issue / PR の状態で確認）

- [ ] open PR で 2 週間以上動きがないものの扱い（rebase / close / 引き継ぎ）
- [ ] worktree・ブランチの残骸: `git worktree list` / `git worktree prune` / `git branch --merged main`（手順は `AGENTS.md` §PR / git 運用）
- [ ] 現行 milestone の中身が実態と合っているか（停滞 issue を外してバックログへ / milestone 外で進んでいる作業を入れる）。**検査基準: open PR の Closes 対象 issue と `status:in-progress` issue はすべて現行 milestone に入っているか。open PR 自体にも milestone が付いているか（#2065）**
- [ ] `status:in-progress` の棚卸し（レーンが動いていない issue を `status:ready` へ戻す、または `status:blocked` に落とす）
- [ ] Supabase の残存 preview branch 確認（δ 運用でコストが Spend Cap の対象外のため、閉じ忘れた branch は課金が止まらない。閉じた PR に対応する branch が残っていないかを毎朝見る）

### 月次 backstop（`/gardening` と同時期に実施）

以下の「issue の外に作業が溜まりやすい場所」を機械的に確認し、見つけたら操作 B で起票する:

- [ ] Supabase advisors: `get_advisors`（security / performance）の WARN が issue 化されているか
- [ ] Dependabot security alerts: `gh api repos/Dayopt/dayopt/dependabot/alerts?state=open` が 0 件か
- [ ] NOT_PLANNED で close された issue の中身が、実は未完了のまま受け皿を失っていないか
- [ ] 生成系スクリプト（`api:spec` / `types:generate` / `rls:snapshot`）が現在も exit 0 で通るか

## 操作 D: unfreeze — 凍結解除の判定

`status:blocked` の issue は、本文に書かれた解除条件（例: time-model-split Step 8 cutover 完了）を満たしたときのみ解除する。解除条件が本文に無い issue は、解除前にまず条件を本文へ書く。

1. 解除条件の達成を設計書・merge 済み PR で確認する
2. `status:blocked` を `status:ready` へ差し替え、**着手前に設計を現状に合わせて見直す**コメントを残す（凍結中に前提が変わっているため、本文の対象ファイル・手順は書き直し前提）
