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

## F004 — 規約がunknownの代わりにas neverを勧める

- 状態: 修正済み（`f2a43d559`）、`docs:check`成功。runtimeの挙動変更なし。
- 根拠: `conventions.md` §禁止されたパターンが `any / unknown / Function` の代替に `具体的な型、as never` を記す。一方同文書のserver transformer入力表は `RPC row / unknown`、API境界でのruntime validationは監査ミッションの要求。ESLint検索ではno-explicit-anyが確認されるがunknown禁止はまだ未確認。
- 反証: product/web/packages ESLintを全文確認し、anyは禁止するがunknown禁止はない。同規約のserver入力表とOAuthの例外処理もunknownを許容する。型システム都合のassertionまで禁止する変更ではない。
- 修正/影響: 禁止表をany/Functionと具体型・関数シグネチャへ修正。未知の入力・例外はunknownからschema/guardで絞り込み、as neverを入力検証の代替にしないと明記。unsafe castを誘発する説明を除去する。既存assertionの一律撤去はしない。Mission #2963で追跡。

## H005 — strategyのAI書き込みghost原則とMCP公開契約

- 状態: 未検証仮説、未修正。
- 根拠: strategy原則3はMCP/API由来も未確定ghostと記す。現在のMCP書込契約をまだ読んでいないため矛盾は未確定。
- 次の反証: MCP仕様、同意/操作確定契約、関連決定/Issue、DB command経路を追う。契約の未決判断をコードだけで裁定しない。

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
