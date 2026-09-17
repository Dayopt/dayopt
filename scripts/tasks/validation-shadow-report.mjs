#!/usr/bin/env node
/**
 * `pnpm validation:shadow-report [--limit N] [--json]` — 新旧ゲートの shadow 比較（#2798）。
 *
 * 直近の非 draft PR について、read-only の GitHub API から次を集めて 1 表にする:
 * - 旧経路: CI run で実際に走った job（名前・conclusion・所要）、Vercel status、required-ready までの時間
 * - 新経路: PR の変更ファイルから plan を再計算した結果（required / not-applicable）と、
 *   controller が発行した `Validation (shadow)` / `Review policy (shadow)` の最終 state
 * - 差分: 旧経路で走ったが plan が不要とする suite / deployment（would-skip）、plan が要求するが
 *   旧経路に producer が無い / skip された suite / deployment（would-add）
 *
 * plan の再計算は **このレポートを実行した checkout の policy**（validation-plan.mjs と workspace
 * manifest）で行う遡及評価であり、各 PR の base 時点の policy ではない。header と JSON に
 * checkout SHA を出す。base 以降に policy が変わった PR は、その差を読む側が補正する。
 *
 * 判定はしない（切替の裁定は人が行う）。母数が少ない分類の p95 は出さず、件数と個別行を出す。
 * 取得できない項目は「未取得」、plan が indeterminate の行は比較を「未判定」と書き、0 分や
 * success や「削減可能」に丸めない。
 */
import { execFileSync } from 'node:child_process';

import { REPO, runGhJson } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { REVIEW_STATUS_CONTEXT } from '../lib/review-policy.mjs';
import { PRODUCERS, VALIDATION_STATUS_CONTEXT } from '../lib/validation-evidence.mjs';
import { createValidationPlan } from '../lib/validation-plan.mjs';

const CI_PATH = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/;
/** deployment producer の environment → 旧 ruleset の required status context。 */
export const VERCEL_CONTEXTS = {
  'Preview – product': 'Vercel – product',
  'Preview – web': 'Vercel – web',
};
export const UNAVAILABLE = '未取得';
export const UNDECIDED = '未判定';

/** PR の変更領域を 5 分類に落とす（#2798 §1 の比較軸）。indeterminate な plan は「未判定」に隔離する。 */
export function classifyPlan(plan) {
  if (plan.status !== 'determinate') return UNDECIDED;
  const areas = new Set(plan.areas ?? []);
  const files = plan.files ?? [];
  // DB / API 契約（docs/engineering/data/db/rls-snapshot.md 等）は path が docs/ でも api-db
  if (areas.has('database') || areas.has('api') || areas.has('auth-billing')) return 'api-db';
  if (areas.has('policy') || areas.has('dependencies')) return 'ci-policy';
  if (files.length > 0 && files.every((file) => /^(README\.md|LICENSE|docs\/)/.test(file)))
    return 'docs';
  if (areas.has('behavior')) return 'logic';
  if (areas.has('ui')) return 'ui';
  return 'other';
}

/** producer を旧経路の比較キー（CI job 名 / Vercel status context）へ落とす。対象外は null。 */
function legacyKey(producer) {
  if (!producer) return null;
  if (producer.kind === 'actions-job' && producer.workflow === CI_PATH) return producer.job;
  if (producer.kind === 'deployment') return VERCEL_CONTEXTS[producer.environment] ?? null;
  return null;
}

/**
 * plan と旧経路の実行結果を突き合わせる。plan が indeterminate、または旧経路の観測が確定して
 * いない（CI run が無い / 未完了）なら比較しない（null。未取得を would-add に数えない）。
 * 「走った」は開始済みかつ skipped でない job（failure / cancelled も runner を使う）。
 * deployment producer は Vercel の status が実 deployment を指す時だけ「走った」とする
 * （`Canceled by Ignored Build Step` は context があっても未実行）。
 * @param {{ plan: any, jobs: { name: string, conclusion: string | null, started: boolean, minutes: number | null }[],
 *   statuses?: Record<string, { state: string, ran: boolean } | null>, legacyComplete?: boolean }} input
 * @returns {{ wouldSkip: string[], wouldAdd: string[] } | null}
 */
