/**
 * Validation（#2795）の純粋評価。plan（scripts/lib/validation-plan.mjs）と取得済み
 * evidence から「必要な証拠が、信頼できる producer から、正しい対象について揃って
 * いるか」を返す。ネットワーク・git・環境変数には触れない。
 *
 * 判定の原則:
 * - 必要 suite は明示的な success だけが satisfied。skipped / neutral / cancelled /
 *   timed_out / failure / 未完了 / 不在は合格にしない
 * - producer は workflow path + job 名 + event + head SHA + repository で照合する。
 *   同名 check を別 workflow が出しても採用しない（PR が workflow を追加・改名して
 *   自分を免除する経路を閉じる）
 * - 同一 head の複数 run は最新 run（id 最大）の最新 attempt だけを見る。古い run の
 *   success で最新の failure を隠さない
 * - deployment は commit status の緑だけでなく、同じ SHA の Preview deployment と
 *   その最新 status を要求する。production environment は受理しない
 * - 「計画上 not-applicable」だけを理由付きで受理する。producer が未接続の suite は
 *   `unwired` として不合格に残す（成功 stub にしない）
 * - 証拠が head SHA に束縛される GitHub の意味論（pull_request の check は head、
 *   実行 tree は refs/pull/N/merge）に合わせ、base が進んだ head は `update-branch` として
 *   pending にする。strict up-to-date の ruleset と同じ向き
 */

export const VALIDATION_VERSION = 1;
export const VALIDATION_STATUS_CONTEXT = 'Validation (shadow)';

const CI_WORKFLOW = '.github/workflows/ci.yml';
const PROMOTE_WORKFLOW = '.github/workflows/promote.yml';

/**
 * suite ごとの信頼済み producer。plan の `required` キーと 1:1。
 * `stage: 'merge'` は merge 判定に含める。`stage: 'release'` は promote.yml の層 3 が
 * merge 後・公開前に生産する証拠で、merge 判定には含めず deferred として表示する
 * （merge と本番公開を別の判断にする #2793 の原則）。
 */
export const PRODUCERS = Object.freeze({
  static: { stage: 'merge', kind: 'actions-job', workflow: CI_WORKFLOW, job: '🔍 Static Checks' },
  scripts: { stage: 'merge', kind: 'actions-job', workflow: CI_WORKFLOW, job: '📦 Unit Tests' },
  productUnit: { stage: 'merge', kind: 'actions-job', workflow: CI_WORKFLOW, job: '📦 Unit Tests' },
  webCi: { stage: 'merge', kind: 'actions-job', workflow: CI_WORKFLOW, job: '📦 Unit Tests' },
  mcpConformance: {
    stage: 'merge',
    kind: 'actions-job',
    workflow: CI_WORKFLOW,
    job: '📦 Unit Tests',
  },
  integration: {
    stage: 'merge',
    kind: 'actions-job',
    workflow: CI_WORKFLOW,
    job: '🧪 Integration Tests',
  },
  dbFresh: {
    stage: 'merge',
    kind: 'actions-job',
    workflow: CI_WORKFLOW,
    job: '🧪 Integration Tests',
  },
  productPreview: {
    stage: 'merge',
    kind: 'deployment',
    context: 'Vercel – product',
    environment: 'Preview – product',
  },
  webPreview: {
    stage: 'merge',
    kind: 'deployment',
    context: 'Vercel – web',
    environment: 'Preview – web',
  },
  productJourney: {
    stage: 'release',
    kind: 'release-gate',
    workflow: PROMOTE_WORKFLOW,
    job: '🎭 E2E Tests',
  },
  webPreviewSmoke: {
    stage: 'release',
    kind: 'release-gate',
    workflow: PROMOTE_WORKFLOW,
    job: '🌐 Web Build & E2E',
  },
  dbUpgrade: {
    stage: 'merge',
    kind: 'actions-job',
    workflow: CI_WORKFLOW,
    job: '🧱 DB Upgrade (shadow)',
  },
  oldConsumer: {
    stage: 'merge',
    kind: 'actions-job',
    workflow: CI_WORKFLOW,
    job: '🧱 DB Upgrade (shadow)',
  },
});

