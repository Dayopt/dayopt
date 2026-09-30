---
status: current
last_verified: 2026-09-29
---

# 所見・仮説・反証

読解基準は全項目 `c3d55216a360aa1ce387faa7f0000d0d6f8fc869`。本番観測による所見はまだ無い。

## F001 — 新規作成の既定と選択可能な種別が同一視される説明

- 状態: 修正済み（`f0151baaf`）、対象unit/生成整合性・文書検査は検証済み。全体監査の完了ではない。
- 期待契約: `AGENTS.md` と `docs/decisions.md` 2026-09-07 の明示判断。既定は終了時刻で決まる。終了が現在以前なら記録/予定を選べ、未来は予定のみ。既定の操作数を増やさない。
- 条件/影響: 開発者が `glossary.md` / `architecture.md` の「種別選択のUIは置かない」を現行仕様として読むと、正しい既存UIを撤去する誤変更を誘発する。
- 根拠（コード上確認）: `timeblock-destination.ts` の2関数は既定判定とユーザー選択の制約を別々に実装。`InlineCreatePanel.tsx:107` が判定して種別タブへ渡し、`useInlineCreate.ts:110` が保存前に同じ判定を行う。`terms.ts:625`、生成glossaryのDestination rule、同詳細ノート、`architecture.md:969` は古い一意判定の説明を保持。
- 反証: 2026-09-04時点では「UIに選択を足さない」が決定だったが、2026-09-07に明示的に変更されている。現在の実装やtestだけを正として採用したのではない。既定判定関数自体は正しく、実装の挙動変更は不要。
- 修正: 用語集の生成元、生成表、詳細ノート、architecture、invariants、Plan/Record仕様、Storybook Guide、default helperのコメントを「既定と選択可否」に区別。生成表は `pnpm glossary:generate` を使用。
- 検証（基準SHA+上記未commit差分、Node24）: `pnpm --filter @dayopt/product exec vitest run --project unit src/features/timeblock/domain/timeblock-destination.test.ts` → 1 file / 5 tests passed、skipなし。`pnpm glossary:check` → exit 0。`git diff --check` → exit 0。文書検査の初回は新規監査記録のfrontmatter不足で失敗し、補完後は成功。説明の修正なので新しい挙動テスト/修正前の失敗は追加していない。既存境界testで記載する挙動を照合。
- 既存Issueとの関係: Mission #2963。#2912等の新規作成UIレーンの挙動・レイアウトには触れていない。

## F002 — 用語集のレポート/セグメント説明の世代混在

- 状態: 修正済み（`e88a1890f`）。説明のみの変更。
- 根拠: `decisions.md` 2026-09-15は3タブ化、セグメントUI/tRPC/MCP撤去、記録合計100%の配分を決定。glossary詳細は4章/保存セグメント/週168h分母の決算バーを現行として説明する。生成表も一部が旧説明。
- 反証: terms、Review仕様、ReportBody、AllocationChapter、report-view-model、aggregation service、filter storeを全文確認。現在の実装も記録時間の分母・3タブである。同日ログの「余白を分母に残す」は後の明示裁可で変更されているため、過去の決定ログは編集していない。segmentのDB dropも行っていない。
- 修正: 用語集の生成元と詳細説明、旧決算バーのdeprecated分類、コメントの旧フィルタ/分母、仕様冒頭の「ダッシュボードではない」を後の明示判断へ同期。
- 検証: glossary再生成、`docs:check`成功（その後の仕様冒頭1文はコミットhookでformat検証）。report-view-model / useReportViewStore / report-aggregation-serviceの3ファイル93 tests passed、skipなし。挙動は変えていないので新規redは不要。
- 追加照合: Guide/詳細hook/service/Storyの旧説明も同期（`84f4d9019`）。全体検査で、廃止済み語も必ず掲載を要求するglossary testが失敗。旧testは別の表への語の偶然の出現でも通っていた。現行UI/設計語がそれぞれの表の行に存在し、非現行語は存在しない契約へ修正。生成処理は変更せず、関連16 tests passed。

## H003 — 常設非本番環境と既存secrets/architectureの記述

- 状態: 未検証仮説、未修正。#2910関連の進行中PRがある。
- 根拠: secretsは常設Staging無し/local-only接続、architectureも永続Stagingなし。testingにはshared persistent nonproduction DBとCloud Preview runnerの移行中契約がある。
- 次の反証: #2910本文/コメントと進行中PR、現行infra、許可済みmetadata readで環境存在とready状態を別々に確認。過去memoryや未merge差分だけで現行docsを上書きしない。
- 追加確認: #2910の現行本文を分割して全文確認。通常Previewと任意localはpersistent非本番DB、schema/shared backend変更だけephemeral、OAuth等は固定Integrationが持つ契約。進行中PR #2926等の実装・配信は別証拠が必要。既存 `production-db-readonly.mjs` と依存helperを全文確認し、read_only=trueでserver version/transaction_read_only/API上限設定/RLS有効フラグだけを照会する既存op run経路を試した。2026-09-29 18:02 JSTに認証初期化がauthorization timeoutで終了し、DB結果は取得できなかった。再試行を繰り返さず、クラウド実態は未確認。個人データ・秘密実値の出力、DB書込なし。

## F004 — 規約がunknownの代わりにas neverを勧める

- 状態: 修正済み（`f2a43d559`）、`docs:check`成功。runtimeの挙動変更なし。
- 根拠: `conventions.md` §禁止されたパターンが `any / unknown / Function` の代替に `具体的な型、as never` を記す。一方同文書のserver transformer入力表は `RPC row / unknown`、API境界でのruntime validationは監査ミッションの要求。ESLint検索ではno-explicit-anyが確認されるがunknown禁止はまだ未確認。
- 反証: product/web/packages ESLintを全文確認し、anyは禁止するがunknown禁止はない。同規約のserver入力表とOAuthの例外処理もunknownを許容する。型システム都合のassertionまで禁止する変更ではない。
- 修正/影響: 禁止表をany/Functionと具体型・関数シグネチャへ修正。未知の入力・例外はunknownからschema/guardで絞り込み、as neverを入力検証の代替にしないと明記。unsafe castを誘発する説明を除去する。既存assertionの一律撤去はしない。Mission #2963で追跡。

## F005 — strategyのAI書き込みghost原則とMCP公開契約

- 状態: H005から採用。明示判断を確認し文書修正済み（`1715af0d8`）。runtime・公開tool・DBの変更なし。
- 根拠: strategy原則3はMCP/API由来も未確定ghostと記す。現在のMCP書込契約をまだ読んでいないため矛盾は未確定。
- 次の反証: MCP仕様、同意/操作確定契約、関連決定/Issue、DB command経路を追う。契約の未決判断をコードだけで裁定しない。
- 追加読解: `docs/learn/10-api-mcp.md`はMCPからcanonical Planを同じDB commandで作る経路を説明し、OAuth scope同意とMCP gateを契約にしている。external-calendar仕様は外部ミラーを明示タップで変換する別経路。journeys/mcp.mdは取得がtruncatedだったため未読を残す。次はtool原文・DB command・明示判断を照合し、ghost原則の適用対象を裁定する。
- 追加回収: journeys/mcp.mdの基準1–1399行を分割して全文回収。tool registry/8 mutation登録/input/output schema、McpMutationClient/DB adapter/contractも全文確認。実際のtool説明もcanonicalと明記し、8 apply RPCへ渡す。strategyとの裁定はDB定義と明示判断の読解が残る。`plans.create`の「future」説明もPlanの過去作成契約との差があり、別途契約/関連testを照合する。分析イベントの古い説明だけはF018へ分離。
- 裁定根拠: #1754現行本文170行、[2026-08-26のUser裁定記録](https://github.com/Dayopt/dayopt/issues/1754#issuecomment-5418236863)、移設された責任境界の[原文](https://github.com/Dayopt/dayopt/issues/1754#issuecomment-5449310972)、commit `765fb8731`の明示裁定メッセージを確認。proposal-onlyへ変更するagent提案に対し、Userは完了間近のscopeを維持して直接書込で出荷すると選んだ。proposal化は将来phaseの検討であり、現在の実装違反ではなかった。移設原文にある古いbilling/planId/scope表は後継判断があるので復活させない。
- DB照合: 20260908022927は接続からuserを導出し、gate/connection/token/profile/operationのlock後にscope・期限・利用権を判定。20260914000000のapplyは同じcanonical commandへsource apiで保存し、期限を再確認してreceiptを同一transactionに書く。20260729073126のresolverは90日保持と削除世代を確認。これはコード読解でありlive DB実測ではない。
- 修正/検証: strategyの全入口ghostという要約とprinciplesの直接確定未決を、MCPの直接書込・clientの操作確認・外部calendarの明示変換へ分けた。理由と原典、将来見直しの観点を残す。`pnpm docs:check` exit 0（`/tmp/dayopt-audit-mcp-contract-docs.log`）。コードが存在するだけを採用根拠にせず、明示判断を根拠にした文書訂正のため新規挙動testなし。

## F019 — 削除済みreceiptの終端エラーを再試行可能として返す

- 状態: ローカル再現・修正済み（`bbc0dfe8e`）。Mission #2963。本番・実DB実行は未確認。
- 条件/根拠: private.resolve_mcp_mutation_replay_v1はpurged receipt/旧data generationをDM008で拒否する。adapterのEXPECTED_ERROR_CODESにDM008が無く、想定外DBエラーとしてMUTATION_FAILEDへ入り、toolはretryable=trueを返していた。削除済みの保存結果は同じ操作の再送では復旧しない。
- 反証/修正: 既存NOT_FOUND/非再試行へ対応付け、削除済み結果の再実行やreceipt消去はしない。全mutationが通る同じmapを変更。未知のDB障害は従来どおりMUTATION_FAILED/再試行可能、想定外エラーの報告も維持。新しい公開error enumやDB権限は追加しない。
- 検証: real MCP SDK client/server → tool → real McpMutationClientの境界でPlan/Record作成を実行。DB adapterの戻りだけを合成しDM008/XX000を区別、applyの実呼出しも検査。修正前2 failed / 2 passed → 関連3 files / 42 passed、typecheck:product exit 0。ログ `/tmp/dayopt-audit-replay-error-{red,green,types}.log`。DB自身がDM008を生成することのクラウド実測を代用しない。

## F020 — Plan作成toolの未来限定という古い説明

- 状態: 説明修正。Mission #2963。入力schema/DB/認可/作成挙動は変更しない。
- 期待契約/根拠: 9月4日の時間特例撤去と9月7日の作成UI判断、plan-record仕様のPlanは過去・未来とも作成可。現行apply_mcp_plan_create_v1にも未来限定判定はないが、tools/listでAIへ渡す説明にfutureのみが残り、既に可能な操作を誤って制限して説明する。
- 修正/反証: 過去・未来とも作成可と明記し、learnの参照・journey正本と生成説明を同期。実装を根拠に新しい仕様へ変更したのではなく、明示判断に説明を合わせた。時刻のend>startやRecordのend<=nowは変更しない。文言一致だけの新規testは追加しない。commit `057697dfe`で生成説明と参照を同期、同製品コードでpnpm check exit 0・7417 tests passed。実DB/クラウド検証ではない。

