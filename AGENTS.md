# AGENTS.md

Dayopt で作業する全エージェントの provider-neutral な正本ガイダンス。OpenAI / Codex を primary harness とし、他 provider でも同じ判断層と不変条件を使う。毎セッション読み込まれる唯一のファイルとして ~200 行に圧縮し、特定作業でだけ要る手順は `.agents/skills/*/SKILL.md` を参照する（末尾の Skills 索引）。機械が強制しているルール（lint / typecheck / CI / hooks）の説明は極力書かない — 機械の判定結果そのものが正であり、prose の重複は陳腐化する。

## レビュー規則

実装 agent 自身のセルフレビュー、`pr-cross-review`、User が任意で依頼する外部レビューに共通する観点。OpenAI / Codex は実装・調査・レビューを担える primary provider とし、他 provider は高リスク変更で独立した反証が有益な時だけ任意で追加する。外部 provider の可用性は merge gate にしない。

- レビューコメントは日本語で書く
- diff によって新たに生じる、または現実に悪化する不具合だけを指摘する。問題がなければ指摘ゼロでよい
- 指摘には優先度と、発生条件を含む現実的な failure scenario を添える
  - **P1**: 本番でユーザー影響、データ破壊、認可漏れ、または誤課金が起きる
  - **P2**: 現実的なエッジケースで誤動作し、修正せずに出荷すべきでない
- 指摘には原因と最小限の安全な修正方針を含める。到達可能な failure scenario を説明できない推測は指摘しない
- provider 固有の優先度表記は、上記の failure scenario に基づいて P1 / P2 へ正規化する

重点不変条件（機械では検出できない観点）:

- **REVIEW-1（ユーザー・テナント分離）**: 別ユーザーのデータへ読み書きできる経路を新規に開いていないか。RLS / authorization / service role の境界を越境していないか
- **REVIEW-2（Dayopt の時間不変条件）**: timezone / DST / 日境界、半開区間 `[start, end)`、overlap 判定、Plan / Log の対応関係を壊していないか
- **REVIEW-3（外部契約の後方互換性）**: MCP / public API / OAuth scope、Stripe / billing / webhook、外部 calendar sync の event / payload / field name を、既存 consumer が壊れる形で変更していないか
- **TEST-1（挙動を証明しないテスト）**: 変更後の挙動を担保する test が、操作前から存在する要素・generic な assert・発火していない mock だけで通っていないか

指摘しないもの: スタイル / 可読性 / 命名の好み、PR の大きさ、「ついで refactor」、lint・型検査で確定的に検出される違反、diff と無関係な既存問題。

## シンプルルール（判断層）

迷った瞬間に戻る 5 箇条。**機能の追加・優先順位・出荷・削除を判断する時にだけ**使う。typo 修正や既存パターンへの追従で持ち出さない。

| #   | ルール                                             | 種別       |
| --- | -------------------------------------------------- | ---------- |
| 1   | **個人の 1 日が良くならないなら、作らない**        | 境界       |
| 2   | **迷ったら、計画と実績の距離を縮める方を選ぶ**     | 優先順位   |
| 3   | **Google Calendar / Toggl より一手少なく**         | 方法       |
| 4   | **不可逆だけ遅く、可逆は速く**                     | タイミング |
| 5   | **2 週間、自分が触らなかった機能は削除候補にする** | 停止       |

6 個目を足す時はどれかを削る。詳細な設計原則は [docs/strategy.md](docs/strategy.md) §4。

**テンポはルール4が決める**（判断ジャンル横断で使う3段階の authority level）:

- **AUTONOMOUS**（可逆は速く）: 承認なしで進めて事後報告する
- **CHECKPOINT**（価値判断の境界で止まる）: 顧客挙動・公開契約・権限/プライバシーに関わる時。推奨と最悪ケースを短く添えて問う
- **EXPLICIT AUTHORITY**（不可逆だけ遅く）: production mutation・release・データ削除・不可逆 migration・実課金。明示指示 + 独立レビュー + dry-run/backup が揃うまで実行しない。揃えられなければ実行せず failure mode を報告する

この 5 箇条で裁けない判断・前提を考え直す場面・ルール自体の改訂は、次の 5 原則（番号が小さい方が優先）へ上がる:

