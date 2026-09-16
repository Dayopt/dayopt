#!/usr/bin/env node
/**
 * Validation controller（#2795）。`.github/workflows/validation-gate.yml` から、
 * **main（default branch）の信頼済み checkout** で実行する。
 *
 * - PR 側のコード・依存・artifact は一切実行しない。PR の tree は git object として
 *   `git diff` の入力になるだけ（plan は scripts/ci/validation-plan-shadow.mjs と同じ収集器）
 * - plan は毎回ここで再生成する。PR が変更できる validation-shadow.yml の artifact を
 *   合格証拠として読まない
 * - evidence は GitHub API（read）から取得し、scripts/lib/validation-evidence.mjs の
 *   純粋関数で判定する。結果は Step Summary・artifact・commit status `Validation (shadow)`
 *   （非必須）へ出す
 *
 * 入力（env）: GITHUB_REPOSITORY / GITHUB_EVENT_NAME / GITHUB_EVENT_PATH / GITHUB_SHA /
 * GH_TOKEN / GITHUB_STEP_SUMMARY / GITHUB_OUTPUT。`--pr <number>` は workflow_dispatch 用。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runGh } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import {
  VALIDATION_STATUS_CONTEXT,
  evaluateValidation,
  formatValidationResult,
  toCommitStatus,
} from '../lib/validation-evidence.mjs';
import { createValidationPlan } from '../lib/validation-plan.mjs';
import { collectPlanInput } from './validation-plan-shadow.mjs';

const SHA = /^[a-f0-9]{40}$/;

/** gh api を JSON で読む。`--paginate` は配列 endpoint だけに使う。 */
export function createGithubApi({ execFileImpl } = {}) {
  return (path, { paginate = false } = {}) => {
    const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
    const raw = runGh(args, execFileImpl ? { execFileImpl } : {});
    const parsed = JSON.parse(raw);
    return paginate ? parsed.flat() : parsed;
  };
}

