# docs/ 運用規約

この README は docs の**地図と書き方の規約**。Dayopt が何を作るか・何を変えないかは [strategy.md](./strategy.md)（憲法）が正本で、この 2 ファイルは役割が重ならない。

このディレクトリは、Dayopt の事業・プロダクト・設計・運用に関する内部情報の正本（SSOT)。コードが消費する値はコードを正とし、docs には判断、振る舞い、所在を書く。主な読者は創業者、開発者、AI。AI が単独で検索しても「現在の正」「過去の記録」「実装場所」を区別できる予測可能な構造を優先する。

## 情報面の責務

| 面                      | 書くこと                                                     | 書かないこと                                  |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `docs/`                 | 複数 component / package を跨ぐ仕様、設計、判断、運用        | props catalog、コードから取得できる定数の複製 |
| Storybook               | 単一 component の使い方、variant、visual state、interaction  | DB schema、feature DAG、system data flow      |
| app / package README    | その領域固有の入口、実行コマンド、正本へのリンク             | monorepo 全体の規約の複製                     |
| `apps/web/content/docs` | 外部ユーザー向けの利用説明                                   | 内部アーキテクチャ・運用                      |
| code / manifest         | package version、schema、env定義、design token等の機械消費値 | 判断理由や利用者向け仕様                      |

同じ説明を複数面に置かない。境界を跨ぐ場合は正本へリンクする。

## 地図: 1 ディレクトリ = 1 つの質問

迷ったらこの表で行き先を決める。ファイル単位の細かい引き先は後述の「質問から正本へのルーティング」。

| 質問                                         | 行き先                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 変わらない前提・原則の話か                   | `strategy.md`（憲法。全ドメインの上位、1 ファイル）                                          |
| 今どう認識しているか・何に賭けているかの話か | open issue / PR（`state.md` は 2026-09-02 に廃止。賭けは epic issue の本文と撤退条件で持つ） |
| 画面・API・データの振る舞いの話か            | `product/` — 原則、仕様（`specs/`）、用語、UI 文言                                           |
| 外の人に向けた言葉・お金・市場の話か         | `business/` — 誰に・何と言って・いくらで届けるか                                             |
| コードの作り方の話か                         | `engineering/` — architecture、規約、infra                                                   |
| 本番を動かし続ける話か                       | `operations/` — runbook、monitoring、security、legal                                         |
| 何を契約・所有しているかの話か               | `company/` — accounts、登記                                                                  |
| 進行中の複数領域を跨ぐ設計か                 | epic issue 本文（`docs/projects/` は作らない。2026-08-28、#2473）                            |
| 意思決定の記録か                             | `decisions.md`（全決定の時系列索引、append-only。2026-08-28、#2475）                         |
| 調査・feedback・incidentの記録か             | GitHub issue（`domain log/` は 2026-08-28、#2475 で全廃）                                    |

`business/` の下位構造: 直下 = 事業判断の正本（icp / messaging / competitors / pricing / business-model / growth）、`content/` = 公開コンテンツの書き方と運用（voice / writing-style / docs-policy / review-checklist / content-operations）、`channels/` = チャネル別の運用（x / reddit / lp）。旧 `marketing/` ドメインは 2026-08-10 に `business/` へ統合した。

ルート直下の `strategy.md` は stock として扱い、同じ frontmatter 契約（status / last_verified）に従う（docs-guard の `ROOT_STOCK_FILES`）。

`strategy.md` と issue・PR は**変化速度で分かれる**。変わらない前提は `strategy.md`、現在地・賭け・当週キュー・進行中の作業は **issue と PR 自身**（`status:*` ラベルと各 issue のコメント列）。**現在地を docs へ転記しない** — 転記した瞬間に古くなる（2026-08-20 に廃止した STATE.md、2026-09-01 に廃止した日次盤面 issue、2026-09-02 に廃止した `state.md` と同じ失敗）。

## 現在・履歴

### Stock — 現在の正

日付 prefix のないファイル。常に現行状態へ更新し、過去版は Git 履歴に任せる。

```yaml
---
status: current # current | superseded
last_verified: 2026-07-14
code: apps/product/src/features/timeblock # 任意。repo 内の実在 path
---
```

- `current`: 現在参照してよい
- `superseded`: 正本ではない。通常は新しい正本へのリンクを本文に置く
- `last_verified`: 内容をコード・外部状態・一次資料と照合した日。本文を眺めただけでは更新しない
- `code`: scalar または配列。symbol や glob ではなく、実在する repo-relative path を書く

### Decisions — 全決定の時系列索引

各ドメイン直下の `log/YYYY-MM-DD-slug.md`（frozen frontmatter contract）は 2026-08-28（#2475）に全廃した。過去分は移設・蒸留せず、正本は Git 履歴と merged PR に任せる。