1. **破滅に賭けるな** — 失敗しても会社・信頼・安全は残るか。残らないなら期待値が高くてもやらない
2. **思惟に反するなら、速くてもやらない** — 誰の、どんな変化のためか即答できるか
3. **迷ったら学びが最大の方を選べ。撤退条件を決めてから始めよ**
4. **同点なら、扉が多く残る方を選べ**
5. **非対称なら賭けろ** — 損失に天井があり利得に天井がないなら、Rule 1 に反しない限りコミットする

## Dayopt のコア不変条件

### 時間（Plan / Record 分離モデル）

記録（Record）はユーザーが明示的に作る。**時刻の規則は 2 本だけ**で、これ以外に過去・未来で操作を出し分けない（2026-09-04 に「未来 Plan」の特別扱い 4 種を撤去した）。

| 規則                                             | 対象          | 強制点                                                    |
| ------------------------------------------------ | ------------- | --------------------------------------------------------- |
| `end_at > start_at`                              | Plan / Record | DB trigger（`DT003`）                                     |
| **Record は未来に終われない**（`end_at <= now`） | Record        | DB trigger `validate_record_temporal_write_v1`（`DT005`） |

- **Plan**: 時間軸のどこにでも置ける。過去の Plan もドラッグ移動・リサイズ・時間編集ができ、未来の Plan も skip できる。編集しても Plan のままで Record へは変わらない
- **Record**: 過去の事実。終了を未来へ動かす編集だけ不可。紐付け先 Plan がどこにあるかは制約しない
- 過去スロットへ新規に引いたブロックは Record になる（`resolveTimeblockDestination` は end_at だけで宛先を決める。UI に種別選択の一手を足さない）
- **強制点は DB trigger / SQL 関数**。アプリ層（service / MCP client / UI）はその写しで、UI だけを直しても規則は変わらない
- **規則を撤去する時は写しを全部消すまでが 1 変更**。DB / service だけ緩めて UI 側の写しが残ると「操作はできるのに保存されない」症状になり、旧規則を assert しているテストが緑のまま隠す。撤去 PR では [docs/engineering/invariants.md](docs/engineering/invariants.md) §時刻 の写し表（契約変換 / UX 先回りの 2 分類）を grep 対象にする（2026-09-07、過去 Plan のドラッグ移動が 40348e2bd の後も効かなかった件）
- 表示用の upcoming / active / past 分類は `useCalendarData` が持つ（`getTimeblockState()` は呼び出し元が test だけの残骸）

### アーキテクチャ

- **依存方向は一方向**: `features/ -> lib/`。lib/ は feature 非依存。feature 間は barrel 経由のみ、deep import 禁止（`pnpm lint:boundaries` 機械強制）。DAG: Layer0(activities) → Layer1(timeblock, external-calendar) → Layer2(calendar, review)。settings は composition として DAG 除外。詳細判断（domain 配置、RPC transformer 配置、Composition Hub）は `pr-cross-review` skill が持つ
- **新規 API は必ず tRPC**（Router → Service → Supabase の3層、feature-colocated）。REST は既存 allowlist（`/api/health/*`, `/api/v1/system/*`, `/api/integrations/*`, `/api/mcp`, `/api/oauth/token`, `/api/cron/*`）のみ
- **状態管理**: Zustand でグローバル、useState でローカル
- **UI**: `@dayopt/components` 第一選択、semantic token 経由のみ（`pnpm lint:tokens` 機械強制）、Storybook に無いパターンは先に Story 追加（`storybook` skill）
- **ロジックの置き場**: 新規の集計・ビジネスロジックは TS service 層。既存 PL/pgSQL 関数は凍結資産（bug fix のみ）
- **楽観的更新**: ユーザー操作 mutation は不可逆操作を除き全て実装（`optimistic-update` skill）
- **エラー境界**: 機能単位で設置、アプリ全体を1つでラップしない
- **zod**: apps/product は v3 系、apps/web は v4 系に固定（`@hookform/resolvers`の協調アップグレードが要るため統一は見送り済み）。app間でスキーマ共有しない

## Non-Negotiables

