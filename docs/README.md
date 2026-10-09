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
| 仕組みを追跡できるようになりたいか           | `learn/` — Dayopt Learning System（経路・失敗・画面・章。正本は各 .md の JSON block）        |
| 進行中の複数領域を跨ぐ設計か                 | epic issue 本文（`docs/projects/` は作らない。2026-08-28、#2473）                            |
| 意思決定の記録か                             | `decisions.md`（全決定の時系列索引、append-only。2026-08-28、#2475）                         |
| 調査・feedback・incidentの記録か             | GitHub issue（`domain log/` は 2026-08-28、#2475 で全廃）                                    |

`business/` の下位構造: 直下 = 事業判断の正本（icp / messaging / competitors / pricing / business-model / growth）、`content/` = 公開コンテンツの書き方と運用（voice / writing-style / docs-policy / review-checklist / content-operations）、`channels/` = チャネル別の運用（x / reddit / lp）。旧 `marketing/` ドメインは 2026-08-10 に `business/` へ統合した。

ルート直下の `strategy.md` は stock として扱い、同じ frontmatter 契約（status / last_verified）に従う（docs-guard の `ROOT_STOCK_FILES`）。

`strategy.md` と issue・PR は**変化速度で分かれる**。変わらない前提は `strategy.md`、現在地・賭け・当週キュー・進行中の作業は **issue と PR 自身**（open / closed state、Issue labels、コメント列）。**現在地を docs へ転記しない** — 転記した瞬間に古くなる（2026-08-20 に廃止した STATE.md、2026-09-01 に廃止した日次盤面 issue、2026-09-02 に廃止した `state.md` と同じ失敗）。

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

各ドメイン直下の `log/YYYY-MM-DD-slug.md`（frozen frontmatter contract）は 2026-08-28（#2475）に全廃した。過去ログの一括移設は行わず、原典は Git 履歴と merged PR に残す。現在の判断に必要な理由・却下案が不足している時は、原典を確認して既存ストックへ蒸留する。手順は [意図の継承](operations/ai-development-loop.md#意図の継承)。