/** Supabase GitHub integration の check run 名。branch が作られた PR だけ success になる。 */
export const SUPABASE_PREVIEW_CHECK = 'Supabase Preview';
/** 公式 Supabase GitHub App の slug（app id 330661）。check 名は App 間で一意ではないので発行元も照合する。 */
export const SUPABASE_APP_SLUG = 'supabase';

const SHA = /^[a-f0-9]{40}$/;
const SUCCESS = 'success';

/**
 * `pull_request` の CI run は **PR 側の workflow 定義**で走る。これらの path を PR が変えていると、
 * job 名を保ったまま検査 step を空にした run が同名の success を作れる（Codex review P2、
 * PR #2804）。その run は producer として信用せず `self-produced` にする。保証境界は job の
 * 配線ファイルまで（vitest 設定や package.json scripts の改変は review 側の観点）。
 */
export const PRODUCER_DEFINITIONS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/actions/setup/action.yml',
  'scripts/ci/check.mjs',
  'scripts/ci/impact.mjs',
]);

/**
 * producer 固有の定義ファイル（その suite の評価でだけ self-produced にする）。
 * 🧱 DB Upgrade (shadow) の実体を migration と同時に改変した PR の緑は信用しないが、
 * checker だけの保守 PR で Static / Unit まで self-produced にはしない。
 */
export const PRODUCER_SPECIFIC_DEFINITIONS = Object.freeze({
  '🧱 DB Upgrade (shadow)': ['scripts/ci/db-upgrade-check.mjs'],
});

/**
 * @typedef {{ id: number, path: string, event: string, headSha: string, repository: string,
 *   runAttempt: number, status: string, conclusion: string | null, htmlUrl: string,
 *   jobs: { name: string, status: string, conclusion: string | null, runAttempt: number,
 *   htmlUrl: string }[] }} WorkflowRunEvidence
 * @typedef {{ context: string, state: string, targetUrl: string | null, description: string | null }} StatusEvidence
 * @typedef {{ id: number, sha: string, environment: string, productionEnvironment: boolean,
 *   createdAt: string, latestStatus: { state: string, environmentUrl: string | null } | null }} DeploymentEvidence
 * @typedef {{ id: number, name: string, appSlug: string, headSha: string, status: string,
 *   conclusion: string | null, htmlUrl: string }} CheckRunEvidence
 * @typedef {{ repository: string, prNumber: number, headSha: string, ancestorSha: string,
 *   environment: string, deploymentId: number, url: string | null, unchanged: boolean,
 *   productionEnvironment: boolean }} InheritedPreviewEvidence
 * @typedef {{ repository: string, headSha: string, fetchedAt: string,
 *   pr: { number: number, state: string, draft: boolean, headSha: string, baseRef: string, fork: boolean },
 *   baseCompare: string, workflowRuns: WorkflowRunEvidence[], statuses: StatusEvidence[],
 *   deployments: DeploymentEvidence[], inheritedPreviews?: InheritedPreviewEvidence[],
 *   checkRuns?: CheckRunEvidence[] }} ValidationEvidence
 */

/** 同一 head の信頼済み run を 1 本選ぶ。id 最大 = 最新 run。 */
export function selectTrustedRun(runs, { repository, headSha, workflow }) {
  const candidates = (runs ?? []).filter(
    (run) =>
      run &&
      run.repository === repository &&
      run.path === workflow &&
      run.event === 'pull_request' &&
      run.headSha === headSha &&
      Number.isSafeInteger(run.id),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, run) => (run.id > latest.id ? run : latest));
}