- 既存コードを検索してから変更する（`rg` / `rg --files` 優先）。repo 全体を洗う時は `rg --hidden --glob '!.git/**'`（`.git/` 以外の dot ディレクトリも対象にするため）
- issue の起票・worker への作業依頼は `dispatch` skill の規約に従う
- 既存の未コミット差分はユーザー作業として扱い、勝手に revert / stage しない
- env ファイルの読み書き境界は `docs/operations/secrets.md` に従う。`.op-env.agent`/`.op-env.human` は触ってよいが、実値が入りうる `.env`/`.env.local` は読みも書きもしない
- `git add .` は避ける。path-limited add で scope を固定する。コミット前に `git diff --cached` を確認する
- コード変更後は `pnpm typecheck` / `pnpm lint` / `pnpm lint:boundaries` を通す
- コミットメッセージは日本語 Conventional Commits（Latin大文字語で始めると`subject-case`で弾かれる）
- 型: 具体的な型を使う。union の variance には `as never`（`as any` 禁止）。`unknown` は型ガードと併用のみ
- Export: named export。App Router 特殊ファイル（page/layout/loading等）のみ `export default`
- Component: 関数宣言 + props 型の直接注釈（アロー関数 const は避ける）
- ログ: `@/lib/logger` を使う。`console.log` は本番コード禁止
- 命名: `utils.ts`/`helpers.ts` を避け責務を表す具体名にする
- 語彙: 用語は `docs/product/glossary.md`（正本 `scripts/lib/glossary/terms.ts`）に従う。messages は `pnpm copy:check:strict` が値とキー名を機械検査するが、docs / skill / issue 本文は検査対象外なので旧語彙（エントリ / タグ / タスク / ブロック / 箱 / 型 / レンズ）を書かない
- eslint-disable は最終手段。使う時は同じ行に `-- 理由` を書く。ファイル全体無効化より1行無効化を優先
- 依存追加前に確認: ブラウザ標準/既存依存で代替できないか、Star 1000+/直近6ヶ月更新か、出口コスト（捨てる時に何が壊れるか）を1文で言えるか
- `--no-verify` によるフックスキップは禁止（hook が機械ブロックする）
- アクセシビリティ: アイコンボタンに `aria-label`、フォームに `label` 紐付け、タッチターゲット最小 44x44px、画像に `alt`

## 実装 Plan の必須セクション

非trivialな実装 plan を提示する時、次を順に書く（trivial な1ファイル1行修正はGoal+1行Approachのみでよいが、不可逆要素があれば規模に関わらずReversibility Table必須）:

1. **Goal**（1文）
2. **Minimum Viable Approach** — 「ついで」「将来」「綺麗に」を排除した最小骨格。追加するなら理由を併記
3. **Step Count**（UIフロー新設・変更時のみ必須）— Google Calendar/Toggl等との操作数比較表。同数/多い場合は理由必須
4. **Reversibility Table** — 各stepに `[minutes]`/`[hours]`/`[days]`/`[irreversible]` タグ。irreversibleは強い正当化が必要
5. **Existing Code to Reuse** — 流用する既存関数/component の path
6. **What I'm Not Doing** — やらないことと理由（scope creepの自己検出）

## PR / git 運用

- **束ねが標準**: 機能のまとまり単位で1 PRにする。サイズを理由に分割しない。分割してよいのは不可逆migrationの隔離、独立検証・revertしたい変更のみ
- **PR判定3問**: (1) 同じレーンが書いたか (2) 壊れたら一緒に戻すか (3) クロスレビュー1巡で読み切れるか
- **PR は draft で作成**、ローカル検証（`pnpm check` + pre-pushフック）後に自己判断で ready 化する。ready化で軽量CIが起動、fix roundは ready のまま1round=1pushで積む
- **`Closes #N` を issue ごとに1行**（`Closes #1, #2`は先頭しか閉じない）。epicや部分対応は `Refs #N`
- **マージは merge commit 限定**（squash/rebase は repo 設定で無効化済み）。`pnpm branch:finish <PR番号>` でマージ〜worktree削除〜branch削除〜main最新化までワンセット実行
- **branch名**: `{agent}/{domain}-{action}[-{issue番号}]`。自動生成ランダム名は最初のPR作成前に `git branch -m` でリネーム
- **worktree運用**: 1 worktree = 1 branch = 1 PR。役目を終えたら `pnpm branch:finish` がその場で削除する。`.claude/worktrees/` 配下に作成