/** event から評価対象 PR を決める。PR 番号が取れなければ null（評価しない）。 */
export function resolveTarget({ eventName, event, prArg, repository, api }) {
  if (prArg !== undefined) {
    const number = Number(prArg);
    return Number.isSafeInteger(number) && number > 0 ? { number, source: 'dispatch' } : null;
  }
  const sha = eventName === 'workflow_run' ? (event?.workflow_run?.head_sha ?? null) : null;
  if (!SHA.test(sha ?? '')) return null;
  const pulls = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`, { paginate: true });
  const open = pulls.filter(
    (pull) => pull?.state === 'open' && pull?.base?.repo?.full_name === repository,
  );
  if (open.length === 0) return null;
  return { number: open[0].number, source: eventName, eventSha: sha };
}

/** GitHub API の生 JSON を evidence の形へ正規化する（判定側は API の形を知らない）。 */
export function collectEvidence({ repository, pr, api, now = () => new Date() }) {
  const headSha = pr.head.sha;
  const runsRaw = api(`repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`, {
    paginate: true,
  });
  const runs = runsRaw
    .flatMap((page) => page?.workflow_runs ?? [])
    .map((run) => ({
      id: run.id,
      path: run.path,
      event: run.event,
      headSha: run.head_sha,
      repository: run.repository?.full_name ?? null,
      runAttempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion ?? null,
      htmlUrl: run.html_url,
      jobs: [],
    }));
  for (const run of runs) {
    if (run.repository !== repository) continue;
    const jobsRaw = api(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      {
        paginate: true,
      },
    );
    run.jobs = jobsRaw
      .flatMap((page) => page?.jobs ?? [])
      .map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion ?? null,
        runAttempt: job.run_attempt,
        htmlUrl: job.html_url,
      }));
  }
  const combined = api(`repos/${repository}/commits/${headSha}/status`);
  const statuses = (combined?.statuses ?? []).map((status) => ({
    context: status.context,
    state: status.state,
    targetUrl: status.target_url ?? null,
    description: status.description ?? null,
  }));
  const deploymentsRaw = api(`repos/${repository}/deployments?sha=${headSha}&per_page=100`, {
    paginate: true,
  });
  const deployments = deploymentsRaw.map((deployment) => {
    const statusList = api(
      `repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`,
      { paginate: true },
    );
    const latest = statusList.reduce(
      (current, status) => (!current || status.id > current.id ? status : current),
      null,
    );
    return {
      id: deployment.id,
      sha: deployment.sha,
      environment: deployment.environment,
      productionEnvironment: deployment.production_environment === true,
      createdAt: deployment.created_at,
      latestStatus: latest
        ? { state: latest.state, environmentUrl: latest.environment_url ?? null }
        : null,
    };
  });
  let baseCompare = 'unknown';
  try {
    baseCompare =
      api(`repos/${repository}/compare/${pr.base.ref}...${headSha}`)?.status ?? 'unknown';
  } catch {
    baseCompare = 'unknown';
  }
  return {
    repository,
    headSha,
    fetchedAt: now().toISOString(),
    pr: {
      number: pr.number,
      state: pr.state,
      draft: pr.draft === true,
      headSha,
      baseRef: pr.base.ref,
      fork: pr.head.repo?.full_name !== repository,
    },
    baseCompare,
    workflowRuns: runs,
    statuses,
    deployments,
  };
}

/**
 * 信頼済み checkout（cwd）で plan を再生成する。
 *
 * test merge は GitHub の `refs/pull/N/merge` を使わず、**policy SHA（main HEAD）と PR head から
 * `git merge-tree` で自前生成する**。GitHub の merge ref は遅延更新で base が古いことがあり
 * （draft や長期 PR で実測）、それを base にすると「policy と base の不一致」で常に indeterminate
 * になる。自前生成なら base は必ず信頼済み checkout と一致し、diff は merge-base(main, head)..head
 * で計算される。PR が main より遅れていても plan は出せる（merge 可否は baseCompare の
 * `update-branch` が別途 pending にする）。conflict は indeterminate。
 *
 * fetch するのは `refs/pull/N/head` だけで、取得した commit が API の head SHA と一致することを
 * 確認する（一致しなければ古い event か race）。PR の tree は git object として読むだけで実行しない。
 */
export function buildTrustedPlan({ repository, pr, policySha, cwd, fetchImpl, git = gitIn(cwd) }) {
  const headSha = pr.head.sha;
  const problems = [];
  let mergeSha = null;
  try {
    fetchImpl?.({ number: pr.number, headSha });
    const fetched = git([
      'rev-parse',
      '--verify',
      `refs/validation/pull/${pr.number}/head^{commit}`,
    ]);
    if (fetched !== headSha) throw new Error('fetched head does not match PR head');
  } catch (error) {
    problems.push(
      `PR head unavailable (${error instanceof Error ? error.message : 'fetch failure'})`,
    );
  }
  if (problems.length === 0) {
    try {
      const tree = git(['merge-tree', '--write-tree', policySha, headSha]);
      mergeSha = git([
        'commit-tree',
        tree,
        '-p',
        policySha,
        '-p',
        headSha,
        '-m',
        'validation test merge',
      ]);
    } catch {
      problems.push('test merge unavailable (merge conflict with base)');
    }
  }
  const input = {
    repository,
    prNumber: pr.number,
    headSha,
    baseSha: policySha,
    testSha: mergeSha ?? '',
    policySha,
    event: 'pull_request',
    diff: { complete: false, files: [], hash: '' },
  };
  if (problems.length === 0) {
    try {
      Object.assign(
        input,
        collectPlanInput({
          repository,
          prNumber: pr.number,
          headSha,
          baseSha: policySha,
          testSha: mergeSha,
          policySha,
          cwd,
          event: 'pull_request',
        }),
      );
    } catch (error) {
      problems.push(error instanceof Error ? error.message : 'plan collection failed');
    }
  }
  const plan = createValidationPlan(input);
  if (problems.length) plan.problems.push(...problems);
  return plan;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'validation-gate',
  GIT_AUTHOR_EMAIL: 'validation-gate@dayopt.invalid',
  GIT_COMMITTER_NAME: 'validation-gate',
  GIT_COMMITTER_EMAIL: 'validation-gate@dayopt.invalid',
};

function gitIn(cwd) {
  return (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...GIT_IDENTITY },
    }).trim();
}

/** `refs/pull/N/head` を fetch する。default の fetchImpl。 */
export function fetchPullRefs({ number }, cwd) {
  execFileSync(
    'git',
    [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/pull/${number}/head:refs/validation/pull/${number}/head`,
    ],
    { cwd, stdio: 'ignore' },
  );
}