function evaluateActionsJob(producer, evidence, plan) {
  const definitions = [
    ...PRODUCER_DEFINITIONS,
    ...(PRODUCER_SPECIFIC_DEFINITIONS[producer.job] ?? []),
  ];
  const modified = (plan?.files ?? []).filter((file) => definitions.includes(file));
  if (modified.length > 0)
    return {
      status: 'self-produced',
      reason: `This PR changes the producer definition (${modified.join(', ')}); its own run cannot prove the suite`,
      evidence: null,
    };
  const run = selectTrustedRun(evidence.workflowRuns, {
    repository: evidence.repository,
    headSha: evidence.headSha,
    workflow: producer.workflow,
  });
  if (!run)
    return {
      status: 'missing',
      reason: `No pull_request run of ${producer.workflow} for this head`,
      evidence: null,
    };
  const detail = { runId: run.id, runAttempt: run.runAttempt, url: run.htmlUrl };
  const job = (run.jobs ?? []).find(
    (candidate) => candidate.name === producer.job && candidate.runAttempt === run.runAttempt,
  );
  if (!job) {
    if (run.status !== 'completed')
      return { status: 'pending', reason: `${producer.job} has not started`, evidence: detail };
    return {
      status: 'missing',
      reason: `${producer.job} is absent from the latest attempt of run ${run.id}`,
      evidence: detail,
    };
  }
  const jobDetail = { ...detail, url: job.htmlUrl || run.htmlUrl };
  if (job.status !== 'completed')
    return { status: 'pending', reason: `${producer.job} is ${job.status}`, evidence: jobDetail };
  if (job.conclusion === SUCCESS)
    return { status: 'satisfied', reason: `${producer.job} succeeded`, evidence: jobDetail };
  if (job.conclusion === 'skipped')
    return {
      status: 'skipped',
      reason: `${producer.job} was skipped although the plan requires it`,
      evidence: jobDetail,
    };
  return {
    status: 'failed',
    reason: `${producer.job} concluded ${job.conclusion ?? 'unknown'}`,
    evidence: jobDetail,
  };
}

function latestDeployment(deployments, { headSha, environment }) {
  const matching = (deployments ?? []).filter(
    (deployment) =>
      deployment &&
      deployment.sha === headSha &&
      deployment.environment === environment &&
      Number.isSafeInteger(deployment.id),
  );
  if (matching.length === 0) return null;
  return matching.reduce((latest, deployment) =>
    deployment.createdAt > latest.createdAt ||
    (deployment.createdAt === latest.createdAt && deployment.id > latest.id)
      ? deployment
      : latest,
  );
}

/**
 * DB を触る変更の product Preview は、隔離された PR 用 Supabase branch に接続していることを
 * 要求する。Supabase integration は migration を含む PR でだけ branch を作り、その時
 * `Supabase Preview` check run が success になる（skipped = branch 無し）。発行元 App も照合する
 * （別の installed App が同名の check を作っても受理しない）。branch が無い
 * Preview は shared / 不明な DB を指すので、DB 変更の検証環境として受理しない。
 */
function evaluateDatabaseIsolation(evidence, plan) {
  const check = (evidence.checkRuns ?? [])
    .filter(
      (run) =>
        run.name === SUPABASE_PREVIEW_CHECK &&
        run.appSlug === SUPABASE_APP_SLUG &&
        run.headSha === evidence.headSha,
    )
    .reduce((latest, run) => (!latest || run.id > latest.id ? run : latest), null);
  const needed = plan?.environments?.databaseTests !== 'not-applicable';
  if (!needed)
    return { needed, status: 'not-applicable', reason: 'No migration in this PR', check };
  // integration が check run を作るのは CI 完了より遅れ得る。無いことは「未作成」であって拒否ではない
  // ので pending（controller は bounded に待ち、check_run 完了の event で再評価する）
  if (!check)
    return {
      needed,
      status: 'pending',
      reason: 'Supabase Preview check has not been created for this head yet',
      check,
    };
  if (check.status !== 'completed')
    return {
      needed,
      status: 'pending',
      reason: 'Supabase Preview branch is still provisioning',
      check,
    };
  if (check.conclusion === SUCCESS)
    return {
      needed,
      status: 'satisfied',
      reason: 'Isolated Supabase branch reported ready',
      check,
    };
  return {
    needed,
    status: 'failed',
    reason: `Supabase Preview concluded ${check.conclusion ?? 'unknown'}; no isolated database for a schema change`,
    check,
  };
}

