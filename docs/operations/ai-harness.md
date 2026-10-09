---
status: current
last_verified: 2026-10-09
code:
  - AGENTS.md
  - .claude/settings.json
  - scripts/hooks/pre-tool-guard.mjs
  - scripts/hooks/pre-tool-guard-rules.mjs
---

# AI 協働ハーネス

Dayopt で AI agent が作業する仕組み（指示の正本、skill、hook、実行環境、レビュー）の現在の構成。開発 harness は Claude Code。secret の境界は [secrets.md](./secrets.md)、外部サービスへの経路は `mcp-usage` skill を正とする。

## 1. 正本と互換 adapter

- 実装・調査・レビューの共通ガイダンスは `AGENTS.md` を正本とする。判断層・Dayopt の不変条件・authority level は provider に依存しない
- project skill の実体は `.agents/skills/*/SKILL.md` に置く。`.claude/skills` は Claude Code が同じ実体を見つけるための相対 symlink で、複製ではない
- `CLAUDE.md` は `@AGENTS.md` を import する互換 adapter。provider 固有の設定を共通ガイダンスへ逆流させない。framework が書き出す指示ファイル（Next.js の `agentRules` など）も無効にして、正本へ混ぜない
- runtime / tool 固有の command が必要な skill は、共通の目的・scope・出力契約を先に書き、command を optional adapter として示す

## 2. Routing の基準

通常開発は Claude Code。共通指示は `AGENTS.md`、作業方針・Issue Brief・委譲の手順は `.agents/skills/routing/SKILL.md` を正本とする。同じ主担当が調査・判断・実装・検証・修正まで完了する。

Chat は product / UX・research・仕様整理、Claude Code は repo に基づく判断と実装を担う。受け渡しが必要な時だけ [Chat 連携手順](./chat-handoff.md) を読む。承認済みの目的・仕様・リスク境界内の技術判断を毎回 Chat に戻さない。

subagent の model は project 設定で既定を固定する。`.claude/settings.json` の `env.CLAUDE_CODE_SUBAGENT_MODEL=sonnet` が general-purpose・teammate・独自 agent の既定で、built-in の Explore は `.claude/agents/explore.md`（haiku）、Plan は `.claude/agents/plan.md`（sonnet）で上書きする。Agent tool の `model` 引数と agent 定義の `model:` はこの既定より優先されるので、重い設計・レビューだけ呼び出し側で明示して上げる。主会話の model は固定しない。`pnpm ctx` の L0〜L3 / preparation は助言として維持し、別 agent の起動指示にしない。

open PR の本数は制限しない。独立した Issue は別 PR にし、作業中の小さな別件だけを同じ PR に含める（`AGENTS.md` §PR / git 運用）。

## 3. Hook と保証境界

判定ロジックは `scripts/hooks/pre-tool-guard-rules.mjs`、入口は `scripts/hooks/pre-tool-guard.mjs` で、`.claude/settings.json` の PreToolUse から呼ぶ。止める 5 規則の一覧は [エージェントの仕組み](../learn/system/agents.md)。

hook は事故を減らす speed bump で、境界の本体は token の到達範囲（[secrets.md](./secrets.md)）。adapter の script が存在するだけでは tool call は止まらない。runtime 側で実行前 hook として登録・起動され、block 結果を尊重する必要がある。repo は user-global 設定、直接 shell、User 自身の UI 操作、未知の tool surface を強制できない。

**guard が壊れた時の挙動**: 1 ファイル構成では構文エラーで guard が全操作を止め、直す編集まで塞ぐ。そこで薄い loader（`pre-tool-guard.mjs`）と実ロジック（`pre-tool-guard-rules.mjs`）の 2 ファイルに分けている。loader は毎回 rules を `import()` し、判定は allow のみ 0、他はすべて 2 へ写す（実行時エラーでも fail closed）。import に失敗した時は fail closed を既定にしつつ、**rules ファイル自身への Write / Edit だけ**を復旧目的で通す。契約は `scripts/__tests__/pre-tool-guard.test.ts` の「loader/rules 分離」describe が固定する。