## F006 — 前期間にしか記録がない活動が前期間比から消える

- 状態: 実行再現・修正済み（`c799b402b`）、回帰検査・`typecheck:product`・`docs:check`成功。
- 期待契約: Review仕様§1、§2の同じフィルタで期間比較する契約と、2026-09-15の前期間比表示の明示判断。現在0は非表示の選択とは異なる。
- 条件/影響: 今週Aに60分、前週Bに120分、フィルタなし。実際は60分減だが、前週を0分とし60分増と表示する。現在の記録が全く無い場合も減少を失う。
- 原因/経路: serviceのactivities集合は今期間のPlan/Recordだけ。ReportBodyはその集合をフィルタしてbuildUsageSummaryへ渡し、同関数は可視IDに含まれない前期間の活動を捨てる。個々の既存testはserviceがpreviousActivitiesを返すことと、clientが隠れた活動を捨てることしか見ず、集合をつなぐ不具合を検出しなかった。
- 反証: フィルタで隠す意図とは異なることをカテゴリー/活動の非表示ケースで確認。archived/null活動、今期間が空、空の一覧行や執行行が出ないことを確認。DBの取得条件・認可・書込は変更しない。集計値は現在期間のブロックだけから計算し、前期間は比較用IDの集合にのみ加える。
- 修正: 前期間の活動IDも今期間0の集計行として返し、既存のmetadataと同一フィルタを通す。UI操作数は不変。schema/migration/外部サービス変更なし。Mission #2963で追跡。
- 再現: Node24、`pnpm --filter @dayopt/product exec vitest run --project unit src/features/review/server/report-aggregation-service.test.ts`。修正前は1 failed / 19 passed。前期間の期待120分/1件/中央値120に対し0分/0件/null。修正後は同コマンド20 passed。
- 回帰: 境界ケース追加後、service + domain + ReportBodyの3ファイル107 tests passed、skipなし。DOMとfake DBを使うローカル検査であり、クラウドDB/E2E/本番観測ではない。ログは `/tmp/dayopt-audit-report-comparison-{red,green,regression}.log`。

## H007 — レポートの分類メタデータ取得のページング

- 状態: 未検証仮説、未修正。
- 根拠: report-fetchersはrecords/plansをcollectQueryPagesで取得するが、activities/categoriesは単発select。件数がAPIの上限を超えると、カテゴリー名/フィルタの所属が欠ける可能性。
- 次の反証: Supabase側max_rows、既存の分類一覧とページング方針、所有者・上限契約、大量データでのfakeと実環境の違いを確認する。現時点で本番発生を主張しない。
- 追加確認: activities仕様は件数無制限、repo configのmax_rowsは1,000。ActivitiesQueryServiceのlistActivities/listCategories/listTreeも単発selectで、MCP2ツールはそのserviceを利用。公式range資料も順序の指定が必要とする（https://supabase.com/docs/reference/javascript/using-modifiers-range）。実productionのmax_rows値は未確認。
- 反証/設計上の境界: 閉じた#1825本文を取得し、単一クエリ/単一スナップショットとmax_rows切り捨てへの注意が明示されていることを確認。単なるoffsetページングは途中のarchive/改名/削除で欠落・重複しうるため、そのまま採用しない。まず既存の単一snapshot取得経路と#1825の実装・後継判断を調べる。全件を返すSQL read wrapperが必要ならschema検証と非本番環境の使用条件を別途照合する。無言の切り捨てを仕様へ読み替えない。
- PR #1841の本文・対象一覧も確認。旧tagsではcount:exactと受信件数を比べwarnする契約であり、上限を除去した実装ではなかった。現行activities取得にはその検知もない。旧実装のdiffと#2162の移行判断は次に照合する。

## F008 — テンプレート中央値testが実行日に依存して失敗する

- 状態: 修正・検証済み（`8a5bc2c9f`）。runtimeの変更なし。Mission #2963。
- 条件/原因: 2026-09-01の固定fixtureに対して実時計で過去28日を取得するため、9月29日には対象外になり2件が失敗する。対象service/domain/fetcher/testが基準SHAから未変更なことをdiffで確認し、監査の製品修正が原因でないことを反証。
- 修正: testのDateだけを9月5日へ固定、afterEachで実時計へ復帰。test削除/skipなし。
- 検証: 全体checkで2 failed / 4318 passed → 対象10 passed → 全体checkのproduct 434 files / 4320 passed。ログ `/tmp/dayopt-audit-check.log`、`/tmp/dayopt-audit-template-clock.log`、`/tmp/dayopt-audit-check-after-clock.log`。本番観測ではない。

## F009 - Template and creation medians disagree at the window boundary

- Adopted after source reconciliation: current plan-record.md42, commit33e8944689/PR#2710 and latest settled#2567 comment5550377188 require actual Record elapsed duration; old general-service clipping comment is inconsistent, not a product exception.
- Synthetic crossing-window3x60-minute records: StatisticsGeneralService median60, template list/apply30. Red2/15 -> green17 with same command. Fetcher opt-out red1/1 -> green2; default lower/upper clipping and owner/deletion/overlap query predicates verified.
- New private optional fetchRecords clipToRange:false only used by template; existing clipping callers unchanged. Stale general-service comment corrected. Related6files50 passed, /tmp/dayopt-audit-template-median-related.log.
- Architecture generator run and exact5 test-list/count updates +1 surface count mechanically verified. Initial comparison script failed before writing evidence due incorrect summary whitespace; corrected exact-line comparison passed. No live DB/RLS/browser claim. Whole check running /tmp/dayopt-audit-check-template-median.log.

## F010 — 夏時間の時間帯集計が記録時間を失う/誤配置する

- 状態: ローカル再現・修正・対象回帰検証済み。Mission #2963。本番発生は未観測。
- 期待契約: report-periodの公称lengthMinutesはDSTを無視する一方、記録・予定集計値は影響を受けないという契約、AGENTSのtimezone/DST/半開区間契約。配分先はユーザーの壁時計の時間帯。
- 条件/影響: America/New_York、2026-11-01 23:00–23:30（UTC翌04:00–04:30）の記録が0分となる。開始日には3時の記録を2時へ誤配置する。期間全体と詳細パネル両方の時間帯分布が影響を受ける。
- 原因: 日の開始からの実経過分を0〜1440の壁時計の位置として比較。25時間の日の末尾は1440を超えて落ち、23時間の日は時刻が1時間ずれる。
- 反証: 公称週168hという意図的な仕様と区別。集計service/詳細serviceの両呼出しが表示期間（最大1年）へclipすることを確認。DB保存値や期間定義を変える必要はない。
- 修正: 実時間を単調に進め、時計の時間境界とoffset変更点で分けて対応する時間帯へ按分。繰り返す時刻は両方の実時間を計上、存在しない時刻は0。日数上限による途中打ち切りはなくし、clip済み終端で終了する。公開schema/UI操作数/DBは不変。
- 検証: 24時間の具体的な期待配列、6時間帯との整合、合計の保存を検査。修正前7 failed / 7 passed、修正後に日全体ケースを追加し、期間・時間帯・集計・詳細serviceの4 files / 88 tests passed。1時間/30分の時計変更、日境界、秒の端数、23/25時間の日を含む。ログ `/tmp/dayopt-audit-dst-{red,green}.log`。ネイティブ委譲不可のため主担当が期待時刻/呼出し元/反対のDST方向で反証。

## F011 — 機械的なpath一覧を実行手順と誤認するtaxonomy検査

- 状態: 修正・検証済み（`9851013ae`）。Mission #2963。
- 期待契約: 分類5はdocsの手順書からの参照。機械データにpathが載ることは実行を意味しない。
- 条件/原因: 今回のinventory.json追加により、多数のlibがrunbookへ誤分類された。既存JSONの試行記録や構造データも同じ誤検知を起こしうる。既存の参照優先順位を変えず、手順書の走査対象をMarkdown/MDXへ限定。
- 反証/検証: 合成repoでJSON一覧にだけ載る未使用scriptはunreferenced、実importされるscriptはlib、Markdown手順を追加するとrunbookになることを検査。修正前はfixtureと実repoの2件が失敗、後は関連16 tests passed、scripts全体110 files / 2625 tests passed。個別例外の追加や検査のskipでは解消していない。既存のworkflowコメント等を実行と誤認する一般的な制約は未解決のまま明記されている。

## F012 — アーカイブ済みカテゴリーの古い非表示設定がレポートに残る

- 状態: ローカル再現・修正済み（`9a3574988`）。Mission #2963。本番未観測。
- 契約/条件: activities仕様は所属categoryがarchivedならサイドバー・分析とも未分類へ寄せる。categoryを非表示にしてからarchiveすると、現役activityはサイドバーで未分類・表示中になるが、集計は古いcategoryIdでhiddenCategoryIdsを適用して記録を隠す。
- 根拠/反証: ActivitiesQueryServiceのtreeとReportFilterListはactive categoryだけで配置する。一方report-fetchersは全categoryのmetadataを返す。前期間比にも同じフィルタが使われる。復元時には元のcategoryで再びフィルタする必要があり、保存済みcategory_idをNULLにする修正は不適切。カレンダーブロック用のuseActivitiesMapは過去参照のlookupという別経路で、今回変更しない。
- 修正: レポートのcategory metadata取得をarchived_at IS NULLに限定。既存の未分類処理へ渡す。DB保存値・MCP生データの契約・UI操作数は不変。
- 検証: active/restoredとarchivedを分け、現在60分/前期間120分、カテゴリー非表示とactivity個別非表示を検査。修正前1 failed / 23 passed → 修正後aggregate・activities query・report view modelの3 files / 86 tests passed。ログ `/tmp/dayopt-audit-category-{red,green}.log`。クラウドDB実行ではない。

## F013 — 分類の変更後にレポートのキャッシュが更新されない

- 状態: ローカル再現・修正済み（`93d0774da`）。Mission #2963。本番未観測。
- 契約/条件: 同一sessionでactivityの改名/移動やcategoryのarchive/restore等を完了すると、一覧は新しい状態なのに、既に取得したレポートが古い名前・所属・フィルタで表示される。staleTimeの経過自体は再取得のトリガーではないので、表示中のレポートは次のmount/focus等まで残りうる。
- 原因/反証: activity/categoryの全mutationとundoはactivities-cacheを通すが、そこは分類一覧/予定/記録/statisticsだけをinvalidateする。reviewのperiod/detailは別キャッシュ。createAppQueryClientにも成功時の一括invalidateはない。timeblock書込にはreview更新があり、分類変更には無いことを照合。
- 修正: 全分類mutationとundoが通るinvalidateActivityCachesでreview routerもinvalidate。集計ロジックや楽観更新の意味は変更しない。型は利用するquery utilityのみに限定し、実clientを使うテストへ不正なcastを要求しない。
- 検証: 実TanStack QueryのQueryObserver + tRPC query key/utilityでfreshな旧reportを表示し、更新経路の後だけ新データを受け取ること、閉じたdetailはstaleになり無関係なbillingは維持されることを検査。修正前1 failed → 同コマンド1 passed。関連3 files / 39 tests passed、typecheck:product成功。ログ `/tmp/dayopt-audit-cache-{red,green,regression,types}.log`。API結果は合成データで、E2Eではない。