function evaluateDeployment(producer, evidence, plan) {
  if (producer.environment === 'Preview – product') {
    const isolation = evaluateDatabaseIsolation(evidence, plan);
    if (isolation.needed && isolation.status !== 'satisfied')
      return {
        status: isolation.status,
        reason: isolation.reason,
        evidence: {
          environment: producer.environment,
          supabasePreview: isolation.check?.htmlUrl ?? null,
          url: null,
        },
      };
  }
  const status = (evidence.statuses ?? []).find((entry) => entry.context === producer.context);
  const deployment = latestDeployment(evidence.deployments, {
    headSha: evidence.headSha,
    environment: producer.environment,
  });
  const detail = {
    statusState: status?.state ?? null,
    statusUrl: status?.targetUrl ?? null,
    deploymentId: deployment?.id ?? null,
    environment: producer.environment,
    url: deployment?.latestStatus?.environmentUrl ?? status?.targetUrl ?? null,
  };
  if (!status && !deployment)
    return {
      status: 'missing',
      reason: `No ${producer.context} status or ${producer.environment} deployment for this head`,
      evidence: detail,
    };
  if (deployment?.productionEnvironment)
    return {
      status: 'failed',
      reason: `${producer.environment} deployment is marked as production`,
      evidence: detail,
    };
  if (status && /ignored build step/i.test(status.description ?? '')) {
    const inherited = (evidence.inheritedPreviews ?? []).find(
      (entry) =>
        entry.repository === evidence.repository &&
        entry.prNumber === evidence.pr.number &&
        entry.headSha === evidence.headSha &&
        entry.ancestorSha !== evidence.headSha &&
        /^[a-f0-9]{40}$/.test(entry.ancestorSha) &&
        entry.environment === producer.environment &&
        entry.unchanged === true &&
        entry.productionEnvironment === false &&
        Number.isSafeInteger(entry.deploymentId),
    );
    if (status.state === SUCCESS && inherited)
      return {
        status: 'satisfied',
        reason: `${producer.environment} inherited deployment ${inherited.deploymentId} from ${inherited.ancestorSha}; no application impact since that ancestor`,
        evidence: { ...detail, ...inherited },
      };
    return {
      status: 'failed',
      reason: `${producer.context} was cancelled by Ignored Build Step although the plan requires a build`,
      evidence: detail,
    };
  }
  if (!status || status.state === 'pending')
    return { status: 'pending', reason: `${producer.context} is pending`, evidence: detail };
  if (status.state !== SUCCESS)
    return {
      status: 'failed',
      reason: `${producer.context} reported ${status.state}`,
      evidence: detail,
    };
  if (!deployment)
    return {
      status: 'missing',
      reason: `${producer.context} is green but no ${producer.environment} deployment records this head`,
      evidence: detail,
    };
  const state = deployment.latestStatus?.state ?? null;
  if (state === SUCCESS)
    return {
      status: 'satisfied',
      reason: `${producer.environment} deployment ${deployment.id} succeeded for this head`,
      evidence: detail,
    };
  if (state === null || ['pending', 'queued', 'in_progress'].includes(state))
    return {
      status: 'pending',
      reason: `${producer.environment} deployment ${deployment.id} is ${state ?? 'not reported'}`,
      evidence: detail,
    };
  return {
    status: 'failed',
    reason: `${producer.environment} deployment ${deployment.id} is ${state}`,
    evidence: detail,
  };
}

function evaluateSuite(name, rule, evidence, plan) {
  const producer = PRODUCERS[name];
  if (!producer)
    return {
      status: 'unwired',
      reason: `No trusted producer is defined for ${name}`,
      evidence: null,
    };
  if (rule.status === 'indeterminate')
    return { status: 'indeterminate', reason: rule.reason, evidence: null };
  if (rule.status === 'not-applicable')
    return { status: 'not-applicable', reason: rule.reason, evidence: null };
  if (rule.status !== 'required')
    return {
      status: 'indeterminate',
      reason: `Unknown plan status ${rule.status}`,
      evidence: null,
    };
  switch (producer.kind) {
    case 'actions-job':
      return evaluateActionsJob(producer, evidence, plan);
    case 'deployment':
      return evaluateDeployment(producer, evidence, plan);
    case 'release-gate':
      return {
        status: 'deferred',
        reason: `Produced by ${producer.job} in ${producer.workflow} after merge, before Production publish`,
        evidence: null,
      };
    default:
      return {
        status: 'unwired',
        reason: `Trusted producer for ${name} is not connected yet (${producer.issue ?? 'no issue'})`,
        evidence: null,
      };
  }
}