export function runValidationGate({
  env = process.env,
  argv = process.argv.slice(2),
  api = createGithubApi(),
  cwd = process.cwd(),
  fetchImpl = (target) => fetchPullRefs(target, cwd),
  publish = true,
  postStatus = (args) => runGh(args),
  output = (text) => {
    process.stdout.write(text);
  },
  now = () => new Date(),
  pollIntervalMs = 30_000,
  sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
} = {}) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY missing');
  const policySha = env.GITHUB_SHA;
  if (!SHA.test(policySha ?? '')) throw new Error('GITHUB_SHA missing');
  // 二重防御: default branch 以外の定義・checkout で走った場合（deployment_status のように
  // PR head の workflow を使う event、または他 branch への dispatch）は評価も発行もしない。
  const trustedRef = env.VALIDATION_TRUSTED_REF ?? 'refs/heads/main';
  if (env.GITHUB_REF !== undefined && env.GITHUB_REF !== trustedRef)
    return {
      skipped: `untrusted ref ${env.GITHUB_REF}; policy must run from ${trustedRef}`,
      result: null,
    };
  const prIndex = argv.indexOf('--pr');
  const prArg = prIndex >= 0 ? argv[prIndex + 1] : undefined;
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const target = resolveTarget({ eventName: env.GITHUB_EVENT_NAME, event, prArg, repository, api });
  if (!target) return { skipped: 'no open PR for this event', result: null };
  const pr = api(`repos/${repository}/pulls/${target.number}`);
  // 古い event（head が進んだ後に届いた完了通知）は評価しない。新しい head の event が別に来る。
  if (target.eventSha !== undefined && target.eventSha !== pr.head.sha)
    return { skipped: `event head ${target.eventSha} superseded by ${pr.head.sha}`, result: null };
  const plan = buildTrustedPlan({ repository, pr, policySha, cwd, fetchImpl });
  // Vercel Preview は CI 完了より遅れて success になる。deployment_status を trigger に
  // できない（PR 側の workflow 定義で走る）ため、pending の間だけ bounded に待って再取得する。
  const waitBudgetMs = Number(env.VALIDATION_WAIT_MINUTES ?? '0') * 60_000;
  const deadline = now().getTime() + (Number.isFinite(waitBudgetMs) ? waitBudgetMs : 0);
  let evidence = collectEvidence({ repository, pr, api, now });
  let result = evaluateValidation({ plan, evidence });
  while (
    result.verdict === 'pending' &&
    !result.reasons.some((reason) => reason.startsWith('update-branch')) &&
    now().getTime() + pollIntervalMs <= deadline
  ) {
    sleep(pollIntervalMs);
    evidence = collectEvidence({ repository, pr, api, now });
    result = evaluateValidation({ plan, evidence });
  }
  result.target = target;
  const summary = formatValidationResult(result);
  output(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  const outPath = env.VALIDATION_RESULT_PATH ? resolve(env.VALIDATION_RESULT_PATH) : null;
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ plan, evidence, result }, null, 2)}\n`);
  if (publish) {
    const status = toCommitStatus(result);
    const runUrl = env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
      : '';
    postStatus([
      'api',
      '--method',
      'POST',
      `repos/${repository}/statuses/${pr.head.sha}`,
      '-f',
      `state=${status.state}`,
      '-f',
      `context=${VALIDATION_STATUS_CONTEXT}`,
      '-f',
      `description=${status.description}`,
      ...(runUrl ? ['-f', `target_url=${runUrl}`] : []),
    ]);
  }
  return { skipped: null, result };
}

if (isDirectExecution(import.meta.url)) {
  const outcome = runValidationGate();
  if (outcome.skipped) console.log(`::notice::Validation gate skipped: ${outcome.skipped}`);
}
