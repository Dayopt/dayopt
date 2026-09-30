import { describe, expect, it, vi } from 'vitest';

import { verifyPreviewRecoveryTrust } from './preview-cloud-recovery-trust.mjs';

const sourceRunId = 81726354;
const sourceAttempt = 2;
const workflowSha = 'b'.repeat(40);
const candidateSha = 'a'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const artifactId = 91928374;
const token = 'read-only-recovery-token';
const intent = {
  schemaVersion: 1,
  repository: 'Dayopt/dayopt',
  workflow: '.github/workflows/ci.yml',
  workflowRef: 'refs/heads/integration',
  workflowSha,
  sourceRunId,
  sourceAttempt,
  runId: 'd1ca5300-3f62-4ab7-bfce-eeb02dd42222',
  createdAt: '2026-09-28T09:01:00.000Z',
  userIds: {
    desktop: 'c1047600-2e93-40ea-a9b0-d1c10c30e2a1',
    mobile: '33047600-2e93-40ea-a9b0-d1c10c30e2a2',
  },
  request: {
    prNumber: 2910,
    sha: candidateSha,
    deploymentId: 'dpl_abc123XYZ',
    branchName: 'codex/cloud-preview-test-2910',
    supabaseProjectRef: 'tilwaprottpyhlfoggbb',
    supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
    databaseMode: 'shared',
  },
};

const run = {
  id: sourceRunId,
  path: '.github/workflows/ci.yml@refs/heads/integration',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'cancelled',
  run_attempt: sourceAttempt,
  head_branch: 'integration',
  head_sha: workflowSha,
  repository: { id: 7001, full_name: 'Dayopt/dayopt' },
  head_repository: { id: 7001, full_name: 'Dayopt/dayopt' },
  created_at: '2026-09-28T09:00:00.000Z',
  updated_at: '2026-09-28T09:10:00Z',
};

const sourceAttemptRecord = {
  id: sourceRunId,
  run_attempt: sourceAttempt,
  status: 'completed',
  conclusion: 'cancelled',
  path: '.github/workflows/ci.yml@refs/heads/integration',
  event: 'workflow_dispatch',
  head_branch: 'integration',
  head_sha: workflowSha,
  repository: { id: 7001, full_name: 'Dayopt/dayopt' },
  head_repository: { id: 7001, full_name: 'Dayopt/dayopt' },
  created_at: '2026-09-28T09:00:00Z',
  run_started_at: '2026-09-28T09:00:10Z',
  updated_at: '2026-09-28T09:10:00Z',
};

const jobs = [
  {
    name: 'Preview candidate trust',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-28T09:00:10.000Z',
    completed_at: '2026-09-28T09:00:20.000Z',
    steps: [],
  },
  {
    name: 'Remote Preview login and CRUD',
    status: 'completed',
    conclusion: 'cancelled',
    started_at: '2026-09-28T09:00:30.000Z',
    completed_at: '2026-09-28T09:10:00.000Z',
    steps: [
      {
        name: 'Pinned remote login, desktop and mobile CRUD, and cleanup',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: '2026-09-28T09:03:00Z',
        completed_at: '2026-09-28T09:09:59Z',
      },
    ],
  },
];

const artifact = {
  id: artifactId,
  name: `preview-intent-${sourceRunId}-${sourceAttempt}`,
  size_in_bytes: 8192,
  expired: false,
  digest,
  created_at: '2026-09-28T09:02:00.000Z',
  workflow_run: {
    id: sourceRunId,
    repository_id: 7001,
    head_repository_id: 7001,
    head_branch: 'integration',
    head_sha: workflowSha,
  },
};

type World = {
  environment?: Record<string, unknown>;
  branchPolicies?: Record<string, unknown>;
  run?: Record<string, unknown>;
  sourceAttempt?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
};