const BLOCKING = new Set([
  'failed',
  'missing',
  'skipped',
  'unwired',
  'indeterminate',
  'self-produced',
]);

function latestCiFailures(evidence) {
  const run = selectTrustedRun(evidence.workflowRuns, {
    repository: evidence.repository,
    headSha: evidence.headSha,
    workflow: CI_WORKFLOW,
  });
  if (!run) return [];
  return (run.jobs ?? [])
    .filter(
      (job) =>
        job.runAttempt === run.runAttempt &&
        job.status === 'completed' &&
        ['failure', 'cancelled', 'timed_out'].includes(job.conclusion ?? ''),
    )
    .map((job) => `${job.name} (${job.conclusion})`);
}

/**
 * Review の依頼時点だけを判定する。Validation の証拠としては self-produced を受理しないが、
 * guardrail 自身を変える PR でも native required job が完了するまで待った後に独立レビューへ
 * 出せなければ、最もレビューが必要な差分だけ候補にならない。ここで raw job を見るのは
 * merge 安全性の証明ではなくタイミング制御だけで、Validation verdict は blocked のまま保つ。
 */
function isReviewCandidateReady(plan, evidence, suites) {
  if (
    plan?.status !== 'determinate' ||
    evidence?.pr?.state !== 'open' ||
    evidence?.pr?.draft ||
    evidence?.pr?.fork ||
    !['ahead', 'identical'].includes(evidence?.baseCompare)
  )
    return false;

  const trustedRuns = new Map();
  const selfProducedReady = (name) => {
    const producer = PRODUCERS[name];
    if (producer?.stage !== 'merge' || producer.kind !== 'actions-job') return false;
    let run = trustedRuns.get(producer.workflow);
    if (run === undefined) {
      run = selectTrustedRun(evidence.workflowRuns, {
        repository: evidence.repository,
        headSha: evidence.headSha,
        workflow: producer.workflow,
      });
      trustedRuns.set(producer.workflow, run);
    }
    const job = (run?.jobs ?? []).find(
      (candidate) => candidate.name === producer.job && candidate.runAttempt === run.runAttempt,
    );
    return job?.status === 'completed' && ['success', 'skipped'].includes(job.conclusion ?? '');
  };

  const ready = Object.entries(suites)
    .filter(([, suite]) => suite.stage === 'merge')
    .every(([name, suite]) =>
      ['satisfied', 'not-applicable'].includes(suite.status)
        ? true
        : suite.status === 'self-produced' && selfProducedReady(name),
    );
  return ready && latestCiFailures(evidence).length === 0;
}

/**
 * @param {{ plan: any, evidence: ValidationEvidence }} input
 */
