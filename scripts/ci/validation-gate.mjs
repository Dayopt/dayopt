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
 * GH_TOKEN / GITHUB_STEP_SUMMARY / GITHUB_OUTPUT。`--pr <number>` はローカルの read-only 実行用
 * （status は workflow_run 以外では発行しない）。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runGh } from '../lib/gh.mjs';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import {
  REVIEW_STATUS_CONTEXT,
  evaluateReviewPolicy,
  formatReviewPolicy,
  toReviewCommitStatus,
} from '../lib/review-policy.mjs';
import {
  VALIDATION_STATUS_CONTEXT,
  evaluateValidation,
  formatValidationResult,
  toCommitStatus,
} from '../lib/validation-evidence.mjs';
import { createValidationPlan } from '../lib/validation-plan.mjs';
import { collectPlanInput } from './validation-plan-shadow.mjs';

const SHA = /^[a-f0-9]{40}$/;
/** default branch の workflow 定義でしか走らない event（status を発行してよい event）。 */
const TRUSTED_EVENTS = new Set(['workflow_run', 'status', 'issue_comment']);

/** gh api を JSON で読む。`--paginate` は配列 endpoint だけに使う。 */
export function createGithubApi({ execFileImpl } = {}) {
  return (path, { paginate = false } = {}) => {
    const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
    const raw = runGh(args, execFileImpl ? { execFileImpl } : {});
    const parsed = JSON.parse(raw);
    return paginate ? parsed.flat() : parsed;
  };
}

/**
 * trusted event が指す commit。workflow_run と status はどちらも default branch の定義でしか
 * 走らない event（docs: "only trigger a workflow run if the workflow file exists on the default branch"）。
 */
export function eventShaOf(eventName, event) {
  if (eventName === 'workflow_run') return event?.workflow_run?.head_sha ?? null;
  if (eventName === 'status') return event?.sha ?? null;
  return null;
}