### レビュー

review threadは全件resolveしてからmerge（fix積む/反論reply/issue化のいずれかで閉じる。黙って閉じない）。同じ構造の指摘が2ラウンド連続で出たら、fixを積むのをやめ保証境界を明文化して以後は反論replyへ切り替える（ただし「点の追加」ではなく「classごと閉じる設計」に転換できないか先に検討する）。判断基準は「mergeした時点でmainより安全か」。

レビューのシンプルルール: (1) 壊れる筋書きを語れないなら指摘しない、語れたなら黙殺しない (2) mergeの基準は完璧ではなくmainより安全 (3) 迷ったら点を塞ぐよりclassを閉じる。

**merge の遮断は、有効化された provider adapter の pre-tool guard（`gh pr merge` / `gh api ... pulls/.../merge` の直接実行を block）と `pnpm branch:finish` の CI check（status-check-rollup 判定）だけで行う。adapter を呼ばない runtime と User 自身の UI merge は対象外**（この境界が実害化したら GitHub Team plan の ruleset へ切り替える。2026-09-04、#2596）。`pr-cross-review` と外部 provider の反証レビューは advisory で、所見は PR コメントとして投稿するだけで merge を止めない。保護対象 path の判定（`scripts/ci/protected-path-gate.mjs`）は、レビューをどこまで重く行うかの目安に使う。保護対象の基準は**外部契約 or 不可逆**（auth/OAuth/MCP、billing/webhook、migration、外部calendar provider、system API、ガードレール自身）。`review:full` ラベルは「User 自身が重く見て目を通す」印であり、機械判定の入力にはしない。

retreat条件: `apps/product/src/features/timeblock` または `apps/product/src/lib/time` 配下のtestを削除・skipするPRは、`review:full` labelを手で付けてUser自身が目を通す（時間不変条件の安全網がそのtest自身であるため。#2489 / #2503）。

### レーン運用

worktree で作業するセッション（レーン）は次を守る:

- **止まる前に連絡**する。質問・ブロック・想定外・判断待ちが発生したら、待ち状態に入る前に (1) 何で止まっているか (2) 自分の推奨 (3) 待ち中に続行できる代替作業の有無、の3点で担当issue/PRへコメントする。黙って停止しない
- **停止条件**: 同種のエラーに3回連続で失敗した／scope外のファイルを変更しないと解決できないと判明した／チケットが前提とする原因・機構が実測と食い違うと分かった、のいずれかに当たったら試行を続けず停止して報告する。エスカレーションは失敗ではなく正しい動作
- **検証の証跡原則**: 検証主張には実行コマンドと出力の要点を添える。「passした」だけの報告は不可
- **push前セルフレビューはriskに比例させる**: 自動委任条件カテゴリ（auth/RLS/billing/migration/公開契約/cross-feature等、正本は `pr-cross-review` skill 手順2の表）に触れるdiffと既存パターン追従でない新規ロジックは、push前に敵対的セルフレビューを行い生出力を報告へ添付する（#2374）。typo・docs・パターン追従は機械検証（`pnpm check` + pre-pushフック）のみでよい
- issue/PRコメントが内容の正本。1 worktree = 1 branch = 1 PR、役目を終えたworktreeはその場で削除する

## 委任・報告の作法