`pnpm agent:preflight`（機械利用は `--json`）は依存、Git hooks、CLI、skills、`.claude/settings.json` への guard / SessionStart の登録、1Password の token の有無、gh identity を確認する。runtime の trust や実際の hook 発火は判定できない。

### Local / Cloud の実行環境

Node.js と package manager は実行場所ごとに暗黙で選ばせず、repository contract に揃える。

- `.nvmrc` と `package.json#packageManager` が runtime の正本。`pnpm agent:preflight` は不一致なら原因と直し方を 1 行で出して exit 1 にする
- ローカルで Node 24 に自動で揃えるには fnm を使う（User 作業。shell 設定は repo 外）。`brew install fnm` の後、`~/.zshrc` に `eval "$(fnm env --use-on-cd --version-file-strategy=recursive)"` を追記し、新しい shell で repo に入って `fnm install` を実行する。入れるまでは `PATH=/opt/homebrew/opt/node@24/bin:$PATH` を前置する
- `pnpm dev` は Docker と local Supabase を前提にする（[#3058](https://github.com/Dayopt/dayopt/issues/3058)）。Docker 無しで動かす経路は env を明示して渡す `pnpm dev:raw` で、product の動作確認は Vercel Preview で行う（[#2910](https://github.com/Dayopt/dayopt/issues/2910)）
- 手元の UI 確認は `pnpm storybook`、静的 build は `pnpm build-storybook`。既存 mock を使い、アプリ Secret・1Password・Local Supabase を要求しない
- DB 型取得は `pnpm types:generate --target preview --project-ref <ref>` 等で対象を指定する。省略時に本番へ接続しない。環境構成は [infra.md](../engineering/infra.md#cloud-firstへの移行契約2910継続中) を読む
- `pnpm branch:finish` は linked worktree なら削除する。通常 checkout は未保存差分がなく、local / remote の先端が PR の head と一致し origin/main へ到達していることを確かめて detach し、ディレクトリを残す。他の作業が使う checkout は切り替え・削除しない

### Claude Code cloud の実行環境

Claude Code on the web（`CLAUDE_CODE_REMOTE=true`）もローカルと同じ repository contract に従う。2026-10-09 に cloud session で実測した（[#3051](https://github.com/Dayopt/dayopt/issues/3051)）。environment の設定手順は [サービス別手順 §1Password](./secrets-services.md#claude-code-cloud)。

| 項目             | 実測（2026-10-09）                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Node / pnpm      | setup script で Node 24 と pnpm 11.26.0 を入れると `.nvmrc` / `packageManager` と一致する。既定 image は Node 22  |
| 1Password        | environment 変数 `OP_SERVICE_ACCOUNT_TOKEN` で `op whoami` が SERVICE_ACCOUNT、`op vault list` が `agent` の 1 件 |
| GitHub           | `gh api`（REST）と `gh pr view`（GraphQL）がともに通る。branch push は pre-push hook を通って成功する             |
| 依存と Git hooks | `scripts/hooks/session-start.sh` が `pnpm install --frozen-lockfile` を実行し、husky の `prepare` で hook が入る  |

- environment の変数は session 内の全コマンドから読め、値はマスクされず、その environment を使える人は誰でも読める。SA token と fine-grained PAT 以外を置かない
- Network access の既定 allowlist は `*.1password.com`・`*.vercel.app`・`*.supabase.co`・`sentry.io` を含まない。必要な host だけを Custom で足し、本番の書き込み先は足さない。1Password 以外の host の到達は未実測
- `~/.claude.json` の MCP server は cloud に引き継がれない。claude.ai のコネクタは引き継がれるが、使うのは dayopt 自身のコネクタだけ（`mcp-usage` skill）
- Cloud で Docker・local Supabase・実ブラウザが必要な検証は完了扱いにせず、対応する local または CI の証跡を別に残す。`supabase start` は使わない（[infra.md](../engineering/infra.md#agent-work-と任意の-local-development)）
- cloud での `pnpm branch:finish` は未実測。止まった時は [#3031](https://github.com/Dayopt/dayopt/issues/3031) の結論に従う

### 実行経路ごとの保護範囲

「機械」は Claude Code が hook を信頼・発火した場合の判定を指す。

| 分類・操作                                          | Claude Code での扱い                                              |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| 秘密情報: `.env` 系の読み書き、1Password の実値表示 | Read / Write / Edit と Bash の個別パターンを機械検査              |
| 破壊的操作: origin/main の migration・他 worktree   | Write / Edit と `rm -r` を機械検査。任意の shell 編集は保証外     |
| Git 運用: force push、`reset --hard`、`--no-verify` | Bash の列挙パターンを機械検査                                     |
| 大量の読み取り調査                                  | scope を runtime で強制できないため、read-only を前提に委譲しない |

**shell の任意編集は機械的に閉じていない**。`sed -i`、`perl -pi`、`cp`、`mv`、`tee`、出力redirect、任意scriptによる既存migration・他worktreeへの書き込みを、このadapterは一般には検出しない。ファイル変更は原則 Write / Edit を使い、shell編集へ切り替えてこの検査を迂回しない（指示による制御）。hookに到達しただけで全操作が保護されるわけではない。write_stdin、hosted/specialized tool、wrapper内部の処理も同じ保証を持たない。

この境界はshell interpreterの自作で埋めず、runtimeの書き込み範囲・Git hooks/CI・最小権限の資格情報で補う。本番は既存の明示権限・独立レビュー・dry-run/backupを維持する。上記が不足する操作は未対応として扱い、通常開発の実動試行でも境界を確認する。

### 実測で分かった罠（guard / hook / scripts）

2026-09-22 に Claude Code の memory から昇格。

- **guard は「言及」でも止まる**。判定は tool call の command 文字列全体を見るので、禁止コマンド名を説明する commit message / issue コメント / review reply の heredoc も同じ文字列一致で止まる（2026-08-24 #2293 で 4 回）。これは意図した trade-off で guard 側を緩めない。本文はファイルへ書いてから `gh ... --body-file` / `git commit -F` で渡し、言い回しを変えて該当句の連続を崩す
- **textual guard は shell 展開を捕まえられない**。quote 剥がしで allowlist を補強しても `$'\x2d\x2d...'` や `${IFS}` は素通りする（#2291 PR #2309）。動的引数のコマンドを許す時は「値をコマンドラインに載せない」方向へ寄せる（body は固定パスの `--body-file`、`--repo` は値ごと固定）。展開形を 1 つずつ追いかけない
- **壊れると自分の編集まで止まるファイル（hook script / `.claude/settings.json`）は scratch 先行で触る**。構文エラーでも exit 2 が「止める」と解釈され、直す編集自体ができなくなる（2026-08-12）。scratch に候補を書き `bash -n` と実挙動を通してから `cp` で設置する。復旧は別 session か User に `git -C <worktree> checkout -- <path>` を 1 コマンド依頼する
- **migration guard は `refs/remotes/origin/main` の tree に載っているファイルだけを止める**（#2185 PR #2714）。未 merge の PR にしか無い migration は push 済みでも編集できる。止まったのに未 merge のはずなら `git fetch origin main`。判定不能（ref 不在 / git 不動）は全部止める
- **root `package.json` の script を改名・統合する時は permission allowlist を両方向で見る**。消す側が wildcard に一致して許可され、残す側が漏れて prompt に落ちる向きが本当の failure（2026-08-18）。統合後の名前を実際に叩いて prompt が出ないか確認し、消した名前の pattern は同時に削る（許可範囲は広げない）
- **`scripts/` に新規ファイルを足して docs から名指しすると taxonomy test が `runbook` 判定にする**（`classifyHits` は docs の言及を importedBy より先に見る）。`scripts/lib/` の純粋な lib でも落ちるので、`scripts/__tests__/scripts-taxonomy.test.ts` の `KNOWN_PLACEMENT_EXCEPTIONS` へ理由つきで追記する（2026-09-16 #2775 で 2 回）
- **skill の効果は発動条件と揃えた依頼でしか測れない**。既存 migration の「レビュー」依頼では両条件とも `supabase` skill を読まず「効果なし」と誤判定しかけた（#2810）。どの skill が読まれたかは実行ログ（Claude Code は transcript の Skill / Read の tool 呼び出し）から `.agents/skills/<name>/` を grep して機械的に取る。自己申告は根拠にしない

## 4. Skill 設計

新規・更新時は `.agents/skills/skill-design/SKILL.md` に従う。description / When to Use は provider-neutral にし、特定 model の名前を発火条件や必須 tier にしない。provider 固有の adapter は capability、scope、出力契約、generic fallback、実際の保証境界を併記する。

## 5. 外部 skill の導入一覧

外部 skill は **Dayopt 向けの調整版**として取り込む。公式原文そのままではなく、上流を fork した配布物でもない。runtime にリモートを取得する構成（上流の `web-design-guidelines` が `main/command.md` を毎回 fetch する形）は採らず、下表の commit SHA で固定したスナップショットを正本にする。

| Dayopt skill             | 上流                                                                                                         | 固定 commit SHA                            | 取得日     | License / 表示                                                                                           | 取り込んだファイル                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `react-performance`      | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/react-best-practices/rules/` | `063bee94c3f4df8453406c830b0a7df0f2860278` | 2026-09-17 | LICENSE ファイル無し。README と SKILL.md frontmatter が MIT を宣言。**転記すべき著作権表示は存在しない** | `references/async.md`（async 系 6 本）、`references/bundle.md`（bundle 系 6 本） |
| `ui-audit`               | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `command.md` | `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1` | 2026-09-17 | MIT, Copyright (c) 2025 Vercel Labs（表示を各ファイル冒頭に保持）                                        | `references/web-interface-guidelines.md`                                         |
| `diagnosing-bugs`        | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/diagnosing-bugs/`              | `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260` | 2026-09-17 | MIT, Copyright (c) 2026 Matt Pocock                                                                      | 骨格のみ（ファイル転記なし。`SKILL.md` に出典を記載）                            |
| `test`（既存へ統合）     | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd/`                          | `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260` | 2026-09-17 | MIT, Copyright (c) 2026 Matt Pocock（表示を各ファイル冒頭に保持）                                        | `references/tdd-loop.md`（`tests.md` / `mocking.md` の抜粋）                     |
| `supabase`（**見送り**） | [supabase/agent-skills](https://github.com/supabase/agent-skills) `skills/supabase-postgres-best-practices/` | `8331f910845103c08d51f6ca1d86ebb7d1f745e3` | 2026-09-17 | MIT, Copyright (c) 2026 Supabase                                                                         | 取り込んだが 2026-09-17 に撤去（比較で便益を確認できず。下記の理由）             |

### 適用除外（上流をそのまま適用しない点）

| 対象                                                       | 除外した理由                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-barrel-imports` を内部 import へ適用すること       | Dayopt は feature 間の barrel 経由が必須で、`pnpm lint:boundaries` が deep import を機械的に禁止する。第三者 package のみ対象                                                                                                   |
| `client-swr-dedup` ほか SWR 前提の規則                     | 新規 API は tRPC が正本。SWR を新規依存として足さない                                                                                                                                                                           |
| `server-cache-lru` / `js-cache-function-results`           | ユーザーをキーに含めない module cache はユーザー間でデータが混ざる（REVIEW-1）。cache は認可・request 境界を確認して設計する                                                                                                    |
| React の server / client / rerender / js 系 70 本の全量    | 上流 `AGENTS.md` は 3810 行。索引と全量 vendoring は読む量に見合わない。必要時は固定 SHA から読む                                                                                                                               |
| UI guidelines の runtime fetch（`WebFetch`）               | 規則が固定されず再現しない。スナップショットを正本にする                                                                                                                                                                        |
| UI guidelines の Title Case / カーリークォート規則         | 英語だけに効く copy 規則。ja / en の文言は用語集と `pnpm copy:check:strict` が正本                                                                                                                                              |
| `nuqs` / `virtua` などの library 提案                      | 既存の state 管理・描画で解く。依存追加は AGENTS.md の基準で別途判断する                                                                                                                                                        |
| `diagnosing-bugs` の仮説 3〜5 個・100x / 1000 入力の固定値 | 反復回数と仮説数は症状ごとに決める。一律の下限を全バグへ課さない                                                                                                                                                                |
| `tdd` の「seam をテスト前にユーザーへ確認する」規則        | 可逆な作業で不要な停止を作る（AGENTS.md の AUTONOMOUS）。境界の判断は実装者が持つ                                                                                                                                               |
| Postgres の conn / data / monitor / partitioning 系        | Supavisor は Supabase が管理し、現状の規模で判断材料にならない                                                                                                                                                                  |
| Postgres 参照資料そのもの（撤去済み）                      | index / RLS / lock の 3 本を `supabase` skill へ置いたが、migration 追加ケースの比較で **baseline と同じ index 定義**にしか到達せず、候補だけ lock ガードを落とした。便益を確認できないものは常設しない（#2810 の受け入れ条件） |
| 上流 skill の `scripts/` `agents/*.yaml`                   | `.agents/skills/**` の `.md` 以外は CI の docs-only 判定を外す（`scripts/ci/impact.test.ts`）。現状不要                                                                                                                         |

### 更新方法

1. 上表の固定 SHA と上流の最新 SHA の差分を読む（例: `gh api repos/vercel-labs/agent-skills/compare/<固定SHA>...main`）
2. Dayopt の境界（依存方向、tRPC、ユーザー分離、migration 運用）と衝突しないか判断する
3. 取り込む差分だけを手で反映し、上表の SHA と取得日を同じ変更で更新する

比較検証の記録と採否は [外部 skill 導入の比較検証（#2810）](./ai-skills-trials-2810.md)。**入口から参照資料へ到達することと、その資料が結果を良くすることは別**で、Postgres 参照資料は前者だけを満たしたため撤去した。

**自動更新、未監査スクリプトの実行、runtime のリモート取得は行わない。** UI guidelines の `command.md` は skill 本体（vercel-labs/agent-skills）とは別 repo の依存であり、上表で別行として固定する。

## 6. Independent PR Review

`@claude review`（`.github/workflows/claude-review.yml`）は `protected-path-gate.mjs` が判定する外部契約・不可逆・ガードレール変更だけで使う。依頼時点、対象 SHA の照合、所見の裁定は `.agents/skills/pr-cross-review/SKILL.md` を正本とし、通常 PR や実装途中では起動しない。未応答・古い結果・未実行は指摘0とは異なる。

高リスク変更の immutable pack / role / envelope / validation（`pnpm review:pack` / `review:sweep` / `review:validate` と固定差分レビュー手順）は 2026-09-20 に撤去した。追加 reviewer の停止から 3 日で一度も再開されず、pack を通した証跡も残っていなかったため、読むためだけの実装を維持しない。再開する時は git history から読む。既存の `[review-summary]` は読み取り互換だけを残す。不可逆操作の独立レビュー条件は通常レビューで置き換えない。

read-only と repository scope を runtime で同時に強制できる delegate は現在ないため、大量の repository 読み取り調査は親担当が行う。現行 native delegation は実際の入力に read-only / write を区別する型がなく、判別不能な経路として read-only を含めて拒否する。runtime が別名の typed write / browser tool を提供した時だけ、User が明示した非重複 scope と既存の authority 契約に従って扱う。将来、両方を実測できる adapter が追加された場合だけ、subagent の model 候補と env・timeout・fallback 契約を再評価する。

## 7. 利用量の計測

`pnpm ai:usage` と `pnpm trace` の session / token / tool データは Claude Code local transcript のみを収集する。Antigravity は `null` / unknown であり 0 ではない。GitHub 由来の aggregate PR outcomes は repo 全体の値なので、Claude Code の token や session で割って provider の効率を主張しない。
