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

## H009 — テンプレート中央値と統計中央値の期間境界

- 状態: 未検証仮説、未修正。
- 根拠: StatisticsGeneralServiceは期間に重なる実記録の全長、PlanTemplateServiceはfetchRecordsの期間clip後の長さを中央値に使う。前者には全長を使う意図のコメントがある。
- 次の反証: 提案用と統計用で期間境界の意味を意図的に分けた契約か、仕様/決定/Issueから確認する。共通domain関数を使っているという理由だけで統合しない。

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