/** gh api graphql を JSON で読む（review thread の resolve 状態は REST に無い）。 */
export function createGithubGraphql({ execFileImpl } = {}) {
  return (query, variables = {}) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables))
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    return JSON.parse(runGh(args, execFileImpl ? { execFileImpl } : {})).data;
  };
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $threadsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $reviewsAfter) { pageInfo { hasNextPage endCursor } nodes { id databaseId } }
      reviewThreads(first: 100, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path
          comments(first: 50) { nodes { author { login } body pullRequestReview { id } } }
        }
      }
    }
  }
}`;

/** reviews / reviewThreads を最後のページまで読む。途中で応答が欠けたら throw（fail closed）。 */
export function fetchAllReviewPages({ graphql, owner, name, number, maxPages = 50 }) {
  const reviews = [];
  const threads = [];
  let reviewsAfter = null;
  let threadsAfter = null;
  let moreReviews = true;
  let moreThreads = true;
  for (let page = 0; moreReviews || moreThreads; page += 1) {
    if (page >= maxPages) throw new Error('review thread pagination exceeded the page budget');
    const variables = { owner, name, number };
    if (reviewsAfter) variables.reviewsAfter = reviewsAfter;
    if (threadsAfter) variables.threadsAfter = threadsAfter;
    const pull = graphql(REVIEW_THREADS_QUERY, variables)?.repository?.pullRequest;
    if (!pull?.reviews?.pageInfo || !pull?.reviewThreads?.pageInfo)
      throw new Error('review thread page is incomplete');
    if (moreReviews) {
      reviews.push(...(pull.reviews.nodes ?? []));
      moreReviews = pull.reviews.pageInfo.hasNextPage === true;
      reviewsAfter = pull.reviews.pageInfo.endCursor;
    }
    if (moreThreads) {
      threads.push(...(pull.reviewThreads.nodes ?? []));
      moreThreads = pull.reviewThreads.pageInfo.hasNextPage === true;
      threadsAfter = pull.reviewThreads.pageInfo.endCursor;
    }
  }
  return { reviews, threads };
}

/** Review policy の evidence（review / issue comment / thread / head の commit 日時）を正規化する。 */
export function collectReviewEvidence({ repository, pr, api, graphql, headObservedAt = null }) {
  const headSha = pr.head.sha;
  const reviews = api(`repos/${repository}/pulls/${pr.number}/reviews?per_page=100`, {
    paginate: true,
  }).map((review) => ({
    id: review.id,
    authorLogin: review.user?.login ?? '',
    authorType: review.user?.type ?? '',
    state: review.state,
    commitId: review.commit_id ?? '',
    submittedAt: review.submitted_at ?? '',
    htmlUrl: review.html_url ?? '',
    body: review.body ?? '',
  }));
  const comments = api(`repos/${repository}/issues/${pr.number}/comments?per_page=100`, {
    paginate: true,
  }).map((comment) => ({
    id: comment.id,
    authorLogin: comment.user?.login ?? '',
    authorType: comment.user?.type ?? '',
    authorAssociation: comment.author_association ?? '',
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    htmlUrl: comment.html_url ?? '',
  }));
  let headCommittedAt = null;
  try {
    headCommittedAt =
      api(`repos/${repository}/commits/${headSha}`)?.commit?.committer?.date ?? null;
  } catch {
    headCommittedAt = null;
  }
  const [owner, name] = repository.split('/');
  const pages = fetchAllReviewPages({ graphql, owner, name, number: pr.number });
  const reviewNodeIds = {};
  for (const node of pages.reviews)
    if (node?.databaseId) reviewNodeIds[String(node.databaseId)] = node.id;
  const threads = pages.threads.map((thread) => ({
    id: thread.id,
    isResolved: thread.isResolved === true,
    isOutdated: thread.isOutdated === true,
    path: thread.path ?? null,
    comments: (thread.comments?.nodes ?? []).map((comment) => ({
      authorLogin: comment.author?.login ?? '',
      reviewId: comment.pullRequestReview?.id ?? null,
      body: comment.body ?? '',
    })),
  }));
  return {
    headSha,
    headCommittedAt,
    headObservedAt,
    pr: { number: pr.number, state: pr.state, draft: pr.draft === true },
    reviews,
    comments,
    threads,
    reviewNodeIds,
  };
}

/** event から評価対象 PR を決める。PR 番号が取れなければ null（評価しない）。 */
export function resolveTarget({ eventName, event, prArg, repository, api }) {
  if (prArg !== undefined) {
    const number = Number(prArg);
    return Number.isSafeInteger(number) && number > 0 ? { number, source: 'dispatch' } : null;
  }
  // issue_comment（default branch の定義で走る）は PR 番号で対象を決める。PR 以外の issue は対象外。
  if (eventName === 'issue_comment') {
    const number = event?.issue?.number;
    if (!event?.issue?.pull_request || !Number.isSafeInteger(number) || number < 1) return null;
    return { number, source: eventName };
  }
  const sha = eventShaOf(eventName, event);
  if (!SHA.test(sha ?? '')) return null;
  // stacked branch では commit を含む open PR が複数返る。head がその commit である PR だけを
  // 対象にする（祖先として含むだけの PR を選ぶと stale 判定で skip され、本来の PR が再評価されない）。
  const pulls = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`, { paginate: true });
  const open = pulls.filter(
    (pull) =>
      pull?.state === 'open' &&
      pull?.base?.repo?.full_name === repository &&
      pull?.head?.sha === sha,
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
      createdAt: run.created_at ?? null,
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

// 合成 merge commit を決定的にする: 同じ base / head / tree なら再評価（status event）でも
// 同じ testSha になり、planId が安定する（Codex review P2）。日時は固定値。
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'validation-gate',
  GIT_AUTHOR_EMAIL: 'validation-gate@dayopt.invalid',
  GIT_COMMITTER_NAME: 'validation-gate',
  GIT_COMMITTER_EMAIL: 'validation-gate@dayopt.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
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
  graphql = createGithubGraphql(),
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
      review: null,
    };
  const prIndex = argv.indexOf('--pr');
  const prArg = prIndex >= 0 ? argv[prIndex + 1] : undefined;
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  // trusted event から SHA を先に確保する（API に触る前）。以降の PR 解決・取得・収集・評価の
  // どこで例外が起きても、この SHA へ failure を試行できる（Codex P2、3 巡）。
  const eventSha = eventShaOf(env.GITHUB_EVENT_NAME, event);
  const publishable = publish && TRUSTED_EVENTS.has(env.GITHUB_EVENT_NAME ?? '');
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  let statusSha = SHA.test(eventSha ?? '') ? eventSha : null;
  const post = (context, status) =>
    statusSha === null
      ? output(`::warning::Validation gate: no commit to publish ${context} ${status.state} to\n`)
      : postStatus([
          'api',
          '--method',
          'POST',
          `repos/${repository}/statuses/${statusSha}`,
          '-f',
          `state=${status.state}`,
          '-f',
          `context=${context}`,
          '-f',
          `description=${status.description.slice(0, 140)}`,
          ...(runUrl ? ['-f', `target_url=${runUrl}`] : []),
        ]);
  // fail closed: 対象 PR の解決から評価までを 1 つの try に置き、pending を置いた後はもちろん
  // 置く前の例外でも failure の発行を試みてから再 throw する。これが無いと、同じ head の以前の
  // success が最新 status として残り偽の green になる（Codex P2、2〜3 巡）。open PR が無い
  // event（main への production deployment の status 等）では何も発行しない。
  let pr = null;
  try {
    const target = resolveTarget({
      eventName: env.GITHUB_EVENT_NAME,
      event,
      prArg,
      repository,
      api,
    });
    if (!target) return { skipped: 'no open PR for this event', result: null, review: null };
    pr = api(`repos/${repository}/pulls/${target.number}`);
    // 古い event（head が進んだ後に届いた完了通知）は評価しない。新しい head の event が別に来る。
    if (target.eventSha !== undefined && target.eventSha !== pr.head.sha)
      return {
        skipped: `event head ${target.eventSha} superseded by ${pr.head.sha}`,
        result: null,
        review: null,
      };
    // closed / merged PR の comment 編集等では評価も発行もしない（同じ SHA を使う別の open PR の
    // status を closed PR の証拠で上書きしない。Codex P2）。
    if (pr.state !== 'open')
      return { skipped: `PR #${pr.number} is ${pr.state}`, result: null, review: null };
    statusSha = pr.head.sha;
    if (publishable)
      for (const context of [VALIDATION_STATUS_CONTEXT, REVIEW_STATUS_CONTEXT])
        post(context, { state: 'pending', description: 'Evaluating trusted evidence' });
    return evaluateAndPublish(target, pr);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'evaluation failed';
    if (publishable)
      for (const context of [VALIDATION_STATUS_CONTEXT, REVIEW_STATUS_CONTEXT])
        try {
          post(context, { state: 'failure', description: `indeterminate: ${message}` });
        } catch {
          output(
            `::error::Validation gate: could not publish ${context} failure after: ${message}\n`,
          );
        }
    throw error;
  }

  function evaluateAndPublish(target, pr) {
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
    // head へ切り替わった時刻 = その head の最新の pull_request run 作成時刻。synchronize ごとに
    // 新しい run が作られるため、同じ SHA へ戻した場合も今回の切替を指す（commit 日時より信頼できる）
    const headObservedAt =
      evidence.workflowRuns
        .filter(
          (run) => run.headSha === pr.head.sha && run.event === 'pull_request' && run.createdAt,
        )
        .map((run) => run.createdAt)
        .sort()
        .at(-1) ?? null;
    const reviewEvidence = collectReviewEvidence({ repository, pr, api, graphql, headObservedAt });
    const review = evaluateReviewPolicy({
      plan,
      evidence: reviewEvidence,
      now: now(),
      validationVerdict: result.verdict,
    });
    const summary = formatValidationResult(result) + '\n' + formatReviewPolicy(review);
    output(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    // Codex の起動は shadow では行わない（workflow に pull-requests: write を渡していない）。
    // 起動要否の判定だけを log に残し、#2798 の比較材料にする。
    if (review.trigger.shouldRequest) output(`::notice::Review policy: ${review.trigger.reason}\n`);
    const outPath = env.VALIDATION_RESULT_PATH ? resolve(env.VALIDATION_RESULT_PATH) : null;
    if (outPath)
      writeFileSync(
        outPath,
        `${JSON.stringify({ plan, evidence, result, reviewEvidence, review }, null, 2)}\n`,
      );
    // status の発行は main の定義で走る event（workflow_run / status）に限る。`--pr` はローカルの
    // read-only 実行用で、dispatch で PR ref の定義を走らせる経路は workflow 側に無い（二重防御）。
    if (publish && !publishable)
      output(
        `::notice::Validation gate: status not published for event ${env.GITHUB_EVENT_NAME}\n`,
      );
    if (publishable) {
      post(VALIDATION_STATUS_CONTEXT, toCommitStatus(result));
      post(REVIEW_STATUS_CONTEXT, toReviewCommitStatus(review));
    }
    return { skipped: null, result, review };
  }
}

if (isDirectExecution(import.meta.url)) {
  const outcome = runValidationGate();
  if (outcome.skipped) console.log(`::notice::Validation gate skipped: ${outcome.skipped}`);
}