## H014 — 分類フォームと楽観更新の失敗・復元境界

- 状態: 読解からの候補。実行未再現、未修正。採用済み所見には数えない。
- 追跡する点: ActivityRenameModal / CategoryRenameModalはmutateAsyncをtry/finallyだけで囲み、イベント側はvoidで呼ぶ。hookのtoast後もrejectが未処理にならないか確認する。activity-tree-cacheのcategory復元は未分類にある旧所属activityを戻さず、refetchまで空に見える。全snapshotのrestoreは別mutationの成功と競合しうる。
- 次の反証: 実際の同時操作が可能なUI、tRPC/TanStack側の直列化、失敗時の回復・再取得を追う。コメントの意図や一時表示だけで直ちに不具合採用せず、操作後のユーザー可視結果で再現する。
- 改名フォームのrejectだけは再現してF017へ採用。他の復元/競合仮説は未検証のまま。

## H015 — 開いた詳細パネルの再取得・中断境界

- 状態: 読解からの候補。実行未再現、未修正。
- 根拠: ReportDetailTargetは名前・category名・色の選択時snapshotを保存し、ConnectedReportDetailPanelはquery再取得後もその値で見出しを描く。F013はperiod/detail queryの再取得を保証するが、選択済みtargetの同期までは保証していない。実際にパネルを開いたままmetadataを変えられる操作経路を確認する。
- 別の中断候補: ReportDetailResizeHandleはpointerupでwindow listener/body style/isResizingを解放するが、pointercancelやunmountのcleanupがない。ブラウザの実際の中断条件と共有resize実装を照合し、再現してから修正を採否する。
- 中断候補はcalendarの同種実装も再現してF016へ採用。選択済みmetadataの同期は未検証のまま。

## F016 — パネル幅変更の中断後に選択禁止とリスナーが残る

- 状態: ローカル再現・修正済み（`eb07b33eb`）。Mission #2963。本番未観測。
- 条件/影響: Review詳細またはCalendar側パネルでドラッグ開始後、pointercancel・unmountが起きると、bodyのcursor/userSelectとwindowのpointermoveが残る。Calendarではドラッグ中にrailを閉じても同じ。操作終了後も文字選択できず、後のポインター移動で幅が変わり続ける。
- 原因/反証: 両実装ともpointerupだけがcleanupを持つ。通常のpointerupやキーボード幅変更は既存契約を維持する必要がある。元のbody styleを復元し、単に既定値へ上書きしない。共有化で別のUI状態を結合せず、各所有者にlifecycle cleanupを追加。
- 修正: 共通終了callbackをrefに保存し、pointercancel・unmount・次のdrag開始、Calendarのrail closeからも呼ぶ。move/up/cancel listenerとresizing状態を解除。UI操作数/外部API/DBは不変。
- 検証: Review修正前2 failed / 23 passed、Calendar修正前3 failed / 13 passed。中断後のstyleとresizing状態、追加pointermoveで幅が変わらないことを検査。最終関連2 files / 42 tests passed、typecheck:product成功。ログ `/tmp/dayopt-audit-resize-report-red.log`、`/tmp/dayopt-audit-resize-calendar-red.log`、`/tmp/dayopt-audit-resize-regression.log`、`/tmp/dayopt-audit-resize-types.log`。DOM合成イベントでありクラウドE2Eではない。

## F017 — 改名失敗を通知した後も未処理のPromise rejectionが出る

- 状態: ローカル再現・修正済み（`0c299a246`）。Mission #2963。本番未観測。
- 条件/原因: ActivityRenameModal/CategoryRenameModalのsubmitはmutateAsyncをtry/finallyでawaitし、click/Enterはvoidで呼ぶ。mutation hookがtoast/rollbackしてもrejectは継続し、UIのイベント境界では未処理になる。
- 反証: 通知の所有者は既存hook/QueryClient。submitで通知やSentryを追加すると重複する。失敗時は閉じずに入力を保持し、isSubmittingを戻して再試行できるのが既存の挙動。
- 修正: 両submitでrejectをcatchし、通知・rollbackをhookへ委ねる旨を明記。finallyによる再操作可能化は維持。
- 検証: 実ModalとDialogで入力変更→保存失敗→draft維持/閉じない→再試行成功→closeを確認。修正前はassertion 2 passedだがVitestが未処理rejectionを2件検出してexit 1、修正後は2 passed・未処理rejection 0・exit 0。同じcommand/fixtureで比較。ログ `/tmp/dayopt-audit-rename-{red,green}.log`。API mutation結果は合成、実API/E2Eではない。

## F018 — MCP作成の分析イベントを送信しないという古い説明

- 状態: 文書修正。Mission #2963。runtime/同意/送信設定は変更しない。
- 根拠: journeys/mcp.mdは「plan_createdを送らない」とするが、toolはctx.userIdをMcpMutationClientへ渡し、createPlanは受領証検証後にtrackMutationEventを呼ぶ。posthog-serverは明示runtime switchと送信時点のanalytics_consentを確認し、afterで送信、失敗はcatchする。同じresource/eventは同じUUID、更新はresourceId:versionを使う。
- 反証/範囲: 送信予約は実取り込みの証明ではなく、switch未有効/同意なしでは送らない。コードと既存の成功・拒否・失敗testを全文照合。MCP/analyticsの挙動を変更する理由はこの所見からはない。実際の配信SHA/設定/取り込みは未確認。
- 修正/検証: journeyのJSON正本を直し、`pnpm learn:generate`で説明と逆引き資料を再生成。変更diffは該当説明と参照だけ。全体checkのproduct検査に既存MCP/analytics testsを含み成功、生成後にdocs:checkを別途実施。文書のみの訂正のため新規挙動testは追加しない。

## F021 — OAuth設定の正規化がproxyとhandlerで異なり正常接続を拒否する

- 状態: ローカル再現・修正済み（`73d656f70`）。Mission #2963。クラウド実測なし。
- 条件/根拠: OAuth originに末尾改行/前後空白、または任意originに空文字を設定。getOAuthEnvironmentConfigはtrim/空値未設定化で正しいidentityを返すが、proxyはraw process.envを同じresolverへ渡し503にする。env.ts自身もcleaned値だけを検証しraw値を返すので、この不一致を吸収しない。
- 修正/反証: envからの読み出しと既存正規化を純粋なresolveOAuthEnvironmentFromEnvへ移し両入口で共有。raw URI policyを緩和せず、foreign origin・Preview別branchは拒否、runtime marker・host・DB identity・gateは維持する。環境変数や実デプロイの変更なし。
- 検証: 実proxyと実handler用identity関数を同じ合成envで呼び、修正前2 failed/55 passed（handler成功・proxy503）。修正後はPreview一致/不一致を追加し、関連6 files/165 passed、typecheck:product成功。ログ `/tmp/dayopt-audit-oauth-env-{red,green,regression,types}.log`。normalization helperの戻りだけをmockしたテストではない。全体checkは別記録。

## F022 — セッション監視testのstore mockが実装へ届かず合格する

- 状態: 再現・修正済み（`83c6d3c994376da7154dbc8279a2534d926f79fe`）。Mission #2963。製品挙動の変更なし。
- 条件/原因: useSessionMonitorは`../stores/useAuthStore`をimportするがtestは`./stores/useAuthStore`をmock。意図したsession/signOutが注入されず、logoutのassertは共通の遷移だけを見るため、別の失敗経路でも成功する。初期状態trueだけのassertも初回microtask前に通る。
- 反証/修正: signOut呼び出し回数と注入したrejectを受けたloggerの引数を追加すると2 failed/7 passed。正しいmoduleへmockを合わせ、初期状態testはmicrotask判定後まで待つ。hook自体をmockしていない。runtimeの認証契約を変える根拠はない。
- 検証: 関連hook/storeの3 files/24 passed。`/tmp/dayopt-audit-session-mock-{red,green}.log`。実GoTrue・ブラウザE2Eの証拠ではない。

## H023 — 現行監視とは別のセッション検証helper

- 状態: 読解候補。採否未確定。
- 根拠: session-config.tsのvalidateSessionはremainingTimeでexpiresAt-nowのmsとidle/absoluteの秒を混在させ、token-expiry.test.tsもmsを期待する。一方、repo横断参照検索ではhelper呼び出しはtestのみ。実際のuseSessionMonitorはSESSION_CONFIGとSESSION_SECURITYだけを使う。
- 次: dynamic import・公開参照・残すべき契約を確認し、未使用責務の撤去か単位訂正を決める。現時点では本番のセッション期限検証漏れとは扱わず、実経路とtest用の古いhelperを区別する。

## H024 — ログアウトの返り値errorと例外の非対称

- 状態: コード上の候補、再現前。
- 根拠: useLogoutとAccountSettingsはobserveAuthOperationをawaitするが、戻り値のerrorを読まず成功toast/遷移へ進む。observeAuthOperationは返り値errorを記録して返す契約で、throwへ変換しない。既存useLogout.test.tsの失敗はrejectだけ。session-monitorもstoreの返り値errorを未検査だが、その既存契約はエラー時も遷移なので同じ修正を機械的に適用しない。
- 次: SDKのsignOut失敗時のローカルsession保持をソースと合成実行で確認し、通常logoutの返り値errorを再現。AccountDeletionDialogはAuth削除完了後のbest-effort cleanupであり同じ原因に数えない。設定画面と共通hookは両方を閉じる。まだ修正/本番観測とは報告しない。

## H025 — 非同期cache復元と認証主体変更

- 状態: 読解候補、未再現。
- 根拠: persisterはresolveUserId後に複数awaitを跨いでrestore/persistし、QueryCacheAuthBoundaryのclearは別effect。開始時と完了時の主体が一致するか、logout/別user loginが途中に入る場合を確認する。既存testは順次完了したA→Bのみ。
- 次: Providerのmount境界、TanStack復元中のhydration・subscribe開始、SDKのauth event順序を確認し、実際に前userのcacheが復元/保存される操作列を再現する。可能性だけで情報漏えいと断定しない。

H024の反証追記: installed `@supabase/auth-js@2.116.0` のGoTrueClient.ts 4045–4138を確認。通常signOutのadmin失敗はerrorを返す前に_current sessionを削除する実装へ変わっている（scope=others以外）。したがって「戻り値errorを無視すると必ずローカルログインが残る」は成立しない。早いsessionError分岐は別であり、実際の通知/遷移とglobal revokeの保証を分けて検証する。戻り値errorで一律に遷移を止める修正も、既にローカルlogout済みの利用者を画面に残すため未採用。

## F025 — cache破棄後に遅い復元・保存が旧データを戻す