意思決定は [`decisions.md`](./decisions.md) 1 ファイルへ集約する。append-only（`---` 区切りより下のエントリ領域は追記のみ、`pnpm docs:check` が機械的に強制）で、書式・タグ語彙は同ファイルのヘッダが正本（ここでは複製しない）。決定したら `decisions.md` へ 1 行追記し、該当ストック（`AGENTS.md` / 該当 docs）の編集を同じ変更に含める。

調査・feedback・incidentなど 1 回きりの記録は GitHub issue として起票する（`dispatch` skill の既存ラベル体系に従う）。

## 質問から正本へのルーティング

| 質問                           | 正本                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| なぜ作るか / 変えないもの      | `strategy.md`                                                                        |
| 今の認識・賭け・やらないこと   | open issue / PR（賭けは epic issue の撤退条件）、変えないものは `strategy.md` §5     |
| 誰向けか                       | `strategy.md` §3、詳細は `business/icp.md`                                           |
| 現在の価格・課金契約           | `product/specs/billing.md`、価格判断は `business/pricing.md`                         |
| 事業指標の定義                 | `business/business-model.md` §Metrics                                                |
| 広げ方・チャネル               | `business/growth.md`, `business/channels/`                                           |
| 公開コンテンツの書き方・運用   | `business/content/`                                                                  |
| プロダクト原則・不採用方針     | `product/principles.md`                                                              |
| 現在の機能仕様                 | `product/specs/*.md`                                                                 |
| UI / code用語                  | `product/glossary.md`                                                                |
| 訴求・コピー                   | `business/messaging.md`（UI 文言は `product/copywriting.md`）                        |
| 全体 architecture / state flow | `engineering/architecture.md`                                                        |
| coding / API / frontend 規約   | `engineering/conventions*.md` と `AGENTS.md`                                         |
| 不可解な失敗の切り分け手順     | `engineering/diagnostics.md`                                                         |
| env・deploy・secret            | `engineering/infra.md`, `operations/secrets.md`                                      |
| 障害対応・release              | `operations/runbook.md`                                                              |
| 監視・alert                    | `operations/monitoring.md`                                                           |
| security                       | `operations/security.md`                                                             |
| 信頼境界・既往クラス・却下記録 | `engineering/threat-model.md`                                                        |
| 外部 OAuth の審査申請          | `operations/google-oauth-verification.md`                                            |
| 契約サービス                   | `company/accounts.md`                                                                |
| 進行中・完了 Project           | 該当 epic issue 本文と merge 済み PR（`docs/projects/` は 2026-08-28 に全廃、#2473） |
| なぜその判断になったか         | `decisions.md`（全決定の時系列索引。2026-08-28、#2475）                              |

## 書く場所の決定木

1. 意思決定の記録か → `decisions.md` へ 1 行追記。調査・feedback・incidentなど 1 回きりの記録か → GitHub issue（`domain log/` は 2026-08-28、#2475 で全廃）
2. 有限の複数step作業か → epic issue 本文（`docs/projects/` は作らない）
3. 単一componentに閉じる visual / interaction contractか → Storybook
4. 現在の横断的な真実か → 該当ドメインの stock
5. コードが消費する値か → code / packageを正本にし、docsは意図とpathだけを書く

## 書き方

- 1ファイル1トピック。冒頭1〜2行で対象と現在性を説明する
- **全体像を先に、詳細を後に書く**(先行オーガナイザー)。読者が読み進める間ずっと保持しなければならない情報は本文中の表やリストへ出し、記憶ではなく参照で読めるようにする
- 機械検証(contract test / guard / CI)が守っている領域は「ここは機械が保証するため理解不要」と明記してよい。読者に理解を要求するかどうかを暗黙にしない
- **現在の振る舞い**、**目標・仮説**、**過去の経緯**を同じ箇条書きで混ぜない
- 機能specは実装済みの外部挙動だけを書く。未実装は epic issue、理由は決定した issue または `decisions.md` へ分ける
- exact version、env名、価格値などコードに正本がある値はpathを示し、不要に複製しない
- Mermaidを優先し、画像だけに設計情報を閉じ込めない
- generated fileは生成元とcheck commandを冒頭に明記し、手編集しない
- file / directory名はkebab-case
- ユーザーの声・障害の記録は GitHub issue として起票する（`dispatch` skill の既存ラベル体系に従う。2026-08-28、#2475 で domain log/ 廃止に伴い移行）

## 運用

- featureの振る舞いを変えたら同じ変更で該当specを更新する
- 意思決定はstock更新と `decisions.md` への1行追記を同じ変更に含める
- 月次 `/gardening` は journal を持たない。判断は `decisions.md`、所見は issue（数値は `pnpm ai:usage` で再計算できる）
- `pnpm docs:check` はlink、metadata、path、naming、`decisions.md` の append-only 契約を検証する

テンプレートは [`_templates/`](./_templates/)、AIの自発的な更新責務はroot [`CLAUDE.md`](../CLAUDE.md)を参照する。