意思決定の履歴は [`decisions.md`](./decisions.md) 1 ファイルへ集約する。初めて読む人・agent は [判断の入口](decisions.md#判断する前に読む)から現在の正本・理由・撤回と後継を辿る。append-only（`---` 区切りより下のエントリ領域は追記のみ、`pnpm docs:check` が機械的に強制）で、書式・タグ語彙は同ファイルのヘッダが正本（ここでは複製しない）。決定したら `decisions.md` へ 1 行追記し、該当ストック（`AGENTS.md` / 該当 docs）の編集を同じ変更に含める。

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
| ロゴ・ブランド素材             | `business/brand.md`                                                                  |
| 訴求・コピー                   | `business/messaging.md`（UI 文言は `product/copywriting.md`）                        |
| 全体 architecture / state flow | `engineering/architecture.md`                                                        |
| 仕組みを追跡できるようになる   | `learn/README.md`（Dayopt Learning System。`pnpm learn` で対話画面）                 |
| coding / API / frontend 規約   | `engineering/conventions*.md` と `AGENTS.md`                                         |
| 不可解な失敗の切り分け手順     | `engineering/diagnostics.md`                                                         |
| テスト方針・CI 予算            | `engineering/testing.md`, `operations/self-hosted-runner.md`                         |
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

### 正本から閲覧時に生成する

人間がブラウザで読む入口は `pnpm docs:serve`。全件の一覧と内部リンクから文書へ移動でき、各リクエストで正本から生成する。教材の対話画面は `pnpm learn` で同じ閲覧サーバーから開く。サーバーは `127.0.0.1` のみで、外部接続・文書の書換えを提供しない。終了は Ctrl+C。`--no-open` はブラウザを開かず URL を表示する。

`pnpm docs:read [repo-relative-path]` は Git の管理対象または ignore されていない Markdown / MDX を読み、正本から生成して標準出力へ返す（省略時は root README）。`docs-live` に加え、既存の Architecture Map / glossary / Learning System の生成器も閲覧時に呼ぶ。生成本文を repo に書かず、前回の読取結果もキャッシュしない。全件読取の1回の実行内だけ、同じ生成器の結果を共有する。入力が壊れている場合はエラーで終了し、古い本文を代わりに返さない。GitHub や通常の editor では、ブロック内の正本へのリンクを入口にする。

```bash
pnpm --silent docs:read
pnpm --silent docs:read docs/engineering/infra.md
pnpm --silent docs:read packages/config/README.md
pnpm --silent docs:read docs/product/glossary.md
pnpm --silent docs:audit
pnpm --silent docs:read --verify-all --snapshot
```

| view        | 正本                                               | 生成する事実           |
| ----------- | -------------------------------------------------- | ---------------------- |
| `workspace` | `pnpm-workspace.yaml` と各 manifest（pnpm が発見） | 登録 path / package 名 |
| `commands`  | root `package.json` の `scripts`                   | コマンド名 / 実行内容  |
| `files`     | package README と同じ領域の `src/`                 | 実ファイルへのリンク   |

登録は [live-contract.ts](../scripts/lib/docs-live/live-contract.ts) の `LIVE_DOCUMENT_VIEWS` と対応する start / end marker で行う。保存本文は同ファイルの `storedLiveBlock(path, view)` が返す正本リンクだけにする。`pnpm docs:check` は本文への手書き、登録済み marker / 文書の消失、重複、不正・未登録 marker を拒否する。本文・表・件数を marker 内へコピーしない。marker の形式の例（保存本文は `storedLiveBlock` に合わせる）:

```md
<!-- docs-live:commands:start -->

コマンドの正本は [package.json](../../package.json)。

<!-- docs-live:commands:end -->
```

`pnpm docs:check` は docs と app / package の Markdown を探し、marker と正本の解決失敗を push 前の判定に接続する。登録済みの生成対象の節では、marker 外の手書きリスト・表・ディレクトリツリーも拒否する。ブランド配布 README / ZIP の Git への再登録も拒否する。既存の glossary / Architecture Map / Learning System の保存ブロックは従来の生成結果との一致検査を続ける。任意の文章が機械的に生成できるかは自動判定していないため、新しい対象は正本・生成器・契約への登録を同じ変更に含める。live ブロックの生成器は [render.ts](../scripts/lib/docs-live/render.ts)、全件列挙と既存生成器への接続は [docs-live/](../scripts/lib/docs-live/)、入口は [read-docs.ts](../scripts/tasks/read-docs.ts)。

`docs:audit` は実在する全 Markdown / MDX と配布説明の閲覧 alias の path・正本の行数・生成方式と役割の候補を、その場で列挙する。marker / 生成元の宣言は機械判定、役割は path による候補分類であり、自然言語の意味や本番稼働を照合した証明ではない。全件検査は `SOURCE`（手書きの正本を読取）、`GENERATED`（正本から生成）、`SNAPSHOT`（DB の保存記録を読取）を区別する。

設計理由・採否・製品の振る舞い・利用手順は人間が持つ意味の正本なので、その文章を生成された実装一覧で置き換えない。公開 docs / 法務文書をこの内部読取経路に移しても、公開サイトの renderer は変わらない。公開面への展開は別途 renderer の接続と表示検証を要する。

DB / 本番 / GitHub の実状態は、repo から稼働確認済みと推測しない。接続先・取得時刻・失敗時の扱いを持つ読取経路が必要。RLS snapshot は保存記録であり、通常の `docs:read` では現在として返すことを拒否する。記録として読む時だけ `--snapshot` を指定し、本文にも現在の DB を取得していないと表示する。既存の保存済み Architecture Map / glossary / Learning System も GitHub や通常の editor で直接読めるが、そのコピーは従来の drift check の保証のまま。`docs:read` を通した場合だけ、閲覧時の再生成を保証する。

ブランド配布先 2 件の README も `docs:read` と閲覧画面では `docs/business/brand.md` を正本として読む。配布資産の生成器と同じ source / target 宣言を共有し、古いコピーには fallback しない。product / web の `pnpm build` は Next.js のビルド前に、そのビルドの正本から配布 README と zip を揃える。生成失敗時はビルドを止める。正本・生成器の変更は両 app の再ビルドと cache 無効化の対象にする。公開済みの旧ビルドやダウンロード済みの zip は、その時点の記録。

閲覧画面は Markdown を表示し、raw HTML / JSX を実行しない。Storybook の埋込み component、画像、Mermaid の図はこの内部 viewer では実行・描画せず、その記述を読む。公開 docs / Storybook 本来の renderer は保持する。

新しい live ブロックでは「生成後に更新を忘れる」保存工程をなくしている。標準出力を人がファイルへ保存したものや、すでに表示された画面は時点 snapshot で、鮮度の保証対象ではない。

### AI の標準手順

文書の調査・執筆・監査では次の手順を使う。AGENTS.md と関連 skill はこの節を共通の入口にする。

1. **所在を探し、正本から読む**。`rg` で対象 path を探し、現状説明を判断の根拠にする前に `pnpm --silent docs:read <repo-relative-path>` を実行する。人間向けの確認には `pnpm docs:serve`、教材には `pnpm learn` を使う。全体の棚卸しは `pnpm docs:audit`。読み取れなければ原因を直すか未取得と報告し、保存済み生成本文で埋めない。
2. **情報の正本を更新する**。一覧・件数・構成図・用語は宣言された code / manifest / data と必要な生成器を編集する。新しい live ブロックには marker と正本リンクだけを書く。既存の保存済み生成ブロックを更新する必要があれば、その生成器を実行する。判断理由・仕様・利用手順は人間が管理する文章を更新する。
3. **更新した経路で確認する**。対象文書を `docs:read` で読み直し、`pnpm docs:check` を実行する。生成器の挙動を変更した場合は変更反映と失敗時の非 fallback を対象 test で確認する。全件の正本解決を検査する時は `pnpm --silent docs:read --verify-all --snapshot` を使い、`SNAPSHOT` を現在として扱わない。公開 docs は content 検証と公開 renderer、配布物は同じビルドの生成結果も確認する。

読取成功は、正本を取得して表示できたことの証拠。文章の意味と実装の一致、クラウドの稼働、公開・デプロイの完了はそれぞれ別の証拠で確認する。

### ローカル・リモート共通の検査

Node 24 と pnpm がある checkout では、ローカル・SSH 先・クラウド開発環境とも `pnpm install --frozen-lockfile` の後に同じ `pnpm check` を実行する。文書だけを確認する時は `pnpm docs:check`。`pnpm check` にも文書検査を含め、失敗すれば後続の検査へ進まない。

通常の install の `prepare` が Husky を設定し、Git の branch push 前にも同じ `pnpm docs:check` を実行する。さらに送信する各 commit の tree を一時 worktree で検査するため、未コミットの修正や別 branch の checkout で違反を隠せない。一時 worktree は検査後に削除し、元の作業中の差分は変更しない。フックの設定状態は `git config --get core.hooksPath` で確認できる。install script を省略した環境やフックを無効にした環境、GitHub の Web 編集ではフックを前提にせず、実行環境で明示的に `pnpm check` を呼ぶ。

今回の live 領域の手書き混入・marker・正本解決・配布生成物の Git 再登録の判定は push 前と明示的な pnpm 検査で行い、CI の gate にはしない。既存 CI は `pnpm docs:check --ci` を呼び、従来のリンク・metadata・命名・決定索引・glossary・構成図・教材の検査を維持する。`CI` 環境変数では切り替えないため、リモート環境の通常の `pnpm docs:check` と pre-push でも今回の判定は動く。フックを通らない変更経路では今回の判定が自動実行されないので、手元で同じコマンドを実行する。

### 本文の規約

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
- `pnpm docs:check` はlink、metadata、path、naming、`decisions.md` の append-only 契約を検証する

テンプレートは [`_templates/`](./_templates/)、AIの自発的な更新責務はroot [`AGENTS.md`](../AGENTS.md)を参照する（`CLAUDE.md` は AGENTS.md を import するだけの adapter）。

### 正本から取得する現状

イベント名、workflow / skill の所在、manifest の export、設定定義や閾値は `facts` view で読む。抽出対象の所在と symbol は [facts.ts](../scripts/lib/docs-live/facts.ts) に登録し、値や件数を文書へ複製しない。閲覧ごとに正本を読み直し、TypeScript は構文から定義を取り出すだけで実行しない。正本の欠損や不正はエラーにし、保存した古い本文へ戻さない。権限設定は件数のみで、秘密値や実環境の適用状態を証明する表示ではない。生成対象の節への手書き一覧・定義コピーは `pnpm docs:check` と pre-push で検出する。