function githubWorld(world: World = {}, selectedAttempt = sourceAttempt) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    if (url.pathname === '/repos/Dayopt/dayopt/environments/Preview%20%E2%80%93%20product') {
      return Response.json(
        world.environment ?? {
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      );
    }
    if (
      url.pathname ===
      '/repos/Dayopt/dayopt/environments/Preview%20%E2%80%93%20product/deployment-branch-policies'
    ) {
      return Response.json(
        world.branchPolicies ?? {
          total_count: 1,
          branch_policies: [{ name: 'integration', type: 'branch' }],
        },
      );
    }
    if (url.pathname === `/repos/Dayopt/dayopt/actions/runs/${sourceRunId}`) {
      return Response.json(world.run ?? run);
    }
    const attemptRecordMatch = url.pathname.match(
      new RegExp(`^/repos/Dayopt/dayopt/actions/runs/${sourceRunId}/attempts/(\\d+)$`),
    );
    if (attemptRecordMatch) {
      expect(Number(attemptRecordMatch[1])).toBe(selectedAttempt);
      return Response.json(world.sourceAttempt ?? sourceAttemptRecord);
    }
    const jobsMatch = url.pathname.match(
      new RegExp(`^/repos/Dayopt/dayopt/actions/runs/${sourceRunId}/attempts/(\\d+)/jobs$`),
    );
    if (jobsMatch) {
      expect(Number(jobsMatch[1])).toBe(selectedAttempt);
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('page')).toBe('1');
      return Response.json(world.jobs ?? { total_count: jobs.length, jobs });
    }
    if (url.pathname === `/repos/Dayopt/dayopt/actions/runs/${sourceRunId}/artifacts`) {
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('page')).toBe('1');
      const artifacts = world.artifacts ?? {
        total_count: 2,
        artifacts: [
          { ...artifact, name: `preview-intent-${sourceRunId}-${selectedAttempt}` },
          { id: 91928375, name: 'preview-e2e-public' },
        ],
      };
      return Response.json(artifacts);
    }
    throw new Error(`unexpected GitHub endpoint ${url.pathname}`);
  });
  return { fetchImpl };
}

const context = {
  repository: 'Dayopt/dayopt',
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/integration',
  token,
  sourceRunId: String(sourceRunId),
  sourceAttempt: String(sourceAttempt),
  intent,
};

