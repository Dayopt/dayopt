# AGENTS.md

Dayopt の共通指示。Project 設定を正本とし、個人設定・ホームへのリンクに依存しない。作業別の手順は必要な skill だけ読む。

## Non-Negotiables

- **Cloud-first、Local-optional**。開発・画面確認はクラウドを基本とし、必要ならローカルも使う。作業中の別 worktree・branch・未コミット差分を勝手に変更しない。
- 提案・変更前に既存実装と関連判断を調べる。Issue の有無を問わず [判断の入口](docs/decisions.md#判断する前に読む)から現行の正本・理由・却下案を確認し、履歴の撤回済み判断を復活させない。検索は `rg` を優先し、repo 全体は `rg --hidden --glob '!.git/**'`。構造は [architecture.md](docs/engineering/architecture.md)、技術規約は [conventions.md](docs/engineering/conventions.md)、用語は [glossary.md](docs/product/glossary.md) を参照する。
- Issue / PR がある非自明な作業は `pnpm ctx <N> --reuse-brief-l1` から始める。Issue 本文が要求の正本。Brief は助言であり、古い・取得できない場合は報告して一次資料で進める。詳細は `routing`。
- 文書の現状説明を根拠にする時は `pnpm --silent docs:read <repo-relative-path>` で正本から読む。生成本文は手編集せず正本を更新する。読取失敗を保存済み本文で補わない。読取・更新・検証の手順は [docs 運用規約](docs/README.md#ai-の標準手順)に従う。
- 秘密情報は [secrets.md](docs/operations/secrets.md) の境界に従う。`.env` / `.env.local` は読み書きしない。`.op-env.agent` / `.op-env.human` を使う。
- 変更した挙動を対象 test / E2E / Storybook 等で確かめる。同じ差分・環境の成功済み検査を根拠なく繰り返さない。ready 化前の `pnpm check` と pre-push は必須。詳細は [testing.md](docs/engineering/testing.md)。
- commit は対象 path だけ stage して差分を確認する。日本語 Conventional Commits を使い、hook を迂回しない。

## シンプルルール（判断層）

製品判断は [strategy.md](docs/strategy.md) に従い、個人の 1 日を良くし、計画と実績の距離・操作数を減らす最小の変更を選ぶ。

- **AUTONOMOUS**: 承認済み範囲の可逆な作業は進めて報告する。
- **CHECKPOINT**: 顧客挙動・公開契約・権限/プライバシーの未決判断は、選択肢・推奨・最悪ケースをまとめて確認する。
- **EXPLICIT AUTHORITY**: production mutation・release・データ削除・不可逆 migration・実課金は、明示指示 + 独立レビュー + dry-run/backup が揃うまで実行しない。

## Issue の進め方

- 作業対象の Issue には `type:mission` / `type:task` / `type:bug` / `type:question` を 1 つ付ける。Mission は子 Issue へ分解し、Mission 自体では実装しない。Task は合意済みの範囲を実装・検証する。Bug は再現して回帰を防ぐ検証を加え、修正する。Question は証拠を Issue コメントに残して人の判断を待ち、実装 PR を作らない。
- 着手・続行を妨げる前提がある open Issue だけに `status:blocked` を付け、解除条件を本文へ書く。解除条件を確認してから外す。進行は Issue の open / closed、リンク済み PR、コメントと worktree で確認する。PR に分類ラベルを複製しない。
- 作業順はユーザーの指定、進行中の作業、依存関係、期限や障害の実態から決める。ラベルの優先度からエージェントが自動決定しない。不可逆操作の許可とレビュー要否は上記の権限境界と変更内容から判断する。

## Dayopt のコア不変条件

### 時間（Plan / Record 分離モデル）

- Record はユーザーが明示的に作る。時刻の規則は `end_at > start_at`（Plan / Record、DT003）と `Record.end_at <= now`（DT005）の 2 本だけ。
- Plan は過去・未来とも編集でき、編集しても Record には変わらない。Plan / Record は独立して保存する。手動 skip と保存上の相互参照は廃止済み（[現行仕様](docs/product/specs/plan-record.md)、[移行の経緯](docs/engineering/migrations/independent-plan-record.md)）。
- 新規作成の既定は end_at のみで決める（`resolveTimeblockDestination`）。過去は Record / Plan を選べ、未来は Plan のみ（`resolveTimeblockKindChoice`）。これ以外に過去・未来で操作を出し分けない。
- 作成・編集は同じ Inspector。アクティビティ選択で作成し、選択前に閉じれば保存しない。明示の保存 / キャンセルは置かない。サイドバーのアクティビティは既定長で即作成し、取り消しはトースト。
- 強制点は DB。規則の変更は [invariants.md](docs/engineering/invariants.md) の写し表を確認し、DB / service / MCP / UI / test を一緒に更新する。timezone / DST / 日境界と半開区間 `[start, end)` を守る。

### アーキテクチャ

- 依存は `features/ → lib/` の一方向。feature 間は barrel 経由。新規 API は feature-colocated な tRPC（Router → Service → Supabase）、REST は既存 allowlist のみ。
- 新規ビジネスロジックは TS service 層。既存 PL/pgSQL は bug fix のみ。UI は `@dayopt/components` と semantic token を使い、未登録パターンは先に Story を追加する。
- ユーザー操作 mutation は不可逆操作以外、楽観的更新を実装する。zod は product が v3、web が v4。詳細は技術規約と該当 skill に従う。

## 実装 Plan

必要な作業では目的・最小の方針・検証方法を短く示す。UI フローを変える時は操作数への影響、不可逆変更では復旧方法も示す。固定の書式は要求しない。高影響変更は [AI開発標準ループ](docs/operations/ai-development-loop.md) の spec-first を適用する。

## レビュー規則

- 日本語で、diff が生む・悪化させる不具合だけを指摘する。発生条件・原因・安全な修正方針を添える。好み・既存問題・機械検査で確定する違反は指摘しない。指摘ゼロでよい。
- **P1**: 本番のユーザー影響・データ破壊・認可漏れ・誤課金。**P2**: 現実的な条件で誤動作し、出荷前に修正すべきもの。
- **REVIEW-1**: ユーザー分離と RLS / authorization / service role の境界を守る。
- **REVIEW-2**: 時間不変条件、overlap、Plan / Record の対応を守る。
- **REVIEW-3**: MCP / API / OAuth / billing / webhook / 外部 calendar の既存契約を壊さない。
- **TEST-1**: 操作前からある要素・generic assert・未発火 mock だけで成功する test を証明にしない。

## PR / git 運用

- 機能のまとまりで 1 PR、1 checkout = 1 branch = 1 PR。分割は不可逆 migration の隔離か独立検証・revert が必要な時だけ。
- commit までは自律。push・PR 作成・レビュー起動は明示指示か承認済み plan の範囲で行う。branch は `<provider>/<domain>-<action>[-<issue>]`（例: `claude/…`、Codex なら `codex/…`）とする。
- PR は draft で作成し、必要な検証後に ready 化する。`Closes #N` は Issue ごとに 1 行、部分対応は `Refs #N`。
- merge commit のみ。merge・後処理は `pnpm branch:finish <PR番号>`。他の作業が使う checkout は切り替え・削除しない。

### レビュー

- 全 PR をリスクに比例してセルフレビューする。main の ruleset（required checks、最新 main への追従、review thread 解決）を満たし、bypass しない。
- `scripts/ci/protected-path-gate.mjs` が外部契約・不可逆・ガードレール変更と判定した PR だけ、CI 成功・head 安定後に `pr-cross-review` で独立レビューを依頼する。追加 reviewer は明示指示なしに起動しない。
- 指摘は修正・根拠付き反論・Issue 化で解決する。根拠のある不具合は直し、保証境界の外への点追加を繰り返さない。merge の基準は main より安全か。
- timeblock / lib/time 配下の test を削除・skip する PR は変更理由と代替検証を PR に明記し、User の確認を受ける。

### レーン運用

- 証拠が増えない試行を繰り返さない。scope・権限・要求と実測の矛盾が解消できなければ、依存作業を止めて理由・推奨・続けられる作業を報告する。
- Issue / PR がある作業では判断・停止理由・検証結果をそこに残し、コメントに書き手を記す。Issue は理由を添えて close し、delete しない。
- 完了報告は変更・検証コマンドと出力の要点・未確認事項を示す。実行できなかった検証を成功と扱わない。

## 委任・報告の作法

- 同じ主担当が調査から検証まで持つ。検索・集計・検査は既存 script / CLI を優先する。
- 委譲が必要な場合だけ `routing` の scope・権限契約を使う。助言や worker の成功申告だけで完了にせず、主担当が現在の diff・実行結果を確認する。
- 不明点は先に repo / docs / Issue を調べる。承認済み範囲の可逆な作業は仮定を示して進め、未決判断だけ確認する。質問・懸念を承認へ読み替えない。

## Skills 索引

`.agents/skills/*/SKILL.md` が正本。`.claude/skills` は相対 symlink、CLAUDE.md は共通指示の互換入口。該当する作業の skill だけ読む。

| skill                  | 使う場面                       |
| ---------------------- | ------------------------------ |
| `routing`              | 作業方針・委譲の判断           |
| `dispatch`             | Issue 起票・担当への引き渡し   |
| `mcp-usage`            | 外部ツールの利用               |
| `skill-design`         | skill の作成・整理             |
| `supabase`             | migration・RLS・DB             |
| `trpc-router-creating` | router / service 新設          |
| `store-creating`       | Zustand 新設                   |
| `storybook`            | Story・token 選択              |
| `i18n`                 | UI 文言・翻訳                  |
| `error-handling`       | エラー処理                     |
| `optimistic-update`    | 楽観的更新                     |
| `security`             | 認証・認可・外部入力           |
| `test`                 | 挙動変更の検証                 |
| `diagnosing-bugs`      | 原因未特定の不具合             |
| `react-performance`    | 性能調査                       |
| `ui-audit`             | UI 監査の明示依頼              |
| `pr-cross-review`      | 保護対象 PR の独立レビュー     |
| `docs-writing`         | docs 執筆                      |
| `docs-audit`           | 公開 docs の監査               |
| `releasing`            | release の明示依頼             |
| `gardening`            | 月次改善の明示依頼             |
| `audit-ai-config`      | AI 設定整理の明示依頼          |
| `blog-ideas`           | ブログ提案・起票の明示依頼     |
| `decision`             | 判断の明示確定・変更・記録依頼 |

## Deploy / Release

Staging → 開発者確認 → 明示指示後に Production。両環境を同時に触らない。release 手順は `releasing`、Supabase Edge Functions は `supabase functions deploy --use-api`。
