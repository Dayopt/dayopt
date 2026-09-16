#!/usr/bin/env node
/**
 * `pnpm validation:shadow-report [--limit N] [--json]` — 新旧ゲートの shadow 比較（#2798）。
 *
 * 直近の非 draft PR について、read-only の GitHub API から次を集めて 1 表にする:
 * - 旧経路: CI run で実際に走った job（名前・所要）、Vercel status、required-ready までの時間
 * - 新経路: PR の変更ファイルから base policy で再計算した plan（required / not-applicable）と、
 *   controller が発行した `Validation (shadow)` / `Review policy (shadow)` の最終 state
 * - 差分: 旧経路で走ったが plan が不要とする suite（would-skip）、plan が要求するが旧経路に
 *   producer が無い / skip された suite（would-add）
 *
 * 判定はしない（切替の裁定は人が行う）。母数が少ない分類の p95 は出さず、件数と個別行を出す。
 * 取得できない項目は「未取得」と書き、0 分や success に丸めない。
 */
import { REPO, runGhJson } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { REVIEW_STATUS_CONTEXT } from '../lib/review-policy.mjs';
import { PRODUCERS, VALIDATION_STATUS_CONTEXT } from '../lib/validation-evidence.mjs';
import { createValidationPlan } from '../lib/validation-plan.mjs';

const CI_PATH = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/;

/** PR の変更領域を 5 分類に落とす（#2798 §1 の比較軸）。 */
export function classifyPlan(plan) {
  const areas = new Set(plan.areas ?? []);
  const files = plan.files ?? [];
  if (files.length > 0 && files.every((file) => /^(README\.md|LICENSE|docs\/)/.test(file)))
    return 'docs';
  if (areas.has('policy') || areas.has('dependencies')) return 'ci-policy';
  if (areas.has('database') || areas.has('api') || areas.has('auth-billing')) return 'api-db';
  if (areas.has('behavior')) return 'logic';
  if (areas.has('ui')) return 'ui';
  return 'other';
}

/**
 * plan と旧経路の実行結果を突き合わせる。
 * @param {{ plan: any, jobs: { name: string, conclusion: string | null, minutes: number }[] }} input
 */
export function comparePlanToLegacy({ plan, jobs }) {
  const ranByName = new Map(jobs.map((job) => [job.name, job]));
  const wouldSkip = [];
  const wouldAdd = [];
  const seen = new Set();
  for (const [suite, rule] of Object.entries(plan.required ?? {})) {
    const producer = PRODUCERS[suite];
    if (!producer || producer.kind !== 'actions-job' || producer.workflow !== CI_PATH) continue;
    const key = producer.job;
    if (seen.has(key)) continue;
    seen.add(key);
    const suitesForJob = Object.entries(plan.required).filter(
      ([name]) => PRODUCERS[name]?.job === key,
    );
    const anyRequired = suitesForJob.some(([, r]) => r.status === 'required');
    const job = ranByName.get(key);
    const ran = job && job.conclusion === 'success';
    if (ran && !anyRequired) wouldSkip.push(key);
    if (anyRequired && (!job || job.conclusion === 'skipped')) wouldAdd.push(key);
    void rule;
  }
  return { wouldSkip, wouldAdd };
}

/** job の所要（分、切り上げ。Actions の課金単位に合わせる）。 */
export function jobMinutes(job) {
  if (!job.started_at || !job.completed_at) return 0;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
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
        .map((job) => ({ name: job.name, conclusion: job.conclusion, minutes: jobMinutes(job) }))
    : [];
  const statuses = api(`repos/${REPO}/commits/${headSha}/status`).statuses ?? [];
  const status = (context) => statuses.find((entry) => entry.context === context) ?? null;
  const ciSeconds =
    latest?.created_at && latest?.updated_at
      ? Math.round((Date.parse(latest.updated_at) - Date.parse(latest.created_at)) / 1000)
      : null;
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
    legacyJobs: jobs.filter((job) => job.conclusion === 'success').map((job) => job.name),
    runnerMinutes: jobs.reduce((sum, job) => sum + job.minutes, 0),
    ciSeconds,
    vercel: {
      product: status('Vercel – product')?.description ?? '未取得',
      web: status('Vercel – web')?.description ?? '未取得',
    },
    shadow: {
      validation: status(VALIDATION_STATUS_CONTEXT)?.state ?? '未発行',
      validationDetail: status(VALIDATION_STATUS_CONTEXT)?.description ?? '',
      review: status(REVIEW_STATUS_CONTEXT)?.state ?? '未発行',
    },
    ...comparePlanToLegacy({ plan, jobs }),
  };
}

export function formatReport(rows, { limit, fetchedAt }) {
  const lines = [
    `## Validation shadow report（直近 ${limit} 件の非 draft PR、${fetchedAt}）`,
    '',
    '| PR | 分類 | plan | 旧経路で走った job | runner 分 | CI 秒 | would-skip | would-add | Validation | Review |',
    '| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |',
  ];
  for (const row of rows)
    lines.push(
      `| #${row.number} | ${row.classification} | ${row.planStatus}; review ${row.review} | ${row.legacyJobs.join(', ') || 'なし'} | ${row.runnerMinutes} | ${row.ciSeconds ?? '未取得'} | ${row.wouldSkip.join(', ') || '-'} | ${row.wouldAdd.join(', ') || '-'} | ${row.shadow.validation} | ${row.shadow.review} |`,
    );
  const byClass = new Map();
  for (const row of rows) {
    const entry = byClass.get(row.classification) ?? { count: 0, minutes: 0, skip: 0, add: 0 };
    entry.count += 1;
    entry.minutes += row.runnerMinutes;
    entry.skip += row.wouldSkip.length;
    entry.add += row.wouldAdd.length;
    byClass.set(row.classification, entry);
  }
  lines.push(
    '',
    '| 分類 | 件数 | runner 分（合計） | would-skip 件 | would-add 件 |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const [name, entry] of byClass)
    lines.push(`| ${name} | ${entry.count} | ${entry.minutes} | ${entry.skip} | ${entry.add} |`);
  lines.push(
    '',
    '注: would-skip は「旧経路で走ったが plan が不要とする job」、would-add は「plan が要求するが旧経路が skip した job」。',
    '判定は人が行う。件数が少ない分類の分布は参考値で、p95 は出さない。Preview / review の待ち時間は未取得。',
  );
  return `${lines.join('\n')}\n`;
}

export function runReport({
  argv = process.argv.slice(2),
  api = defaultApi,
  now = () => new Date(),
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
  if (argv.includes('--json')) return JSON.stringify({ fetchedAt, rows }, null, 2);
  return formatReport(rows, { limit, fetchedAt });
}

function defaultApi(path, paginate = false) {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const parsed = runGhJson(args);
  return paginate ? parsed.flat() : parsed;
}

if (isDirectExecution(import.meta.url)) process.stdout.write(`${runReport()}\n`);