describe('Preview Cloud recovery trust gate', () => {
  it('accepts only the exact completed Integration attempt, passed trust job, failed execute step, and intent artifact', async () => {
    const { fetchImpl } = githubWorld();
    const result = await verifyPreviewRecoveryTrust({ ...context, fetchImpl });
    expect(result).toEqual({ intent, artifactId, digest });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(
      fetchImpl.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/pulls/')),
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    ['wrong event', { eventName: 'pull_request' }],
    ['wrong repository', { repository: 'attacker/repo' }],
    ['wrong recovery ref', { ref: 'refs/heads/main' }],
    ['missing token', { token: '' }],
    ['noncanonical run string', { sourceRunId: '081726354' }],
    ['unsafe run number', { sourceRunId: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional attempt', { sourceAttempt: '2.0' }],
    ['exponent attempt', { sourceAttempt: '2e0' }],
    ['zero attempt', { sourceAttempt: '0' }],
  ])('rejects %s before making API calls', async (_label, override) => {
    const { fetchImpl } = githubWorld();
    await expect(
      verifyPreviewRecoveryTrust({ ...context, ...override, fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['source run id', { sourceRunId: sourceRunId + 1 }],
    ['attempt', { sourceAttempt: sourceAttempt + 1 }],
    ['run UUID', { runId: intent.userIds.desktop }],
    ['user UUID', { userIds: { ...intent.userIds, mobile: intent.userIds.desktop } }],
  ])('rejects a malformed or mismatched intent %s before API calls', async (_label, changes) => {
    const { fetchImpl } = githubWorld();
    await expect(
      verifyPreviewRecoveryTrust({
        ...context,
        intent: { ...intent, ...changes },
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an intent bound to a different Integration workflow SHA before jobs or artifact lookup', async () => {
    const { fetchImpl } = githubWorld();
    await expect(
      verifyPreviewRecoveryTrust({
        ...context,
        intent: { ...intent, workflowSha: 'e'.repeat(40) },
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/attempts/'))).toBe(
      false,
    );
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/artifacts'))).toBe(
      false,
    );
  });

  it.each([
    ['still in progress', { status: 'in_progress' }],
    ['latest attempt predates the requested attempt', { run_attempt: sourceAttempt - 1 }],
    ['wrong event', { event: 'pull_request' }],
    ['wrong source branch', { head_branch: 'feature' }],
    ['wrong workflow SHA', { head_sha: 'e'.repeat(40) }],
    ['wrong workflow', { path: '.github/workflows/promote.yml@refs/heads/integration' }],
    ['wrong repository', { repository: { id: 7002, full_name: 'attacker/repo' } }],
    ['fork head repository', { head_repository: { id: 7002, full_name: 'someone/fork' } }],
  ])('rejects source run that is %s before reading jobs or artifacts', async (_label, changes) => {
    const { fetchImpl } = githubWorld({ run: { ...run, ...changes } });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/artifacts'))).toBe(
      false,
    );
  });

  it('allows an earlier failed attempt when the latest completed attempt succeeded', async () => {
    const historicalIntent = { ...intent, sourceAttempt: 1 };
    const { fetchImpl } = githubWorld(
      {
        run: {
          ...run,
          run_attempt: 2,
          conclusion: 'success',
          updated_at: '2026-09-28T09:30:00Z',
        },
        sourceAttempt: { ...sourceAttemptRecord, run_attempt: 1, conclusion: 'failure' },
      },
      1,
    );
    const result = await verifyPreviewRecoveryTrust({
      ...context,
      sourceAttempt: '1',
      intent: historicalIntent,
      fetchImpl,
    });
    expect(result).toEqual({ intent: historicalIntent, artifactId, digest });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('rejects when the intent timestamp is later than the E2E execute step start', async () => {
    const { fetchImpl } = githubWorld();
    await expect(
      verifyPreviewRecoveryTrust({
        ...context,
        intent: { ...intent, createdAt: '2026-09-28T09:04:00.000Z' },
        fetchImpl,
      }),
    ).rejects.toThrow('source intent and attempt timestamps are inconsistent');
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/artifacts'))).toBe(
      false,
    );
  });

  it('rejects when the target attempt update predates the interrupted E2E job completion', async () => {
    const { fetchImpl } = githubWorld({
      sourceAttempt: { ...sourceAttemptRecord, updated_at: '2026-09-28T09:09:59Z' },
    });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow(
      'source intent and attempt timestamps are inconsistent',
    );
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/artifacts'))).toBe(
      false,
    );
  });

  it.each([
    ['still active', { status: 'in_progress' }],
    ['successful', { conclusion: 'success' }],
    ['wrong attempt number', { run_attempt: sourceAttempt + 1 }],
    ['wrong branch', { head_branch: 'feature' }],
    ['wrong workflow SHA', { head_sha: 'e'.repeat(40) }],
    ['missing start time', { run_started_at: null }],
  ])('rejects a selected source attempt that is %s', async (_label, changes) => {
    const { fetchImpl } = githubWorld({ sourceAttempt: { ...sourceAttemptRecord, ...changes } });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/jobs'))).toBe(false);
  });

  it('rejects if the latest attempt changes while recovery proof is being read', async () => {
    const { fetchImpl: baseFetch } = githubWorld();
    let runReads = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === `/repos/Dayopt/dayopt/actions/runs/${sourceRunId}`) {
        runReads += 1;
        if (runReads === 2) return Response.json({ ...run, run_attempt: sourceAttempt + 1 });
      }
      return baseFetch(input, init);
    });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow(
      'source run changed during recovery verification',
    );
    expect(runReads).toBe(2);
  });

  it.each([
    [
      'trust job did not pass',
      {
        total_count: 2,
        jobs: [{ ...jobs[0], conclusion: 'failure' }, jobs[1]],
      },
    ],
    [
      'E2E job was successful',
      {
        total_count: 2,
        jobs: [jobs[0], { ...jobs[1], conclusion: 'success' }],
      },
    ],
    [
      'E2E job did not start',
      {
        total_count: 2,
        jobs: [jobs[0], { ...jobs[1], started_at: null }],
      },
    ],
    [
      'E2E job did not complete',
      {
        total_count: 2,
        jobs: [jobs[0], { ...jobs[1], completed_at: null }],
      },
    ],
    [
      'execute step did not start',
      {
        total_count: 2,
        jobs: [
          jobs[0],
          {
            ...jobs[1],
            steps: [{ ...jobs[1].steps[0], started_at: null }],
          },
        ],
      },
    ],
    [
      'execute step did not fail',
      {
        total_count: 2,
        jobs: [
          jobs[0],
          {
            ...jobs[1],
            steps: [{ ...jobs[1].steps[0], conclusion: 'success' }],
          },
        ],
      },
    ],
    ['job pagination is incomplete', { total_count: 101, jobs, hasNextPage: true }],
  ])('rejects when the source attempt proves %s', async (_label, jobBody) => {
    const { fetchImpl } = githubWorld({ jobs: jobBody });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/artifacts'))).toBe(
      false,
    );
  });

  it.each([
    ['artifact absent', { total_count: 1, artifacts: [{ id: 1, name: 'other' }] }],
    ['duplicate intent artifacts', { total_count: 2, artifacts: [artifact, artifact] }],
    ['expired', { total_count: 1, artifacts: [{ ...artifact, expired: true }] }],
    ['oversized', { total_count: 1, artifacts: [{ ...artifact, size_in_bytes: 131073 }] }],
    ['invalid digest', { total_count: 1, artifacts: [{ ...artifact, digest: 'unknown' }] }],
    [
      'wrong source run',
      {
        total_count: 1,
        artifacts: [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 8 } }],
      },
    ],
    [
      'wrong artifact repository',
      {
        total_count: 1,
        artifacts: [
          { ...artifact, workflow_run: { ...artifact.workflow_run, repository_id: 7002 } },
        ],
      },
    ],
    [
      'wrong artifact head',
      {
        total_count: 1,
        artifacts: [
          { ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: 'e'.repeat(40) } },
        ],
      },
    ],
    [
      'artifact pagination is incomplete',
      { total_count: 101, artifacts: [artifact], hasNextPage: true },
    ],
  ])('rejects an intent artifact that is %s', async (_label, artifacts) => {
    const { fetchImpl } = githubWorld({ artifacts });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow();
  });

  it('requires the Integration-only Environment boundary and hides raw API responses', async () => {
    const { fetchImpl } = githubWorld({
      environment: {
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
      },
    });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toMatchObject({
      message:
        'Preview Cloud trust: Preview environment must use a branch-specific deployment policy',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rejectedFetch = vi.fn(
      async () => new Response(`${token} private response`, { status: 403 }),
    );
    await expect(
      verifyPreviewRecoveryTrust({ ...context, fetchImpl: rejectedFetch }),
    ).rejects.toMatchObject({ message: 'Preview Cloud trust: GitHub read failed' });
  });
});

describe('prepared fixture interruption before E2E', () => {
  it.each(['cancelled', 'success'])(
    'authenticates started provision (%s) even when candidate execution never started',
    async (conclusion) => {
      const prepared = structuredClone(jobs);
      prepared[1]!.name = 'Provision Preview fixtures';
      prepared[1]!.conclusion = conclusion;
      prepared[1]!.steps![0]!.conclusion = conclusion;
      prepared[1]!.steps![0]!.name = 'Provision encrypted Preview fixtures';
      const { fetchImpl } = githubWorld({ jobs: { total_count: prepared.length, jobs: prepared } });
      const result = await verifyPreviewRecoveryTrust({ ...context, fetchImpl });
      expect(result).toMatchObject({ intent, recoveryMode: 'broker' });
    },
  );
  it('rejects mixed legacy and prepared execution in the same attempt', async () => {
    const prepared = structuredClone(jobs[1]!);
    prepared.name = 'Provision Preview fixtures';
    prepared.steps![0]!.name = 'Provision encrypted Preview fixtures';
    const { fetchImpl } = githubWorld({
      jobs: { total_count: jobs.length + 1, jobs: [...jobs, prepared] },
    });
    await expect(verifyPreviewRecoveryTrust({ ...context, fetchImpl })).rejects.toThrow();
  });
});