export function comparePlanToLegacy({ plan, jobs, statuses = {}, legacyComplete = true }) {
  if (plan.status !== 'determinate' || !legacyComplete) return null;
  const ranByName = new Map(jobs.map((job) => [job.name, job]));
  const wouldSkip = [];
  const wouldAdd = [];
  const seen = new Set();
  for (const suite of Object.keys(plan.required ?? {})) {
    const producer = PRODUCERS[suite];
    const key = legacyKey(producer);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const anyRequired = Object.entries(plan.required).some(
      ([name, rule]) => rule.status === 'required' && legacyKey(PRODUCERS[name]) === key,
    );
    let ran;
    let absent;
    if (producer.kind === 'deployment') {
      ran = Boolean(statuses[key]?.ran);
      absent = !ran;
    } else {
      const job = ranByName.get(key);
      ran = Boolean(job && job.started && job.conclusion !== 'skipped');
      absent = !job || job.conclusion === 'skipped';
    }
    if (ran && !anyRequired) wouldSkip.push(key);
    if (anyRequired && absent) wouldAdd.push(key);
  }
  return { wouldSkip, wouldAdd };
}

/**
 * job の所要（分、切り上げ。Actions の課金単位に合わせる）。skipped は 0、それ以外で
 * started_at / completed_at が無い（実行中 / 取得不能）は null（未取得）。
 */
export function jobMinutes(job) {
  if (job.conclusion === 'skipped') return 0;
  if (!job.started_at || !job.completed_at) return null;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

/** null を含む合計は null（未取得を 0 に倒さない）。空配列も null（run 無し = 取得不能）。 */
export function sumOrNull(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null || value === undefined) return null;
    sum += value;
  }
  return sum;
}

/** 1 PR 分の行を組み立てる。api は `(path, paginate?) => json`。 */
export function collectPrRow({ pr, api }) {
  const headSha = pr.head?.sha ?? '';
  const files = api(`repos/${REPO}/pulls/${pr.number}/files?per_page=100`, true).map(
    (file) => file.filename,
  );
  const previous = api(`repos/${REPO}/pulls/${pr.number}/files?per_page=100`, true)
    .map((file) => file.previous_filename)
    .filter(Boolean);
  const plan = createValidationPlan({
    repository: REPO,
    prNumber: pr.number,
    headSha,
    baseSha: pr.base?.sha ?? '',
    testSha: SHA.test(pr.merge_commit_sha ?? '') ? pr.merge_commit_sha : headSha,
    // plan 契約上 policySha は base と一致させる。実際の規則は現 checkout のもの（header に明記）
    policySha: pr.base?.sha ?? '',
    event: 'pull_request',
    diff: {
      complete: files.length === (pr.changed_files ?? files.length),
      files: [...files, ...previous],
      hash: 'a'.repeat(64),
    },
  });
  const runs = api(`repos/${REPO}/actions/runs?head_sha=${headSha}&per_page=50`, true)
    .flatMap((page) => page.workflow_runs ?? [])
    .filter((run) => run.path === CI_PATH && run.event === 'pull_request');
  const latest = runs.reduce((best, run) => (!best || run.id > best.id ? run : best), null);
  const jobs = latest
    ? api(`repos/${REPO}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`, true)
        .flatMap((page) => page.jobs ?? [])
        .map((job) => ({
          name: job.name,
          conclusion: job.conclusion,
          started: Boolean(job.started_at),
          minutes: jobMinutes(job),
        }))
    : [];
  const statuses = api(`repos/${REPO}/commits/${headSha}/status`).statuses ?? [];
  const status = (context) => statuses.find((entry) => entry.context === context) ?? null;
  const ciSeconds =
    latest?.created_at && latest?.updated_at
      ? Math.round((Date.parse(latest.updated_at) - Date.parse(latest.created_at)) / 1000)
      : null;
  const vercel = Object.fromEntries(
    Object.values(VERCEL_CONTEXTS).map((context) => {
      const entry = status(context);
      if (!entry) return [context, null];
      // validation-evidence と同じ規則: Ignored Build Step は deployment が走っていない
      const ignored = /ignored build step/i.test(entry.description ?? '');
      return [context, { state: ignored ? 'ignored' : entry.state, ran: !ignored }];
    }),
  );
  // 旧経路の観測が確定しているのは、最新 CI run が completed の時だけ
  const legacyComplete = latest?.status === 'completed';
  return {
    number: pr.number,
    title: pr.title,
    headSha: headSha.slice(0, 9),
    classification: classifyPlan(plan),
    planStatus: plan.status,
    required: Object.entries(plan.required)
      .filter(([, rule]) => rule.status === 'required')
      .map(([name]) => name),
    review: plan.review.status,
    // 走った job 全部（failure / cancelled も）。success 以外は conclusion を添える
    legacyJobs: jobs
      .filter((job) => job.started && job.conclusion !== 'skipped')
      .map((job) => (job.conclusion === 'success' ? job.name : `${job.name} (${job.conclusion})`)),
    // run 無し・実行中・取得不能は null（未取得）
    runnerMinutes: latest ? sumOrNull(jobs.map((job) => job.minutes)) : null,
    ciSeconds,
    vercel: {
      product: vercel['Vercel – product']?.state ?? UNAVAILABLE,
      web: vercel['Vercel – web']?.state ?? UNAVAILABLE,
    },
    legacyComplete,
    shadow: {
      validation: status(VALIDATION_STATUS_CONTEXT)?.state ?? '未発行',
      validationDetail: status(VALIDATION_STATUS_CONTEXT)?.description ?? '',
      review: status(REVIEW_STATUS_CONTEXT)?.state ?? '未発行',
    },
    comparison: comparePlanToLegacy({ plan, jobs, statuses: vercel, legacyComplete }),
  };
}