- 状態: H025のうち破棄済みcacheへの再投入をローカル再現・修正（`605d4e613`）。Mission #2963、既存の分離契約#2619。実ブラウザ/本番未観測。
- 条件/根拠: persisterの所有者確定後のstorage.getItemが遅れ、その間に主体変更でQueryCacheAuthBoundaryがmemory/storageをclear。遅い結果が返ると実TanStack persistQueryClientRestoreが旧blobを再hydrateする。同様に遅い保存/所有者解決がclear後に完了すると旧blobが復活する。
- 反証: 順次A→Bの既存testは通るため、clearを実行済みでも後続の旧処理に勝てない順序を制御して検査。SDKの復元・hydrateをmockせず実QueryClientのデータを確認。SDK @tanstack/query-persist-client-core/react-query-persist-client 5.102.8のrestore/subscribe実装も全文確認。ユーザー識別や現行envelope自体は正しいが、処理の寿命が分離されていなかった。
- 修正: module世代でclear前の所有者解決・読み取りを無効化。storageの変更処理を直列化し、開始済みwrite完了後にclear、未開始の旧世代write/evictionは実行しない。失敗したwriteが後続clearを止めない。auth clearとpersister removeの両方を対応。オフラインfallback、保存形式、2時間保持、公開APIは維持。
- 検証: 修正前3 failed/9 passed。修正後は両clear入口、新主体の保存/復元、保存失敗からの回復を加えて関連4 files/30 passed、typecheck:product exit 0。ログ `/tmp/dayopt-audit-cache-races-{red,green,regression,types}.log`（初回単独restore再現は`cache-race-red.log`）。storageは遅延を制御する合成実装であり、実IndexedDBや別タブE2Eの証拠ではない。
- 残る照合: auth eventからReact effectのclearが発火するまでの区間、別documentの寿命、Provider unmountと復元の関係はH025の残作業。今回確認したclear前開始→clear後完了の経路を越えて「全cache境界を検証済み」とはしない。

## H026 — 回復コードのtiming testが非負の計測値なら必ず合格する

- 状態: 数式上の検証欠陥候補、未修正。recovery-codes.test.tsの平均時間差は`abs(a-b)/max(a,b)`（a,b非負）で0〜1なのに、閾値は2.0。早期returnの有無を検出できない。計測の揺れを弱めたという説明は保証にならない。
- 次: 既存の手書き比較とNode native timingSafeEqualの境界を照合し、実測タイミングを安全性の証明にせず、先頭/末尾差分・異長/不正値の機能検証と実装根拠を分ける。HIBP testにもboolean型だけで大文字小文字契約を検証したように見せるassertがあり、外部API契約と照合して整理する。暗号機能の破綻/本番漏洩とは未判定。

## F023 — 実認証経路から呼ばれない別のセッション判定を撤去

- 状態: H023を採用、`40d9be4b301735026f376ffc37f6f53cf19a502c`で修正。Mission #2963。
- 根拠/反証: repo全体の参照・dynamic entry・knip設定・private packageの公開境界を確認。validateSession / shouldShowTimeoutWarningと専用型は2 testのみが使い、現行useSessionMonitorはSESSION_CONFIG / SESSION_SECURITYだけを参照。単位を修理して別モデルを残す理由はない。現行の監視・tRPC認証/MFA/OAuth制約は別実装であり変更しない。
- 修正: 未使用helperとその専用fixture/assertを撤去。定数と6件の定数test、token-expiry.testの11件の実protectedProcedureテストは維持。
- 検証: 関連4 files/35 passed、typecheck:product exit 0。ログ `/tmp/dayopt-audit-session-obsolete.log` / `dayopt-audit-session-obsolete-types.log`。未使用コード撤去のため挙動のred/greenとは扱わない。timeblock/lib/time testの削除ではない。

## F026 — 回復コード比較の標準実装と検証根拠を分離

- 状態: H026の回復コード部分を採用、`9b10660eb`で修正。Mission #2963。HIBPの弱いassertは継続調査。
- 根拠: 非負の平均時間a,bに対してabs(a-b)/max(a,b)は最大1で、閾値2.0の旧testは百万倍の差でも通る。手書きXOR比較をNode crypto.timingSafeEqualへ置換し、byte長guardとUTF-8比較で従来の文字列一致を維持。hex decodeの不正値切詰めや大文字小文字同一視を導入しない。HMAC・pepper・入力正規化・保存形式は不変。
- 反証/検証: 先頭/中間/末尾の不一致と異長/不正stored hashの機能検証は修正前39 passedで、挙動バグのred/greenではない。変更後関連2 files/51 passed、typecheck:product exit 0。ログ `/tmp/dayopt-audit-recovery-functional-before.log` / `dayopt-audit-recovery-native.log` / `dayopt-audit-recovery-native-types.log`。実タイミング攻撃や本番漏洩を再現したとは主張しない。
- 実装根拠: [Node24公式crypto仕様](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b)は同byte長のnative比較を定義し、周辺コード全体のtiming safetyまでは保証しない。時間計測testを暗号保証の証明として残さない。

## H027 — エクスポートの全件取得とAPI上限

- 状態: コード上の候補、再現・採否は未確定。
- 根拠: user-service.exportDataはplans/records/categories/activitiesを1回ずつ取得し、ページ走査がない。repo supabase/config.tomlのmax_rowsは1000。画面は取得後に期間フィルタし全期間を選択できるため、上限を越す場合の欠落を調べる。実クラウド上限は未取得で、本番欠落とは断定しない。
- 次: 公開仕様・既存Issue・DB列と既存page取得方式を照合し、API上限を再現する合成境界testを先に作る。独立して画面の期間境界/共有query結果への直接代入も確認する。H007の分類単一snapshot契約とは同一の修正と決めない。

## F027 — 全件エクスポートがData APIの1回取得上限で途切れる

- 状態: H027の件数上限部分を採用、`b82badf0eef2fd02459697b36e2be19c834e2af7`で修正。Mission #2963。既存Issue検索で同じ現行exportの欠落を直接扱うIssueは見つからず、Missionで追跡。
- 期待契約/根拠: 公開data-export docsは全期間を含む出力を案内し、UIにもallがある。serviceの4 collectionはpage指定も走査もなく、repo設定max_rows=1000では超過分を取得しない。単一profile/settingsとは別。実クラウド上限・本番欠落は未観測。
- 再現: 実Supabase SDK→合成HTTP（1000行cap）→実serviceを通す。4種類各1201件の完全一致と4種類の後続page失敗拒否で、修正前5 failed/47 passed。ユーザーfilterはHTTP側で全リクエストにassertし、SDK/query builder/collectQueryPagesはmockしない。
- 修正/反証: 既存collectQueryPagesを各collectionへ適用、毎pageの認証済みuserId制約・安定したid順を維持。既存の列選択、service-role/user-scoped clientの境界、戻り値形式とEXPORT_FAILED変換は不変。後続page失敗時は部分データを返さない。新しい共通化・DB機能は追加しない。従来も6照会に分かれたexportで、今回も同時編集に対する単一DB snapshotは保証しない。500未満にAPI上限を下げた環境もこの合成検査の証明範囲外。
- 検証: 関連2 files/54 passed、typecheck:product成功。初回型検査はtest fixtureの必須dependencies不足を検出し修正、再検査成功。ログ `/tmp/dayopt-audit-export-pages-{red,green,types}.log`。実DB integrationは未実行。統合checkは別記録。
- 残るUI候補: refetch error時の既存data再利用、期間フィルタによるquery結果への直接代入、日付境界。settings仕様のPro限定文言は現行billing仕様・公開docsと不一致。元判断へ戻って裁定する。

## F028 — settings仕様に残ったexportのPro限定説明

- 状態: 文書修正。Mission #2963。製品・課金判定は変更しない。
- 裁定根拠: docs/decisions.md 2026-09-07はexport Free、2026-09-08の更新判断は単一有料プラン移行後も終了後の閲覧/export/削除を残す。現行billing仕様・operation-access・protected query・公開data-export docsは後者と一致。settings仕様だけがPro限定の古い説明を維持している。
- 修正/反証: settingsの1文を終了後も利用できる本人管理操作へ訂正し、現行Billing仕様を参照。古いFree/Pro境界をruntimeへ復活させない。公開docsのJSON復元・含まれる設定の説明は別の未照合部分であり、この訂正で承認したとは扱わない。

## H029 — エクスポートUIの失敗・期間・共有データ境界

- 状態: 読解候補、再現前。H027のUI側を分離。既存journeyにも同じ弱点の記載があるが、記載だけで実測としない。
- 根拠: handleExportはresult.dataのみを判定。installed TanStack query-core 5.102.8のqueryObserver.ts（279–285、340–370、582–619）はrefetch既定でrejectをcatchし、dataとerror/isRefetchErrorを同時に返す。過去dataがある失敗を成功に見せる可能性。期間フィルタはcacheから受けた配列を直接置換し、開始はUTC日付/終了はbrowser日付で異なる境界。利用者timezoneを参照しない。
- 次: 実QueryObserverの成功→失敗をcomponentのrefetch境界へつなぐ再現と、期間選択→全期間のcache不変、設定TZの日境界を検査する。期間跨ぎをstart_at基準からoverlapへ変える判断は今回混ぜない。日付未入力/逆転の扱い、exportのIndexedDB保持や復元可能性の公開説明も別に契約確認する。
- 関連候補: ConfirmDialogはonConfirmをawaitするがfinallyのみ。DataSettingsのdelete mutationはonError通知後もmutateAsyncがrejectする。同じ未処理rejectionの可能性を呼出元全体で照合する。MCP URLコピーもclipboardのPromise未処理で成功通知する。まだ製品不具合の再現済み件数に含めない。

## F029 — 再取得失敗を古いexport結果で成功扱いし、期間指定がcacheを変更する

- 状態: H029の失敗/共有data部分を再現・修正（`1ea132c53`）。Mission #2963。製品API/保存形式は不変。
- 再現/根拠: 実QueryObserver（retry:false、成功後にqueryFnを失敗）をUIのrefetchへ接続。2回目はisRefetchError=true/dataありで返り、旧UIは成功通知・2つ目のBlobを作る。別caseで期間内/外を含むquery結果を渡すと、ダウンロードは絞れるが元のplans/records配列まで置換される。修正前2 failed/1 passed。
- 修正/反証: refetchのisErrorとdataを両方確認し、export用envelope/dataを浅いcopyにしてfilter結果をそこへ格納。行自体は書き換えないため深いcopyは不要。ネットワークrejectだけのmockでTanStackの結果契約を代用していない。単なる通知変更ではなくBlobが増えないことを確認。
- 検証: 関連3 files/16 passed、typecheck:product成功。ログ `/tmp/dayopt-audit-export-ui-{red,green,types}.log`。取得前の入力/期間境界はF030。IndexedDB保持と公開restore説明は継続調査。

## F030 — export期間の開始/終了が異なるtimezoneで解釈される