export function evaluateValidation({ plan, evidence }) {
  const reasons = [];
  const identityProblems = [];
  if (!plan || typeof plan !== 'object') identityProblems.push('plan missing');
  const headSha = plan?.identity?.headSha;
  if (!SHA.test(headSha ?? '')) identityProblems.push('plan head revision missing');
  if (!evidence || typeof evidence !== 'object') identityProblems.push('evidence missing');
  else {
    if (evidence.headSha !== headSha) identityProblems.push('evidence head does not match plan');
    if (evidence.repository !== plan?.identity?.repository)
      identityProblems.push('evidence repository does not match plan');
    if (evidence.pr?.number !== plan?.identity?.prNumber)
      identityProblems.push('evidence PR does not match plan');
    if (evidence.pr?.headSha !== headSha) identityProblems.push('PR head moved since evidence');
  }
  /** @type {Record<string, { status: string, reason: string, evidence: Record<string, any> | null, stage?: string, plan?: string }>} */
  const suites = {};
  for (const [name, rule] of Object.entries(plan?.required ?? {})) {
    suites[name] =
      identityProblems.length > 0
        ? { status: 'indeterminate', reason: identityProblems.join('; '), evidence: null }
        : evaluateSuite(name, rule, evidence, plan);
    suites[name].stage = PRODUCERS[name]?.stage ?? 'merge';
    suites[name].plan = rule.status;
  }
  let verdict;
  if (identityProblems.length > 0) {
    verdict = 'indeterminate';
    reasons.push(...identityProblems);
  } else if (plan.status !== 'determinate') {
    verdict = 'indeterminate';
    reasons.push(...(plan.problems ?? ['plan is not determinate']));
  } else if (evidence.pr.state !== 'open' || evidence.pr.draft) {
    verdict = 'not-evaluated';
    reasons.push(evidence.pr.draft ? 'PR is draft' : `PR is ${evidence.pr.state}`);
  } else if (evidence.pr.fork) {
    verdict = 'indeterminate';
    reasons.push('fork head; evidence semantics differ');
  } else {
    const merge = Object.entries(suites).filter(([, suite]) => suite.stage === 'merge');
    const blocking = merge.filter(([, suite]) => BLOCKING.has(suite.status));
    const pending = merge.filter(([, suite]) => suite.status === 'pending');
    for (const [name, suite] of blocking) reasons.push(`${name}: ${suite.reason}`);
    for (const [name, suite] of pending) reasons.push(`${name}: ${suite.reason}`);
    // 計画上 not-applicable でも、信頼済み CI run の最新 attempt に赤い job があれば通さない
    // （既存 ruleset と同じ向き。plan が緩くても赤を隠さない）。
    const failedJobs = latestCiFailures(evidence);
    for (const job of failedJobs) reasons.push(`failed check: ${job}`);
    if (blocking.length > 0 || failedJobs.length > 0) verdict = 'blocked';
    else if (pending.length > 0) verdict = 'pending';
    else if (!['ahead', 'identical'].includes(evidence.baseCompare)) {
      verdict = 'pending';
      reasons.push(`update-branch: head is ${evidence.baseCompare} relative to base`);
    } else verdict = 'pass';
  }
  return {
    version: VALIDATION_VERSION,
    planId: plan?.planId ?? null,
    identity: plan?.identity ?? null,
    fetchedAt: evidence?.fetchedAt ?? null,
    verdict,
    reviewCandidateReady: isReviewCandidateReady(plan, evidence, suites),
    reasons,
    suites,
    review: plan?.review ?? null,
  };
}

/** commit status（context `Validation (shadow)`）の state / description。 */
export function toCommitStatus(result) {
  const description = (text) => text.slice(0, 140);
  switch (result.verdict) {
    case 'pass':
      return { state: 'success', description: description('All merge-stage evidence verified') };
    case 'pending':
      return {
        state: 'pending',
        description: description(result.reasons[0] ?? 'Waiting for evidence'),
      };
    case 'not-evaluated':
      return { state: 'pending', description: description(result.reasons[0] ?? 'Not evaluated') };
    default:
      return {
        state: 'failure',
        description: description(`${result.verdict}: ${result.reasons[0] ?? 'see summary'}`),
      };
  }
}

const ICON = {
  satisfied: '✅',
  'not-applicable': '⬜',
  deferred: '⏩',
  pending: '⏳',
  failed: '❌',
  missing: '❌',
  skipped: '❌',
  unwired: '🚧',
  'self-produced': '🚫',
  indeterminate: '❓',
};

export function formatValidationResult(result) {
  const lines = [
    '## Validation (shadow)',
    '',
    `Verdict: **${result.verdict}**（plan \`${result.planId ?? 'n/a'}\`, head \`${result.identity?.headSha ?? 'n/a'}\`）`,
    '',
    '| Suite | Plan | Evidence | Reason | Link |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [name, suite] of Object.entries(result.suites)) {
    const link = suite.evidence?.url ? `[run](${suite.evidence.url})` : '';
    const stage = suite.stage === 'release' ? ' (release)' : '';
    lines.push(
      `| ${name}${stage} | ${suite.plan} | ${ICON[suite.status] ?? ''} ${suite.status} | ${suite.reason.replaceAll('|', '\\|')} | ${link} |`,
    );
  }
  if (result.reasons.length) lines.push('', ...result.reasons.map((reason) => `- ${reason}`));
  lines.push(
    '',
    'Shadow only: this verdict is not a required check. Existing required checks and the ruleset are unchanged.',
  );
  return `${lines.join('\n')}\n`;
}