const cell = (value) => (value === null || value === undefined ? UNAVAILABLE : String(value));
const listCell = (list) => (list.length ? list.join(', ') : '-');

export function formatReport(rows, { limit, fetchedAt, policyCheckout }) {
  const lines = [
    `## Validation shadow report（直近 ${limit} 件の非 draft PR、${fetchedAt}）`,
    '',
    `plan は現 checkout \`${policyCheckout}\` の policy で遡及評価（各 PR の base 時点の policy ではない）。`,
    '',
    '| PR | 分類 | plan | 旧経路で走った job | Vercel product / web | runner 分 | CI 秒 | would-skip | would-add | Validation | Review |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |',
  ];
  for (const row of rows)
    lines.push(
      `| #${row.number} | ${row.classification} | ${row.planStatus}; review ${row.review} | ${row.legacyJobs.join(', ') || 'なし'} | ${row.vercel.product} / ${row.vercel.web} | ${cell(row.runnerMinutes)} | ${cell(row.ciSeconds)} | ${row.comparison ? listCell(row.comparison.wouldSkip) : UNDECIDED} | ${row.comparison ? listCell(row.comparison.wouldAdd) : UNDECIDED} | ${row.shadow.validation} | ${row.shadow.review} |`,
    );
  const byClass = new Map();
  for (const row of rows) {
    const entry = byClass.get(row.classification) ?? {
      count: 0,
      minutes: 0,
      minutesUnavailable: 0,
      skip: 0,
      add: 0,
      undecided: 0,
    };
    entry.count += 1;
    if (row.runnerMinutes === null) entry.minutesUnavailable += 1;
    else entry.minutes += row.runnerMinutes;
    if (row.comparison) {
      entry.skip += row.comparison.wouldSkip.length;
      entry.add += row.comparison.wouldAdd.length;
    } else entry.undecided += 1;
    byClass.set(row.classification, entry);
  }
  lines.push(
    '',
    '| 分類 | 件数 | runner 分（合計、未取得を除く） | runner 分 未取得 | would-skip 件 | would-add 件 | 比較 未判定 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [name, entry] of byClass)
    lines.push(
      `| ${name} | ${entry.count} | ${entry.minutesUnavailable === entry.count ? UNAVAILABLE : entry.minutes} | ${entry.minutesUnavailable} | ${entry.skip} | ${entry.add} | ${entry.undecided} |`,
    );
  lines.push(
    '',
    '注: would-skip は「旧経路で走った（failure / cancelled 含む）が plan が不要とする job / Vercel deployment」、would-add は「plan が要求するが旧経路が skip した / 無い job / Vercel deployment」。Vercel の Ignored Build Step は未実行。plan が indeterminate の行は分類ごと「未判定」に隔離し、CI run が無い / 未完了の行は比較しない（未判定）。',
    '判定は人が行う。件数が少ない分類の分布は参考値で、p95 は出さない。Preview / review の待ち時間は未取得。',
  );
  return `${lines.join('\n')}\n`;
}

function defaultPolicyCheckout() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function runReport({
  argv = process.argv.slice(2),
  api = defaultApi,
  now = () => new Date(),
  policyCheckout = defaultPolicyCheckout,
} = {}) {
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 10;
  const pulls = api(
    `repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=${Math.min(100, limit * 3)}`,
    true,
  )
    .filter((pr) => !pr.draft && pr.base?.ref === 'main')
    .slice(0, limit);
  const rows = pulls.map((pr) => collectPrRow({ pr, api }));
  const fetchedAt = now().toISOString();
  const checkout = policyCheckout();
  if (argv.includes('--json'))
    return JSON.stringify({ fetchedAt, policyCheckout: checkout, rows }, null, 2);
  return formatReport(rows, { limit, fetchedAt, policyCheckout: checkout });
}

function defaultApi(path, paginate = false) {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const parsed = runGhJson(args);
  return paginate ? parsed.flat() : parsed;
}

if (isDirectExecution(import.meta.url)) process.stdout.write(`${runReport()}\n`);