- 状態: H029の期間境界を再現・修正（`4ec2fd6bf8f3e9cccc1130a145e43940e8c02e7e`）。Mission #2963。
- 期待契約/根拠: timezone.mdの利用者設定を正本にする規則と既存useUserPreferences/getDateKeyへ照合。旧startはnew Date(YYYY-MM-DD)でUTC、endだけbrowser setHours、設定TZを使わない。JST/NYのDST開始・終了の日で境界の内外を用意すると3 failed/3 passed。期待値は各日のUTC instantを固定し実装と同じ変換式をコピーしない。
- 修正/反証: 既存preferences queryからtimezoneを取得、start_atをそのTZの暦日キーに変換して選択日と比較。固定24h演算や新しい時間helperを導入しない。期間を跨ぐ行をstart_atで選ぶ既存契約、CSV列、export操作数は維持。実preferences hookのselectを通すfixtureで設定の接続も検査。
- 入力境界: customで片方未入力または逆転している場合、全期間/空結果を成功出力することも3 failed/6 passedで再現。問い合わせ前に拒否し既存のexportFailed通知へ接続。新しい文言・確認ダイアログは追加しない。
- 検証: 関連4 files/25 passed、型検査成功。ログ `/tmp/dayopt-audit-export-tz-{red,green}.log` / `/tmp/dayopt-audit-export-range-{red,green,types}.log`。実ブラウザの保存完了/実DB検証ではない。journeyの正本JSON/生成資料を同期しdocs:check成功。

## H031 — ConfirmDialogへ渡す削除処理のreject処理が不統一

- 状態: 呼び出し境界を照合、再現前。DataSettingsのdeleteBlocks/deleteAllDataとActivityFilterListのhandleConfirmDeleteが、既存のonError通知後もmutateAsyncのrejectをConfirmDialogへ返す。ConfirmDialogはfinallyでloadingを戻すだけで、React clickの返すPromiseは未処理になりうる。
- 反証: Google切断・MCP revoke・iCal再生成はcallsiteでcatch済み。ExternalEventCardのdismissはuseConvertGhostEvent内部でcatch。TemplateListはCalendarSidebarのmutateを呼ぶため同じreject経路ではない。共通ダイアログで全例外を無条件に握りつぶす修正は未採用。
- 次: 2つの未処理候補を実UIと失敗→再試行で再現し、通知の所有者を既存mutationに保ったまま最小のイベント境界で閉じる。Activityのfinallyによる閉じ方を無関係に変えない。既存testを使えるか確認する。外部API/DBの削除は実行しない。

## F031 — 削除失敗の通知後に未処理rejectionが残る

- 状態: H031を採用、`ef0f9e572`で修正。Mission #2963。実DBの削除は実行しない。
- 再現: DataSettingsのblocks/allとActivityFilterListのactivity/categoryを実TanStack useMutationと実ConfirmDialogへ接続。各画面の修正前は2 tests passedでも2 unhandled errorsで実行全体がexit 1。通知callbackのassertだけではこの欠陥を見逃す。ログ `/tmp/dayopt-audit-data-delete-red.log` / `/tmp/dayopt-audit-activity-delete-red.log`。
- 修正/反証: 未処理の2 callsiteでrejectを処理し、通知・rollbackは既存mutationの責務に保つ。DataSettingsは確認入力を保って再試行、ActivityFilterListは既存finallyによるcloseを維持。Google/MCP/iCal/ghost/templateは処理済みで変更せず、共通ConfirmDialogへ無条件catchを追加しない。
- 検証: 失敗→再試行、通知回数、送信ID/確認値、ダイアログ状態を検査。関連6 files/43 passed・unhandled errorsなし、typecheck:product exit 0。ログ `/tmp/dayopt-audit-delete-{green,types}.log`。Activityのhookは実mutationを使う合成fixtureで、既存rollbackそのものや実DBの保証を新たに実測したものではない。

## F032 — MCP URLコピーが書き込み前・拒否時にも成功を表示する

- 状態: H029のclipboard候補を採用、`ef0f9e572`で修正。Mission #2963。
- 根拠/再現: navigator.clipboard.writeTextのPromiseを待たずにcopied状態・成功通知を更新。遅延Promiseの完了前通知とNotAllowedError時の失敗通知欠落を操作で再現、修正前2 failed/3 passed。拒否理由や実際のclipboard内容は記録しない。
- 修正: 書き込み成功後だけ成功状態を設定し、拒否/同期例外は既存common.toast.copyFailedで通知。再試行可能。接続URLの組み立て、利用権判定、コピー操作数は不変。汎用clipboard抽象化は追加しない。
- 検証: 遅延完了・拒否→再試行を含む関連3 files/9 passed。ログ `/tmp/dayopt-audit-copy-{red,green}.log`。Clipboard APIは合成であり、実ブラウザ権限/OS clipboardの観測ではない。統合checkはMissionへ別記録。

## F033 — Calendar削除のsettle cronをprovider revoke担当と説明している

- 状態: 仕様文書を訂正。Mission #2963、元実装判断#2055。runtime変更なし。
- 根拠: external-calendar specは接続削除・revokeを独立cronが担うと記載。全文確認したroute/dispatcherはlist_expired→normalize RPCだけを呼ぶ。2257行のcalendar_account_deletion_fence migrationとサービスを照合し、実provider呼出しはアカウント削除リクエスト内のdispatch、cronは期限切れintentと未確定receiptの整理であることを確認。
- 裁定/反証: #2055本文と確定plan・変更記録（issuecomment-5321803048）は1 RPC=1 transactionで期限切れintentをnormalizeする方針。途中のmaintenance同居案は撤回されており最終方針へ照合。現行コードを理由に契約を変更したのではない。confirmed/unconfirmed/not_attemptedを一律の「Google失効成功」へ変えず、再送しない既存設計を保つ。
- 検証: docs:check exit 0（`/tmp/dayopt-audit-calendar-docs-check.log`）。DB実行・Google失効・実クラウドcron成功の証拠ではない。migrationは直接編集しない。ctx2055はL1 missing/staleのため本文・コメントと一次コードを使用。

## H034 — 削除step完了の期限評価がロック待ち前の時刻を使う

- 状態: コードと既存検証範囲を照合した候補、実DB再現前。未採用・未修正。
- 期待契約/根拠: `20260730090037_reject_expired_account_deletion_step_lease.sql`は「別workerによる再claim前でも期限切れだけで無効」と明記。ただしcomplete_account_deletion_step_v1はDECLAREのclock_timestampをCONSTANT v_nowへ保存し、その後auth parent/user advisory/step rowのロックを待ってから同じ時刻でlease_expires_atを比較する。期限直前に入ってロック待ち中に越す場合、検査時点の期限とは異なる可能性がある。
- 反証/範囲: 完了済みreplayはtrue、他workerによりlease IDが変更された場合は別条件で拒否されるため、任意の古いworkerが通るとは主張しない。既存account-deletion-gate.integration.test.ts 347-388は呼出前の期限変更→AD019→reclaim→旧ID拒否。concurrency test1198行はStorage/Billing/Customer/Plan/Record/webhook/cleanup競合を扱うが、completeのロック待ち中期限超過は含まない。Calendarのstart/finalize等にも入口時刻の保持があり、同じ修正を機械的に適用せず各契約を調べる。
- 次: 現行DB helperのlock順と後続migration、元契約Issueを照合し、承認済み隔離DBで期限前に待機開始・期限後解放を制御して最終stateを確認する。既存integrationはlocalhost固定・USE_LOCAL_DB gate・共有activation更新を含むため、未検証のクラウド接続先へ付け替えて実行しない。コード上の時間差だけを本番不具合/認可漏れと断定しない。

## H035 — Subscription更新の遅延配送が終了状態や別契約を上書きする候補