- **最初に成功条件を固定する**。ユーザーが確認できる結果、対象範囲、検証方法を先に書き、手段や model 選択を目的化しない
- **事実と仮説を分ける**。repo / docs / issue / 実行結果で確認した事実には証拠を添え、未実測の原因や効果は仮説として明記する。安く確認できる仮説は作業前に検証する
- **決定的な道具を先に使う**。検索・git history・diff・typecheck・lint・test・JSON 変換・CI 取得は、まず既存 script / CLI で閉じられないか探す。LLM や外部連携を使う時も、必要な瞬間だけ最小の context・権限・経路を渡す（`routing` / `mcp-usage` skill）
- **委譲は採算が合う時だけ行う**。独立して進められ、scope と出力を検証でき、context 引き渡しと統合の費用を上回る時に限る。小さく一体な作業は担当 agent がそのまま完了してよい
- **委譲契約**: 成功条件、触ってよい path、既知の制約、期待する証拠、検証コマンド、外部 state を変更してよいかを明記する。write 可能な委譲は同一 worktree・非重複 scope に限定し、commit / push / external mutation は明示的に委ねられた場合だけ行う
- **判断では意味のある選択肢を比較する**。差が実際の挙動・リスク・可逆性に影響する選択肢だけを並べ、推奨と最悪の failure mode を添える。複数の判断は 1 回に束ねる
- **出力ではなく outcome を検証する**。diff、コマンド出力、実際の UI / API / data flow を成功条件と突き合わせ、subagent や tool の「passed」という申告だけで完了にしない
- **外部 provider の反証は任意**。auth / RLS / billing / migration / 公開契約などで独立視点の便益が実行コストを上回る時に追加する。OpenAI / Codex を primary としつつ、別 provider を使う場合も同じ scope・証拠・privacy 境界を適用する
- **永続 handoff**: issue / PR がある作業は、進捗・判断・ブロック・検証結果をその issue / PR へ残す。会話 transcript を唯一の状態にしない
- **完了報告**では変更、検証コマンドと出力の要点、未確認事項、deferred scopeを示す
- **曖昧な指示**: (1) repo/docs/issueから判明する事実を先に調べる (2) 承認済みscope内で安全かつ可逆なら合理的仮定を明示して進める (3) 未決事項だけ証拠付き推奨とともに確認する (4) 質問・懸念を承認へ読み替えない

## Skills 索引

`.agents/skills/*/SKILL.md` を参照。`.claude/skills` は Claude Code 互換の相対 symlink であり、正本ではない。該当する作業では先に読む。

| skill                  | 使う場面                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| `dispatch`             | issueをworkerへ渡す準備、issue起票、束ね、状態ラベル運用                         |
| `routing`              | 非 trivial タスクの分解、実行方法・委譲の採算判断、出力契約                      |
| `mcp-usage`            | Sentry/Supabase/Vercel/Context7/Eagle/UptimeRobot 等の MCP 呼び出し              |
| `skill-design`         | 新規 skill 作成・既存 skill の description/When to Use 改修                      |
| `supabase`             | migration/RLS/Storage policy/Realtime/Edge Functions                             |
| `trpc-router-creating` | tRPC router/service の新規作成                                                   |
| `store-creating`       | 新規 Zustand store                                                               |
| `storybook`            | Story作成・design token 選択                                                     |
| `i18n`                 | UI文言・翻訳ファイル・用語集/禁止表記                                            |
| `error-handling`       | try/catch・tRPC onError・ErrorBoundary・Sentry連携                               |
| `optimistic-update`    | tRPC mutation の楽観的更新                                                       |
| `security`             | 認証/認可・RLS・外部入力を受けるフォーム                                         |
| `test`                 | 新機能・バグ修正後のテスト                                                       |
| `pr-cross-review`      | merge前クロスレビュー（旧risk-reviewer/behavior-verifier観点を統合）             |
| `docs-writing`         | ユーザー向けdocs・リリースノート・技術ドキュメント                               |
| `docs-audit`           | 公開docsの監査                                                                   |
| `releasing`            | リリース作業end-to-end（明示依頼時のみ）                                         |
| `gardening`            | 月次改善ループ: ai:usage の 4 問 → 月に 1 変数 → 結果(未) 回収（明示依頼時のみ） |
| `audit-ai-config`      | AI設定の棚卸し・audit                                                            |
| `blog-ideas`           | ブログネタ提案とissue起票                                                        |
| `usability-probe`      | repo blind な browser-only ユーザビリティプローブ実行                            |
| `decision`             | `docs/decisions.md` への意思決定1行追記                                          |

## Deploy / Release

- Staging branch と Production を同時に触らない。Staging → 開発者確認 → 指示後にProduction
- Supabase Edge Functions は `supabase functions deploy --use-api`
- release意図が明示された時だけ `releasing` skillを使う
