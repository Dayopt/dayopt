/**
 * `/report` の E2E が依存する data 属性の正本。
 *
 * ここを 1 箇所に集めるのは、E2E が per-PR の必須チェックに入っておらず
 * **main マージ後の promote でしか走らない**ため。PR #2773（レポートの 3 タブ再編）は
 * `data-report-headline` → `data-report-summary`、`data-report-legend` →
 * `data-report-bars` の改名と `ExecutionChapter` の差分タブ移設を行ったが、E2E 側が
 * 旧構造のまま残り、promote が赤になって初めて分かった（#2774）。
 *
 * 同じ改名を per-PR で捕まえるため、この定数は
 * `features/review/components/report/ReportBody.test.tsx` の契約 test からも読む。
 * Playwright を import しない純粋な文字列モジュールにしてあるのはそのため
 * （jsdom の unit project から import できる）。**属性を改名したらここも直す。**
 *
 * 置き場所が `lib/test/e2e/` なのは依存方向の制約（`features/ -> lib/` の一方向）。
 * `features/review` 配下に置くと E2E fixture が feature を import することになる。
 */

/** 時間の使い方の面（`?tab=usage`。既定タブ）。 */
export const REPORT_ALLOCATION = {
  /** 章そのもの。`AllocationChapter` の `<section>`。 */
  chapter: '[data-report-chapter="allocation"]',
  /** 記録時間のカードの大きい数字（`h:mm`）。 */
  recordedHeadline: '[data-report-summary="recorded"]',
  /** 配分の横棒の一覧。行ごとにカテゴリー名と時間を出す。 */
  breakdownRows: '[data-report-bars="allocation"] li',
} as const;

/** 差分の面（`?tab=diff`）。既定タブではないので、開くには `tab` パラメータが要る。 */
export const REPORT_EXECUTION = {
  /** 章そのもの。`ExecutionChapter` の `<section>`。 */
  chapter: '[data-report-chapter="execution"]',
  /** アクティビティごとの行。記録時間と予定比を出す。 */
  rows: '[data-report-rows="execution"] > li',
} as const;

/** `?tab=` の値。`features/review/lib/report-tab.ts` の `reportTabs` が正本。 */
export const REPORT_TAB_PARAM = {
  usage: 'usage',
  diff: 'diff',
  reflect: 'reflect',
} as const;