- 状態: 原文・route/service/claimの全文確認によるコード上の候補。操作による再現・修正前。Mission #2963で継続し、Issue化を修正完了へ数えない。
- 期待契約: billing仕様は現在のStripe statusを同期し、canceled/unpaidでは終了後へ移る。Stripe公式の[Event ordering](https://docs.stripe.com/webhooks#event-ordering)は配送順を保証せず、同秒timestampで順序を決めないこと、APIでEventを再取得しても元のsnapshotが変わらないことを明記（2026-09-30取得）。
- 根拠: routeのupdatedは照合済みEvent.data.object.statusをsyncSubscriptionStatusへ渡す。serviceの更新条件はCustomerだけで、現在Subscription IDやイベント前後関係を判定しない。claimはevent_id単位の重複防止で、異なるEvent間を順序付けない。deleted専用RPCは現在Subscriptionとの一致を判定し、終了時はsubscription_idをNULLへするが、後続updatedは同じCustomerへID/statusを再設定できる。
- 想定条件/影響: deletedが先に保存された後、未処理の古いactive updatedが届く場合、終了済み利用権を復活させる可能性。再契約後の旧Subscription更新でも新しいIDを上書きする可能性。Stripe/DBの実観測や本番発生は未確認。
- 反証/制限: 同一event_idの再送はprocessedなら除外される。durable provider照合はAccount/Mode/Event identityを保護するが、Subscription最新状態の確認ではない。checkoutはSubscriptionを再取得するためupdatedと入力の鮮度が異なる。ただし再取得だけでも別契約・並行DB更新との競合は閉じない。既存route testのupdatedは解約予約activeの1例、serviceの状態遷移testは別mockで例外なしを確かめるだけで保存状態の連続性を検査しない。
- 次: 元課金Issueの要求・provider identityとSubscriptionの対応・初回bind/再契約・削除中のロック契約を照合し、実route+serviceと状態を保持する合成DB応答で遅延配送を再現する。現在状態の再取得、条件付き保存、必要な直列化を比較し、一つの原因をcheckout/updated/deletedを横断して閉じる。event.created比較だけの修正は採らない。新規機構や本番書込みは不要。独立して進める全文読解は継続する。

## F035 — 遅延Webhookと並行更新が現在の課金状態を上書きする

- 状態: H035のlive profileでの上書き原因を再現・修正。統合検査中。Auth削除後の遅延checkout/updatedとterminal receiptの全イベント分類は未完了として残す。
- 再現: 実route・実billing service・実provider identity関数を通し、イベント間でprofileを保持する合成DB/Stripe応答を使用。解約deleted成功後の古いactive updatedでcanceled→active、再契約後でsub_new→sub_oldを再現。red 2 failed（`/tmp/dayopt-audit-webhook-ordering-red.log`）。実providerや実DB観測ではない。
- 修正: checkout/updatedで現在Subscriptionを5秒・再試行なしで取得し、ID/Customer/modeを照合。現在canceledならexact subscriptionの終了経路を使い、旧snapshotを保存しない。provider取得前のprofile ID/status/updated_atを保存条件へ加え、競合時は既存500/claim解放から再送する。legacyは既存profiles列の条件付きUPDATE、durableは既存terminal RPCを使い、新規migrationやActivation変更はない。
- 反証: ID/statusだけの条件付き更新では、途中の遷移から同じ状態へ戻るケースを見逃す。別redで200となる失敗を確認（1 failed/5 passed、`/tmp/dayopt-audit-webhook-ordering-aba-red.log`）、既存profile updated_atを条件に追加。baseline SQL 22–32/112–127はNOT NULL timestampと全UPDATE triggerを定義。これは部分読解で、巨大baseline全文確認に昇格していない。旧経路もexact IDを確認し、遅いdeletedで別契約を終了しない。
- 検証: 関連3 files/58 passed（ordering 8件含む）、型検査成功。ログ `/tmp/dayopt-audit-webhook-ordering-regression.log` / `/tmp/dayopt-audit-webhook-ordering-types.log`。後者は最初の修正時点の結果で、最終組合せの型検査は全体checkに含める。保存条件は合成query builderで検査し、実PostgREST/DBの行ロックを実測したものではない。legacy/durable双方の遅延更新、再契約、並行削除、同状態復帰、Customer不一致、遅延checkoutを検査。
- 残り（記録時点）: profile消滅後のupdated/checkoutの終端分類は後続F036で再現・修正済み。複数の同時active契約という既存データ異常の裁定は別途未確認。通知の過去previous_attributesの意味、実Stripe mode・実DB・配信は未確認。F035を全体監査完了やこの残りの修正完了と扱わない。

## F036 — 削除済み顧客への遅延Checkout/更新を短期receiptへ分類しない

- 状態: F035の残りのterminal account経路を再現・修正。Mission #2963。main #2968統合内容でpnpm check exit 0、7631 passed（f11715af7）。
- 契約/根拠: billing仕様のCustomer-bearing eventはlive profileまたは30日削除receiptへ分類し、未知Customerは成功扱いにしない。migration052の既存service-role専用RPCはliveを優先し、profileがなければ有効なhashed receiptだけをaccount_deletedへする。routeはinvoice/deletedには適用するが、checkout/updatedはprofile snapshotへ直接進んでいた。
- 再現: 実route/service/identity +合成DB応答で、削除receipt有効のcheckout/updatedが500を返し、再送でも終端しないことを確認。分類とprofile取得の間に削除が入るfixtureも、最初の失敗後に再送が500のまま。red4 failed/10 passed（`/tmp/dayopt-audit-webhook-deleted-red.log`）。初回fixtureは分類hook未発火で競合自体が発生していなかったため棄却し、実際のprofile取得境界で削除状態へ変わるfixtureに直した結果だけを採用。
- 修正/反証: durableのcheckout/updatedもprovider Event identity確認・event claim後、既存Customer分類を通す。有効receiptなら追加Subscription API/DB更新/通知へ進まずprocessedへ。未知/期限切れreceiptは既存serviceのFETCH_FAILED→500/claim解放を維持。分類live後のAuth削除は当該取得失敗を勝手に成功扱いにせず、次の再送のreceipt分類で終端する。legacyへ未導入RPCを追加しない。DB migration・receipt保持期間・課金権限は不変。
- 検証: 同コマンドgreen14 passed。関連Webhook5 files/85 passed（`/tmp/dayopt-audit-webhook-deleted-regression.log`）。fixtureはreceiptの有効性判定結果を代替し、実DB expiry/lock・実Stripe・本番発生は未確認。expiry判定は既存SQL契約へ照合し、削除済みなら無条件に成功する実装はしない。

## F037 — Supabaseの短縮SQL雛形が権限規則と現行helperに反する

- 状態: 文書修正・docs:check成功。Mission #2963。DB/runtime変更なし。
- 契約/根拠: 同skillの新規public object規則はREVOKE先行・GRANT・権限検査を同一migrationに要求する。全文確認したSQL雛形はREVOKE/権限検査を欠き、実際の現行migration集合にないhandle_updated_atを呼ぶ。archiveにだけ旧定義と廃止があり、現行baselineはupdate_updated_at。
- 影響/反証: コピー時のmigration失敗・環境default ACL由来の過剰権限の候補。既存の稼働DBにこの雛形が適用された事実や本番漏洩を確認したものではない。RLSはTRUNCATEを防がず、既存規則を短縮雛形が打ち消す状態は残さない。
- 修正: 重複した不完全SQLを撤去し、同skillが既に指定するcreate_segments migrationへ参照を一本化。参照先193行を全文確認、REVOKE先行/role別GRANT/DO権限検査/現行updated_at helperを照合。policyとgrantは対象の操作境界へ合わせる旨を明記。新しいルールやDB migrationは足さない。
- 検証: Node24 pnpm docs:check exit 0（`/tmp/dayopt-audit-supabase-template-docs.log`）、相対参照先の存在/現行内容とdiffを確認。文書変更であり実SQL red/greenや本番実測とは報告しない。

## H038 — insert Undoのfull maskと現在のmutable列が一致しない候補

- 状態: 原契約/現行SQLによる候補、実DB再現前・未採用。Mission #2963で継続。
- 契約: #2434本文と9コメントを全文取得。updateはmask内の値比較・ABA許容、insertの逆操作は行全体削除なので失われる全mutable fieldとlifecycleをguardする。行単位CASへ引き戻さない。ctx2434も取得し、古い設計レビューを現在の運用指示へ読み替えない。
- 根拠: current contraction migrationのundo_full_maskはdeleted_at/end_at/note/start_at/titleのみ。record commandはactivity_id/fulfillmentを更新できる。一方record_undo_receiptのfull-mask一致検査とapplyのDELETEは保存field changesだけをCASにするため、事後のactivity/fulfillment更新がmask外に残る可能性。create_segments例の安全性とは別原因。
- 反証/範囲: repoのruntime TSで当該record/apply RPCのliteral callsiteは検索範囲で見つからず、現在はDB substrate/統合testに限る。動的呼出し・実環境・実DB再現は未確認。既存のmask内note編集は保護され、update effectへfull-row CASを追加する修正は不適切。
- 次: substrate/record RPCと統合testの残り全文を読み、insert receipt後のactivity/fulfillment更新を隔離DBで再現する。既存receiptの短期TTL/保持/互換条件とconsumer計画を照合し、新しい列をblindに必須化しない。実DB対象の確認が必要であり、共有activationや本番へ検査を向けない。

H038追記: 初期RPC948行・後続guard27行・統合test931行を全文確認。#2394の移設Step3原文§4はinsert作成時全フィールドを要求する。現行testは5列だけをfull maskとして複製し、activity/fulfillment事後変更の負例は無い。現在検索したapps/packages/scriptsにはgenerated types・testを除くRPC callsiteは無い。#2435のclosed/activation OFF計画を実装・配信証拠にはしない。ローカルDB専用test未実行。更新Undoのmask外変更を許す契約を行全体CASへ変更する提案は却下し、insert側だけの保護と旧receipt互換を次に調べる。

## F039 - Activity/time updates do not optimistically enter destination list caches

- Status: reproduced and fixed in 7b5508ff1; whole check running. Mission #2963. Distinct from H038 DB receipts.
- Contract: Inspector activity selection saves immediately; user mutations update detail/list/filter caches while awaiting persistence. Omission preserves activity, explicit null clears it. Keep raw microsecond updated_at.
- Cause: handleActivityChange -> enqueueSave -> updatePlan/updateRecord. Both patches lacked activityId; patchMatchingLists only visited caches already containing the row, so destination activity/time lists stayed empty.
- Reproduction: Node24 pnpm test -- src/features/timeblock/hooks/useTimeblockWriteMutations.inline-error.test.tsx actually ran all product unit tests: 2 failed/4517 passed, both expected activity-after but got activity-before. Same command after fix: 4519 passed. Additional targeted boundaries: 2 files/26 passed, final target 23 passed. Logs /tmp/dayopt-audit-activity-optimistic-{red,green,boundaries,final-target}.log.
- Fix: both patches map explicit activityId to activity_id. Reuse server-row list membership handling for destination caches, but patch each existing cache row independently so newer untouched fields are preserved. Search remains server-revalidated; unknown offset page insertion is avoided. Existing snapshot rollback remains.
- Countercheck: Inspector local value does not update list caches. Copying the first cached row over all existing rows was rejected because it can regress newer note/version. Test preserves those fields. Server/DB contract, permissions and interaction count unchanged. Actual hook callbacks with synthetic cache/tRPC, not browser/DB observation. Whole-snapshot concurrent rollback and temporary-ID collisions remain separate candidates.

F039 verification completed: whole pnpm check exit0 at product7b5508ff1, 7637 tests/types/lint/static/deadcode successful; docs:check exit0. Reproduction and synthetic-boundary limits above still apply.

## F040 - Temporary IDs collide across independent create/apply operations

- Status: reproduced and fixed; full check running. Mission #2963.
- Contract: each optimistic resource has independent identity; completing one operation removes only its temporary rows. ID format is internal and retains temp- prefix.
- Cause/conditions: normal Plan/Record create uses Date.now only; two operations in one millisecond share IDs. Template application uses template/block ID only, so applying the same template to two dates reuses IDs regardless of clock. Existing insertion helper removes same-ID rows, silently replacing another operation. Completion then removes another operation's pending row.
- Reproduction: final red command (Node24 filtered vitest run, two existing files)3 failed/33 passed; normal lanes retained only Second instead of First+Second; template had2 temporary rows instead of4. Initial test was made independent of lane sort order before final red; no production code changed between red runs. Green same command36 passed. Logs /tmp/dayopt-audit-temp-id-{red-final,green}.log. Tests also complete first operation and assert second pending resources survive.
- Fix: normal create uses temp-UUID; template IDs preserve template/block prefix and add UUID per materialized row. No shared abstraction, API/DB schema or persisted ID change. Prefix consumers found by repo search only require temp-. Old exact template-ID tests now check prefix; uniqueness is independently tested via resource cardinality, disjoint operation contexts and completion ownership.
- Countercheck/limits: applying two days has no same-day overlap conflict, so server overlap rules do not avoid this condition. Production occurrence/browser observed behavior not claimed; actual hooks/helpers with synthetic cache/tRPC were executed. Whole-snapshot onError rollback is a distinct unresolved cause, not fixed by UUIDs.

## H041 - Whole timeblock snapshots rewind independent operations and cleared caches

- Adopted reproducible defect; fixed and integrated-check verified at15b09959d (see continuation below). Actual production helpers with real QueryClient (synthetic rows),7 failed/0 passed. Log /tmp/dayopt-audit-rollback-red-final.log. Initial unit-project run collected no tests because use*.test.ts belongs to unit-dom; not counted as red. ReadonlySet call signatures corrected before executing genuine red.
- Failures: Plan and Record committed creations vanish when another creation fails; committed deletion resurrects when another deletion fails; unrelated refreshed Inspector loses note/raw version; limited-list displacement masks another deletion; overlapping same-ID updates both failing reinstate the first failed title; cache clear/recreation is overwritten by old-session snapshot.
- Runtime wiring checked: normal create/update/delete/restore and template apply share snapshot/restore. Snapshots include details, cancellation is lists only. Template isPending guards same-hook repeated clicks, not independent mutations. QueryCacheAuthBoundary clears reused QueryClient on resolved user transition; callbacks restore captured tuples without query-generation/ownership checks. No actual browser/user-switch or production leak observed.
- Rejected partial solutions: remove only failed temp IDs does not restore limited displacement or update/delete; reverting values only when unchanged cannot observe deletion of a displaced row; restoring later same-ID before-values can contain failed earlier optimistic fields. Query generation alone closes clear/recreation only, leaving independent operations unisolated. Do not claim closure from these fragments.
- Next implementation: operation ownership across normal/template mutations, preserve newer unrelated fields/raw versions and any cleared cache. Rebase overlapping pending same-ID changes rather than replaying failed optimistic ancestors. Add actual hook completion/clear integration and positive single-operation regressions to the current real-storage signal before closure. No new management platform or cloud/DB mutation.

Rejected queue candidate: TimeblockInspector keys TimeblockInspectorForm by kind/id plus placeholder/loaded. Distinct targets remount queue, so new target does not reuse old pending queue. Continuing accepted old-target edits on unmount is not itself wrong-target persistence. No code change. Auth switching and response lifetimes still separate pending boundaries.

## F042 - Invalid calendar input silently becomes another template application day

- Real schema/pure-function reproduction, no DB write: date2026-02-30 accepted by applyPlanTemplateSchema; materializeTemplateDay returns synthetic block at2026-03-02T09:00Z/end10:00Z. Log /tmp/dayopt-audit-template-invalid-date-repro.log. Service forwards these instants to createPlansBulk without further date validation.
- Contract: apply date is a user's timezone calendar day, not an overflow-normalized arbitrary date. Schema regex and parseDateKey extract syntax/numbers only; Date.UTC normalizes impossible Gregorian components. Existing anchor negative test rejects separators/anchor range only.
- Next: inspect router/service tests and existing calendar validators, then red/green Gregorian validation at input/domain boundaries while preserving valid leap dates, DST gap/fold and past Plan contract.
- Separate settings candidate: loadDurationContext captures settings query error but proceeds with UTC/default60. Failed read differs from absent row and can alter persisted instants; not execution-reproduced. Confirm failure/missing-row contract and tests before changing.

F042 adopted: schema and domain share Gregorian validity, rejecting normalized overflow before timezone resolution; ISO wall-clock construction also preserves years below100 and extended-year formatting preserves astronomical year0. Red schema/domain15 failed49 passed, router3 failed7 passed; same commands green64 and10. Related materialization/service/anchor/schema89 passed, preserving DST and past Plan fixtures. Logs /tmp/dayopt-audit-template-date-{red,green,router-red,router-green,related}.log. Product changes have no DB/cloud execution. Whole check running /tmp/dayopt-audit-check-template-date.log. Calendar URL parser already rejects impossible dates; builder internal syntax-only accepts them, but observed server path passes only parsed URL or request date. No change to that builder without a reachable invalid input. Calendar parser rejects years0..99 because local Date adds1900, a separate display-range boundary pending supported-year contract. Settings failure candidate and H041 remain unclosed.

## F043 - Failed template settings reads use fabricated defaults; response reads can fail after creation

- Contract: SettingsService.get rejects actual query failures and returns null for absent rows; template date resolution must use read settings or report failure. Missing row fallbackUTC/default60 is existing policy and unchanged.
- Reproduction: real PlanTemplateService with synthetic Supabase responses; list/create/apply resolve on settings failure, and create performs parent/child inserts before records-read rejection. Red4 failed11 passed, /tmp/dayopt-audit-template-settings-red.log. No real DB write.
- Fix: loadDurationContext throws FETCH_FAILED with captured original cause for settings errors; create loads settings/records prerequisites before any persistence. Existing child-write compensation, ownership filters and bulk transaction unchanged. This also closes preexisting records failure after create inserts.
- Verification: same command green15; related service/router/statistics34 passed, /tmp/dayopt-audit-template-settings-{green,related}.log. Missing row actual bulk payload isUTC12:00-13:00, unchanged. Whole check running /tmp/dayopt-audit-check-template-settings.log. No cloud/DB/browser/deployment evidence.

H009 evidence advanced, not fixed: current plan-record.md42 explicitly requires full real Record duration across median-window boundaries, and commit33e8944689/PR#2710 says template and creation share definition; same commit's statistics-general-service comment incorrectly says template clipping intentional. #2567 current settled comment5550377188 specifies Record actual elapsed duration before clipping materialized Plan to next anchor/day end. Issue2567 bulk terminal output truncated; do not claim full issue/comment set read. Saved raw JSON tmp/dayopt-audit-template-2567-current.json, selected settled comment requires bounded full reread if adopting. Next independently reproduce the median disagreement on crossing-window rows; preserve period clipping for duration sums/histograms.

H041 implementation continuation (2026-09-30):

- Runtime cause closed locally across normal Plan/Record create/update/delete/restore, template apply, Plan recording, confirm-day and record Undo. One per-client pending journal retains the shared base and operation-owned field/insertion/deletion writes. Rollback replays surviving writes, preserving authoritative refetches. Explicit update fields preserve same-value later intent; explicit deletion IDs preserve deletions hidden by limited-list displacement. Full update responses remain authoritative. The journal is released when its final operation settles; spread mutation contexts share failure identity.
- Cache scope: capture query/mutation identities before awaiting cancellation. QueryClient.clear removes pending mutations, fencing later success/error/settled cache writes even with no initial queries. A regression reproduced an old optimistic creation attaching to a replacement cache during cancel await (1 failed/7 passed); fixed by pre-await identity capture. Individual recreated queries are excluded from replay; pending requests are not invalidated merely because another completed mutation was garbage-collected.
- Actual QueryClient + MutationCache + React hook lifecycle: initial7 tests run against unchanged9311f3a33 production hook failed6/passed1 (/tmp/dayopt-audit-rollback-lifecycle-red.log). Same tests passed after fix. Extended11 cases cover both creation lanes, committed deletion, same-ID both-fail/same-value-pending success, initially empty cache clear success/error, pre-cancellation-clear race, record/confirm-day failing after another Record commits, activity destination rebase. No network, DB, production user or browser observation claimed.
- Real cache helper regressions retain the original7 literal outcomes and add rollback from a query with undefined initial data. Existing mock callback tests now supply onMutate contexts; old hand-invoked contextless success tests were not a real mutation lifecycle. Full integrated check running /tmp/dayopt-audit-check-rollback.log; do not reuse earlier7671 result for this change.
- Remaining limits: template rename and activity/category snapshots are separate resource domains and remain audit candidates. Already-dispatched requests and auth-header selection after user switching remain broader boundaries than this fence. Production browser/account-switching observations remain unverified. No DB/API contract, optimistic UI action count, timeblock automatic retry (still false), time rules or deployment changes.

H041 pre-dispatch refinement: actual mutationFn was still invoked after cache clear during awaited cancellation (real lifecycle red1 failed/11 passed). Before creating the cache context, the shared onMutate helper now rejects retired scope with TanStack CancelledError; no transport callback is invoked. Local cancellation skips shared hook error toasts and global auth/error capture. Existing default QueryClient retried CancelledError twice (unit red1/3), so cancellation now bypasses query/mutation retry and unexpected-error reporting; access-ended/rate-limit behavior is unchanged. Related DOM60 and QueryClient4 passed. First red dispatch experiment awaited an unresolved response and left an act scope open; resulting5 failures were harness contamination, not adoption evidence. Corrected genuine1/12 red resolves all synthetic promises before asserting no dispatch. Source product will be committed and checked separately from2987c53c2. Already-dispatched transport/server operations are not cancelled by this change; no browser/cloud request observation.

H041 limited-list countercheck: while an unrelated Record creation was pending, a Plan create displaced a persisted row in limit1, then replaced its own temp row with a server row. Rolling back the Record incorrectly treated removal of the Plan temp row as mere displacement and showed the ghost temp instead of the committed raw row. Real lifecycle red1/13, log /tmp/dayopt-audit-rollback-limited-red.log; persisted displaced rows remain recoverable, while removed temp-prefix rows are explicitly removed during replay. Green13, /tmp/dayopt-audit-rollback-limited-green.log. Final product15b09959df80bfcdea09ab54ce5df0e5955ec920 incorporates2987c53c2 ownership,777cc9e1e pre-dispatch cancellation and this countercheck. Final whole check /tmp/dayopt-audit-check-rollback-published.log running; no source changes after final product commit.

H025 next auth hypothesis (unadopted): resolveSessionAuthContext verifies getUser, then reads getSession for sessionId and again inside resolveMfaAssurance. First lookup failure is logged; a later null session/no error returns aal1/aal1. Existing tests supply the same error for both calls, so they do not distinguish error followed by null after SDK storage invalidation. Need installed SDK/error behavior, reachable HTTP/RSC caller and #2047/current user intention before adopting a defect. No actual SDK/server or production reproduction yet. Keep legitimate independently recovered MFA lookup and approved aal2-to-aal1 transition; do not tighten by assuming every missing token is hostile.

H041 final verification: product15b09959df80bfcdea09ab54ce5df0e5955ec920, full Node24 pnpm check exit0 (/tmp/dayopt-audit-check-rollback-published.log): types10/lint9/static/deadcode; billing37/i18n2/observability64/product4579/web366/scripts2645 =7693 passed. Actual lifecycle13 plus helper8 and cancellation unit4 are included, not extra summed onto total. Final docs:check exit0 (/tmp/dayopt-audit-rollback-docs-final.log). No product source changes after verification SHA; audit-only evidence commit follows. No cloud/browser/DB/deployment proof; mission whole reading remains unfinished.

H041 integrated main verification: sourceb0deb289d830461ff92c63103d60e04f1925a958 includes main0aa61be10 #2967 dependency/OSS-credit delta. Frozen-lock install passed and ip-address10.7.2 graph verified. Integrated full Node24 pnpm check exit0, total7693 (product4579), /tmp/dayopt-audit-check-rollback-main.log. Main delta did not change first-party business code. This verification supersedes pre-update15b09959d for publication. Auth-js2.116.0 selected vendor source supports storage invalidation but also preserves proactive valid sessions/cached failure cooldown; H025 mixed-result hypothesis remains unadopted until actual SDK synthetic reproduction and#2047 contract review.

## F044 — セッション取得失敗後のMFA判定が失敗を失う

- 契約: #2047のserver検証済みMFA判定とfail-closed。ログ用session取得が失敗しても独立したMFA token取得が回復すれば継続する。失敗後のtokenなしは正常なlegacy sessionとは区別する。
- 根拠: resolveSessionAuthContextの二回のgetSessionで最初のerror/throwをログだけに捨て、SDKがstorageを消した後のnull/no-errorをaal1/aal1へ正規化していた。auth-js2.116.0/SSRの合成HTTPによる実SDK＋実production helperでこの結果を確認。MFA登録済みserver userとstorage情報を区別した。
- 反証/限界:0sでは有効session保持、31sではcached errorを繰返して既にfail-closed。61s synthetic caseはHTTP route60sを越えるため、本番HTTP bypassの観測・到達証明とはしない。RSC/他callerのruntime制約は未確認。従来tokenなしの一般policyやaal2->aal1降格の変更は採らない。
- 再現: sequential error/throw2件＋realSSR61s1件がred3 failed/18 passed、/tmp/dayopt-audit-auth-sdk-red.log。SDK本体のgetSession/MFA/user判定はmockせず、clockとHTTP応答のみ合成。
- 修正: sessionLookupFailedをMFA解決へ渡し、token未回復時だけlookupFailedを保持。独立token回復、従来の取得失敗なしnull session、null-AALとMFA無効化後降格は維持。
- 状態: product8e172d8472163502b706bd8d2931cdd1da603adf、green21/関連145成功、docs:check成功。全体check進行中で未公開。旧H025仮説を丸ごと採用せずこの失敗消失だけを閉じる。Mission#2963、既存#2047は意図照合に使用し再開/重複起票なし。

F044 whole verification: product8e172d847 full Node24 pnpm check exit0,7700 passed (product4586); docs:check exit0, source/test bytes unchanged after validation. Publication follows normalhooks; production/HTTP-runtime reachability remains unverified.

F044 published e2fd91c62a5ae8a2a4306bb21329190f2c942a8d via normalhook; OPEN/Draft API verified. Issue record5902814607. Dependency warning candidate remains unadopted: installed undici7.29.0 dev graph, registry audit10 distinct advisories, metadata12 findings, snapshot SHA2562ee249599b2da63517d505d77593abd6b91bbdae66244329907afe9960ae928d; Dependabot details403. Read primary maintainer evidence and actual reachability before changing dependencies or claiming production exposure.

## F045 — 現行lockfileのundici security advisory（既存PR追跡）

- 根拠: Node24 pnpm audit snapshotはundici7.29.0の10 distinct advisory、metadata12 findingsを返す。Installed graphはAI/provider/gateway開発toolとMCP conformance開発tool。maintainer [7.29.1 security release](https://github.com/nodejs/undici/releases/tag/v7.29.1) と [7.30.0 release](https://github.com/nodejs/undici/releases/tag/v7.30.0) を照合。
- 反証/限界: developer dependencyでも動的Agent/fetch経路は存在するが、全advisoryの脆弱経路を使うとの証明ではない。本番観測/実攻撃の再現なし。GitHub default-branch9件とregistry metadata12件は別snapshot。Dependabot詳細API403は一度確認、繰返しなし。
- 方針/状態: 既存#2972がlockfile/integrity/snapshot/2edgesの7.30.0更新を準備済み。headfd689816aeea004970b1f05907dc708030342b1f exactdiff確認、通常CIの表示確認、監査結果を https://github.com/Dayopt/dayopt/pull/2972#issuecomment-5902880240 へ追記。重複PR/Issue作成・他branch変更なし。現在の監査checkoutの依存7.29.0は未解消、merge/配信待ちを修正完了とは数えない。追加の顧客判断はなく、通常レビュー/明示merge権限が再開条件。

#2971 integration source03888232d merges upstream billing-overview freshness with H041 cancellation: real QueryClient observer/hydration8 plus sessionAuth21 passed; source unchanged after merge. Full integration check running; current7700 evidence does not yet cover main delta. Internal error allowlist, expected reporting, private search logs, MFA/session/service-role boundaries and server/client billing access full-read cross-check found no additional adopted defect in this reading group. Actual cloud/CDN/RLS/billing flows remain unverified.

## F046 — 新方式の体験に旧Freeへの終了ダイアログが表示される

- 契約: #2610と現行billing仕様はカード不要45日体験と単一有料プラン。購入中断・incompleteだけでは体験を消費しない。終了案内は実際の利用状態に基づく既存inline bannerが担当する。
- 条件/原因: 認証済みshellに常設された旧hookがfree statusとStripe Customerの存在だけで旧「Freeで続ける」ダイアログを開く。Customerは中断・失敗したCheckoutでも存在し、体験終了の証明にならない。
- 反証: enforcement offでは旧7日Stripe trialの互換経路が現存するため、旧hook/componentや保存済みdismissalを全面削除しない。新方式のexpiredも旧Freeへ誘導しない。実ブラウザ・Stripe・本番の観測とは区別する。
- 再現/修正: production hookと実BillingAccessContextで新方式4状態がred4/既存6成功、`/tmp/dayopt-audit-trial-dialog-red.log`。enforced時だけ旧noticeを抑止。同じ10件green、Provider4と計14成功、`/tmp/dayopt-audit-trial-dialog-green-final.log`。旧方式の表示・実close後のlocal/persisted dismissalを検証した。
- 状態: product `51bc4196ca138e10043a0c15ea874ee929b996cf`、全体check進行中。新たなmodalや操作は追加せず、既存の新方式案内経路を維持。Mission#2963で追跡。

## F047 — billing packageの説明が旧機能別Free/Pro認可を正本としている

- 根拠: package全ソースとREADME、現行service/procedure/providerを全文照合。access.tsの45日・1080時間モデルがREADMEの構造から抜け、旧entitlementと7日trialを現行共通ルールとして説明していた。
- 修正: access.tsと現行認可経路を説明し、旧識別子・entitlement・Stripe trialを互換用途として明記。既存consumerのある定数は削除しない。価格・課金・実行環境設定は変更しない。
- 状態: F046と同じproduct SHAに文書修正。architecture生成差分は新規test行・件数だけを機械照合。docs検証は別途記録する。

F046/F047 final verification: product51bc4196ca138e10043a0c15ea874ee929b996cf whole Node24 check exit0,7714 passed (product4600), /tmp/dayopt-audit-check-trial-dialog.log; docs:check exit0 /tmp/dayopt-audit-trial-docs.log. Source/test bytes frozen; audit-only evidence commit and normal publication follow. The separate existing banner suite6 passes legacy Portal/polling only, not current expiry browser evidence.

## F048 — migration通知の説明が廃止したラベル付与を示す

- 根拠: upstream#2956はCI通知をbotコメントのmarker確認へ移行し、ラベル作成/付与を廃止した。check.mjsのrunMigrationSafety説明だけが「コメント→ラベル付与」「付与済み」を残していた。
- 修正: 現行migration-noticeの責務に説明を同期。権限やruntimeには手を加えない。TypeScript parserでcommentsを除いたJS出力のbyte一致を確認。raw scannerはtemplate/regexの文脈を処理せず誤って差分を示したため採用しない。
- 検証: upstream統合83e429b41のNode24全体check7707成功。コメント修正後は関連94件成功、`/tmp/dayopt-audit-migration-notice-comment-test.log`。文書訂正なので修正前失敗testは作らない。実GitHub通知や本番migrationは実行しない。

課金経路の追加照合（未採用候補/反証）:

- 同じoperationIdの再試行後に旧callbackが再度unlockする候補: installed TanStack query-core5.102.8 mutation.ts160-340を機械照合。retryer完了後だけsuccess/error callbackが走り、失敗通知後に同じmutationが再度success通知する経路はこのexecuteにない。既存の手動callbackテストだけから実際の二重通知を推定しない。success callback自身のthrow→onErrorはterminal IDを既に破棄するため旧IDとして拒否される。現callerに新たなattempt世代を追加しない。実ブラウザ/transport全体の証明ではない。

- provider再送の環境前提: digestはemail/price/appUrlまたはcustomer/appUrlを持ち、enforcement/account/modeは含まない。既存open Checkoutの回復は当初trial条件を維持しうる。flag・provider変更時の未完了operationの扱いはrollout/activation/DB契約へ戻って確認する。configuration切替の実走なし、現時点で公開契約の変更を採用しない。
- Invoice通貨: UIはamount/100、StoryのJPYも同じscale。現行の提供はUSD $5であり、Storyだけで本番JPY請求の到達を証明できない。currency/amountのprovider契約と過去請求の対応を確認してから採否を決める。今回表示単位は変えない。
- OverviewはbillingInfoとaccessでprofilesを別々に取得する。UIとProviderも独立queryのため、同一snapshotを必須とする範囲・現在のrace影響を再現する必要がある。単に2回SELECTだから安全性欠陥とはしない。

## Billing DB boundary continuation (2026-09-30)

- Source read at `29687216fddb76733ac079bd03e61da7adcdae33`, baseline bytes verified before ledger promotion. Newly read migrations: 90040/41/42/45/46/47/55 and 20260810041210; current rollout, baseline rollout62 lines, cohorts32 and preflight95 fully read. Gate90028/33 and recovery90048 reread, already counted. Total537 full /1 mechanical /2603 unverified; counts are progress, not proof of safety. Initial large combined search/docs output was truncated and not counted; required sources reacquired separately.
- Definition chain: claim v3/start v2 and inner reconciliation v3 are in90040; reconciliation v4 in90041 adds account-closing boundary. Customer claim v2 delegates to v1(90042), whose permissions are revoked from service_role in90045; latest v2 wrappers/start/complete/abandon and recovery v1 are replaced in20260810041210 without losing existing grants. Latest deletion trigger is90048, superseding90041/42/45/46/47. Gate predicate90033 fails closed on absent/malformed singleton. These are repository definitions, not deployed catalog evidence.
- Rejected historical-only candidate:90042 deletes attempts before consulting them for terminal_reason, but90045 reorders it and90048 blocks every unresolved provider-started Customer attempt. No current defect adopted from90042 alone. The retained recovery terminal reason is historical compatibility; no enum/receipt deletion proposed. Likewise90046 briefly blocks every unresolved attempt, then90047 allows expired ones, and90048 restores explicit recovery-before-deletion. Latest specification follows90048/20260810041210, so earlier permissive wording is not reinstated.
- Cross-layer contract: Customer creation is marked before provider POST; active parent Checkout is required before Customer completion, and exhausted no-Customer recovery terminalizes the parent. Deletion recovery performs configured-provider identity check and exact user-metadata search, then binds or abandons before begin. Redirect capabilities are private and separate from90-day claims; portal5min/checkout10min lifetime starts at provider_started_at, not completion. Reconciliation response_expired/account_closing throws in the actual service before URL return. cleanup90055 adds has_more after SKIP LOCKED batches, matching current service shape; old two-column cleanup is superseded. No new runtime defect adopted in this chain.
- H034 scope expanded, still unadopted: latest billing start/claim/reconcile/provisioning/recovery capture clock before auth/user/profile/claim/attempt locks and compare deadlines to that entry time. This can differ from the instant after lock acquisition. Existing integration covers pre-call expiry/reclaim, not controlled lock-wait expiry. Countercheck: actual provider POST has an independent5-minute Date.now safety margin, so SQL stale clock alone does not establish POST beyond23h. Replayed URL remaining30s floor has no equivalent service clock comparison; bounded DB waits do not prove the floor is preserved. Need isolated DB lock-wait reproduction and per-command contract before any migration change; no production impact or SQL execution claimed.
- Provider-config transition remains unverified: current rollout fences writes and repeats classification before enforcement, but no explicit drain evidence for pending Checkout intents was read here. Existing recovered Checkout preserves provider state and digest does not include enforcement/account/mode. Do not discard accepted legacy trial or alter public contract from this observation alone.
- Preflight classification candidate, not adopted: script consumes only a subscription with trial_start or positive paid subscription invoice; spec says current/past subscribers and Stripe-trial users are consumed, incomplete-only history excluded. Resolve precise established-contract versus paid-history semantics from#2614 before proposing a change (for example zero-amount/credited subscriptions). #2610 current full body and ctx read; L1 trusted_brief_missing_or_stale, prior cloud/local success claims not used as new evidence. No script executed with credentials or generated customer SQL. Cohort SQL explicitly limits retained events89days and separates mature/immature and renewal-observable denominators; no lifetime revenue claim or DB query execution.

#2614 follow-up: ctx L1 missing/stale; full current body and both original comments read separately, including [design outcome](https://github.com/Dayopt/dayopt/issues/2614#issuecomment-5578678003). Outcome repeats existing/past subscriber and Stripe-trial consumption, incomplete-only exclusion, but does not define zero-amount/credited contract history. Closed design Issue is not reopened or treated as current implementation authorization; this mission supplies the reversible audit scope. Before adopting a script defect, inspect first-party preflight tests/actual billing providers and whether the contract edge can occur under existing USD500/card-only configuration. Historical comments are decision evidence, not current environment verification.
