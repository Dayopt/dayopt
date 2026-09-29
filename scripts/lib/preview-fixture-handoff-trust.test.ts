import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PREVIEW_FIXTURE_HANDOFF_CONTRACT as contract,
  previewFixtureHandoffArtifactName,
  verifyPreviewFixtureHandoffTrust,
} from './preview-fixture-handoff-trust.mjs';

const token = 'PRIVATE_GITHUB_READ_TOKEN';
const runId = 81726354;
const attempt = 2;
const sha = 'b'.repeat(40);
const base = Math.floor(Date.now() / 1000) * 1000 - 300_000;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(base + 300_000);
});
afterEach(() => vi.restoreAllMocks());
const iso = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const input = {
  operation: 'provision',
  origin: 'https://product-example123-dayopt.vercel.app',
  execution: { runId, attempt, workflowSha: sha },
  intent: {
    schemaVersion: 1,
    repository: 'Dayopt/dayopt',
    workflow: '.github/workflows/ci.yml',
    workflowRef: 'refs/heads/integration',
    workflowSha: sha,
    sourceRunId: runId,
    sourceAttempt: attempt,
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: iso(45),
    userIds: {
      desktop: '11111111-1111-4111-8111-111111111111',
      mobile: '22222222-2222-4222-8222-222222222222',
    },
    request: {
      sha: 'a'.repeat(40),
      deploymentId: 'dpl_example123',
      prNumber: 2954,
      branchName: 'codex/example',
      databaseMode: 'ephemeral',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      supabaseBranchId: '33333333-3333-4333-8333-333333333333',
    },
  },
};
type Data = Record<string, unknown>;
type Role = 'public-key' | 'envelope';
type Step = {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
function fixture(role: Role = 'public-key') {
  const repo = {
    id: 1006944000,
    full_name: 'Dayopt/dayopt',
    owner: { id: 254866353, login: 'Dayopt' },
  };
  const run = {
    id: runId,
    run_attempt: attempt,
    status: 'in_progress',
    conclusion: null,
    event: 'workflow_dispatch',
    head_branch: 'integration',
    head_sha: sha,
    path: '.github/workflows/ci.yml@refs/heads/integration',
    repository: structuredClone(repo),
    head_repository: structuredClone(repo),
    created_at: iso(0),
    run_started_at: iso(5),
    updated_at: iso(20),
  };
  const step = (name: string, number: number, start: number, end: number): Step => ({
    name,
    number,
    status: 'completed',
    conclusion: 'success',
    started_at: iso(start),
    completed_at: iso(end),
  });
  const queued = (name: string, number: number): Step => ({
    name,
    number,
    status: 'queued',
    conclusion: null,
    started_at: null,
    completed_at: null,
  });
  const trust = {
    id: 10,
    run_id: runId,
    head_sha: sha,
    name: contract.trustJob,
    status: 'completed',
    conclusion: 'success',
    started_at: iso(10),
    completed_at: iso(30),
    steps: [] as Step[],
  };
  const consumer = {
    id: 11,
    run_id: runId,
    head_sha: sha,
    name: contract.consumerJob,
    status: 'in_progress',
    conclusion: null,
    started_at: iso(40),
    completed_at: null,
    steps: [
      step(contract.publicKeyUploadStep, 4, 60, 70),
      queued(contract.candidateCheckout, 8),
      queued(contract.candidateStep, 10),
    ],
  };
  const provision = {
    id: 12,
    run_id: runId,
    head_sha: sha,
    name: contract.provisionJob,
    status: 'in_progress',
    conclusion: null,
    started_at: iso(40),
    completed_at: null,
    steps: [step(contract.envelopeUploadStep, 8, 100, 110)],
  };
  const artifact = {
    id: 991,
    name: previewFixtureHandoffArtifactName(input, role),
    size_in_bytes: 8192,
    expired: false,
    digest: `sha256:${'c'.repeat(64)}`,
    created_at: iso(role === 'public-key' ? 65.5 : 105.5),
    expires_at: iso(86_400),
    workflow_run: {
      id: runId,
      repository_id: 1006944000,
      head_repository_id: 1006944000,
      head_branch: 'integration',
      head_sha: sha,
    },
  };
  return {
    run,
    attempt: structuredClone(run),
    jobs: { total_count: 3, jobs: [trust, consumer, provision] },
    artifacts: { total_count: 1, artifacts: [artifact] },
    environment: {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    policies: { total_count: 1, branch_policies: [{ name: 'integration', type: 'branch' }] },
  };
}
type World = ReturnType<typeof fixture>;
function provider(
  world: World,
  options: {
    finalRun?: Data;
    finalJobs?: Data;
    failurePath?: string;
    failureResponse?: () => Response;
  } = {},
) {
  let runReads = 0;
  let jobReads = 0;
  return vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(
      typeof target === 'string' ? target : target instanceof URL ? target.href : target.url,
    );
    expect(url.origin).toBe('https://api.github.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    if (options.failurePath && url.pathname.endsWith(options.failurePath))
      return options.failureResponse!();
    const prefix = '/repos/Dayopt/dayopt';
    if (url.pathname === `${prefix}/environments/Preview%20%E2%80%93%20product`)
      return Response.json(world.environment);
    if (url.pathname.endsWith('/deployment-branch-policies')) return Response.json(world.policies);
    if (url.pathname === `${prefix}/actions/runs/${runId}`) {
      runReads++;
      return Response.json(runReads === 2 ? (options.finalRun ?? world.run) : world.run);
    }
    if (url.pathname === `${prefix}/actions/runs/${runId}/attempts/${attempt}`)
      return Response.json(world.attempt);
    if (url.pathname === `${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs`) {
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('page')).toBe('1');
      jobReads++;
      return Response.json(jobReads === 2 ? (options.finalJobs ?? world.jobs) : world.jobs);
    }
    if (url.pathname === `${prefix}/actions/runs/${runId}/artifacts`)
      return Response.json(world.artifacts);
    throw new Error('PRIVATE unexpected API body');
  });
}
const invalid = /^Preview fixture handoff trust is invalid$/;
async function verify(world = fixture(), role: Role = 'public-key', options = {}) {
  const fetchImpl = provider(world, options);
  return verifyPreviewFixtureHandoffTrust({ input, role, token, fetchImpl });
}

describe('read-only same-attempt fixture artifact trust before any candidate code', () => {
  it.each(['public-key', 'envelope'] as const)(
    'accepts exact %s binding and returns public identity only',
    async (role) => {
      const world = fixture(role);
      const fetchImpl = provider(world);
      const result = await verifyPreviewFixtureHandoffTrust({ input, role, token, fetchImpl });
      expect(result).toEqual({
        artifactId: 991,
        digest: world.artifacts.artifacts[0].digest,
        name: world.artifacts.artifacts[0].name,
      });
      expect(Object.keys(result).sort()).toEqual(['artifactId', 'digest', 'name']);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(fetchImpl).toHaveBeenCalledTimes(8);
    },
  );
  it('derives names from canonical authority, role, run and attempt', () => {
    expect(previewFixtureHandoffArtifactName(input, 'public-key')).toMatch(
      /^preview-fixture-public-key-81726354-2-[a-f0-9]{64}$/,
    );
    expect(previewFixtureHandoffArtifactName(input, 'envelope')).not.toBe(
      previewFixtureHandoffArtifactName(input, 'public-key'),
    );
    const reordered = structuredClone(input);
    reordered.intent.userIds = {
      mobile: input.intent.userIds.mobile,
      desktop: input.intent.userIds.desktop,
    };
    expect(previewFixtureHandoffArtifactName(reordered, 'public-key')).toBe(
      previewFixtureHandoffArtifactName(input, 'public-key'),
    );
  });
  it('rejects unknown role, extra options, wrong operation, and absent token before network', async () => {
    const fetchImpl = provider(fixture());
    for (const options of [
      null,
      {},
      { input, role: 'PRIVATE', token, fetchImpl },
      { input, role: 'public-key', token: '', fetchImpl },
      { input, role: 'public-key', token, fetchImpl, extra: 'PRIVATE' },
      { input: { ...input, operation: 'cleanup' }, role: 'public-key', token, fetchImpl },
    ])
      await expect(verifyPreviewFixtureHandoffTrust(options)).rejects.toThrow(invalid);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => previewFixtureHandoffArtifactName(input, 'unknown')).toThrow(invalid);
  });
  it.each([
    ['run_attempt', 3],
    ['id', 77],
    ['head_sha', 'a'.repeat(40)],
    ['head_branch', 'main'],
    ['event', 'pull_request'],
    ['path', '.github/workflows/evil.yml'],
    ['status', 'completed'],
    ['conclusion', 'failure'],
    ['created_at', 'PRIVATE'],
    ['run_started_at', iso(-1)],
  ])('rejects mismatched latest run %s', async (field, value) => {
    const world = fixture();
    Object.assign(world.run, { [field]: value });
    await expect(verify(world)).rejects.toThrow(invalid);
  });
  it.each(['repository', 'head_repository'] as const)(
    'requires immutable repository and owner IDs in %s',
    async (field) => {
      for (const mutation of [
        { id: 7 },
        { full_name: 'foreign/dayopt' },
        { owner: { id: 7, login: 'Dayopt' } },
        { owner: { id: 254866353, login: 'foreign' } },
      ]) {
        const world = fixture();
        Object.assign(world.run[field], mutation);
        await expect(verify(world)).rejects.toThrow(invalid);
      }
    },
  );
  it.each(['run_attempt', 'head_sha', 'status', 'path'] as const)(
    'rejects mismatched exact attempt %s',
    async (field) => {
      const world = fixture();
      Object.assign(world.attempt, { [field]: field === 'run_attempt' ? 1 : 'wrong' });
      await expect(verify(world)).rejects.toThrow(invalid);
    },
  );
  it('requires branch-specific Integration environment policy', async () => {
    const world = fixture();
    world.policies.branch_policies[0].name = '*';
    await expect(verify(world)).rejects.toThrow(invalid);
  });
  it.each(['trust', 'consumer', 'provision'] as const)(
    'rejects missing or duplicate %s jobs',
    async (selected) => {
      const index = { trust: 0, consumer: 1, provision: 2 }[selected];
      for (const duplicate of [false, true]) {
        const world = fixture();
        const chosen = world.jobs.jobs[index];
        world.jobs.jobs = world.jobs.jobs.filter((_, i) => i !== index);
        if (duplicate) world.jobs.jobs.push(chosen, structuredClone(chosen));
        world.jobs.total_count = world.jobs.jobs.length;
        await expect(verify(world)).rejects.toThrow(invalid);
      }
    },
  );
  it('rejects failed trust, wrong job run/head, or duplicate job IDs', async () => {
    for (const mutation of [
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { run_id: 7 },
      { head_sha: 'a'.repeat(40) },
      { completed_at: iso(9) },
    ]) {
      const world = fixture();
      Object.assign(world.jobs.jobs[0], mutation);
      await expect(verify(world)).rejects.toThrow(invalid);
    }
    const world = fixture();
    world.jobs.jobs[1].id = world.jobs.jobs[0].id;
    await expect(verify(world)).rejects.toThrow(invalid);
  });
  it.each(['public-key', 'envelope'] as const)(
    'rejects missing, duplicate, unfinished or failed upload for %s',
    async (role) => {
      const index = role === 'public-key' ? 1 : 2;
      for (const mode of ['missing', 'duplicate', 'in_progress', 'failure', 'bad-time']) {
        const world = fixture(role);
        const producer = world.jobs.jobs[index];
        const chosen = producer.steps[0];
        if (mode === 'missing') producer.steps.shift();
        if (mode === 'duplicate') producer.steps.push(structuredClone(chosen));
        if (mode === 'in_progress') chosen.status = 'in_progress';
        if (mode === 'failure') chosen.conclusion = 'failure';
        if (mode === 'bad-time') chosen.completed_at = iso(39);
        await expect(verify(world, role)).rejects.toThrow(invalid);
      }
    },
  );
  it.each([contract.candidateCheckout, contract.candidateStep])(
    'requires unique unstarted %s for both roles',
    async (name) => {
      for (const role of ['public-key', 'envelope'] as const)
        for (const mode of [
          'missing',
          'duplicate',
          'started',
          'finished',
          'timestamp',
          'unknown',
        ]) {
          const world = fixture(role);
          const consumer = world.jobs.jobs[1];
          const selected = consumer.steps.find((step) => step.name === name)!;
          if (mode === 'missing')
            consumer.steps = consumer.steps.filter((step) => step !== selected);
          if (mode === 'duplicate') consumer.steps.push(structuredClone(selected));
          if (mode === 'started')
            Object.assign(selected, { status: 'in_progress', started_at: iso(120) });
          if (mode === 'finished')
            Object.assign(selected, {
              status: 'completed',
              conclusion: 'success',
              started_at: iso(120),
              completed_at: iso(130),
            });
          if (mode === 'timestamp') selected.started_at = iso(120);
          if (mode === 'unknown') selected.status = 'unknown';
          await expect(verify(world, role)).rejects.toThrow(invalid);
        }
    },
  );
  it('rejects candidate checkout ordered before key publication and envelope upload before key publication', async () => {
    const world = fixture();
    world.jobs.jobs[1].steps[1].number = 3;
    await expect(verify(world)).rejects.toThrow(invalid);
    const encrypted = fixture('envelope');
    encrypted.jobs.jobs[2].steps[0].started_at = iso(69);
    await expect(verify(encrypted, 'envelope')).rejects.toThrow(invalid);
  });
  it('accepts a completed successful provision job for envelope, but rejects a terminal consumer', async () => {
    const world = fixture('envelope');
    Object.assign(world.jobs.jobs[2], {
      status: 'completed',
      conclusion: 'success',
      completed_at: iso(115),
    });
    await expect(verify(world, 'envelope')).resolves.toHaveProperty('artifactId', 991);
    Object.assign(world.jobs.jobs[1], {
      status: 'completed',
      conclusion: 'success',
      completed_at: iso(150),
    });
    await expect(verify(world, 'envelope')).rejects.toThrow(invalid);
  });
  it.each([
    'missing',
    'duplicate',
    'old-attempt',
    'foreign-binding',
    'expired',
    'expired-time',
    'size',
    'digest',
    'metadata',
    'time',
  ])('rejects %s artifact', async (mode) => {
    const world = fixture();
    const artifact = world.artifacts.artifacts[0];
    if (mode === 'missing') world.artifacts.artifacts = [];
    if (mode === 'duplicate') world.artifacts.artifacts.push(structuredClone(artifact));
    if (mode === 'old-attempt')
      artifact.name = artifact.name.replace('-81726354-2-', '-81726354-1-');
    if (mode === 'foreign-binding')
      artifact.name = previewFixtureHandoffArtifactName(
        { ...input, origin: 'https://product-other123-dayopt.vercel.app' },
        'public-key',
      );
    if (mode === 'expired') artifact.expired = true;
    if (mode === 'expired-time') artifact.expires_at = iso(100);
    if (mode === 'size') artifact.size_in_bytes = 131_073;
    if (mode === 'digest') artifact.digest = 'PRIVATE_PROVIDER_BODY';
    if (mode === 'metadata') artifact.workflow_run.head_sha = 'a'.repeat(40);
    if (mode === 'time') artifact.created_at = iso(55);
    world.artifacts.total_count = world.artifacts.artifacts.length;
    await expect(verify(world)).rejects.toThrow(invalid);
  });
  it.each(['jobs', 'artifacts'] as const)('rejects incomplete/paginated %s lists', async (key) => {
    const world = fixture();
    world[key].total_count = 101;
    await expect(verify(world)).rejects.toThrow(invalid);
    await expect(
      verify(fixture(), 'public-key', {
        failurePath: `/${key}`,
        failureResponse: () =>
          Response.json(fixture()[key], {
            headers: { link: '<https://PRIVATE.example>; rel="next"' },
          }),
      }),
    ).rejects.toThrow(invalid);
  });
  it('rejects a candidate starting during verification on the final jobs read', async () => {
    for (const name of [contract.candidateCheckout, contract.candidateStep]) {
      const world = fixture();
      const finalJobs = structuredClone(world.jobs);
      Object.assign(
        finalJobs.jobs[1].steps.find((step) => step.name === name)!,
        { status: 'in_progress', started_at: iso(120) },
      );
      await expect(verify(world, 'public-key', { finalJobs })).rejects.toThrow(invalid);
    }
  });
  it.each([
    { run_attempt: 3 },
    { head_sha: 'a'.repeat(40) },
    { status: 'completed' },
    { head_branch: 'main' },
  ])('rejects a changed run at the final read %j', async (change) => {
    const world = fixture();
    await expect(
      verify(world, 'public-key', { finalRun: { ...world.run, ...change } }),
    ).rejects.toThrow(invalid);
  });
  it('allows ordinary updated_at progress without relaxing attempt/SHA/status binding', async () => {
    const world = fixture();
    await expect(
      verify(world, 'public-key', { finalRun: { ...world.run, updated_at: iso(200) } }),
    ).resolves.toHaveProperty('artifactId', 991);
  });
  it('accepts offset timestamps and same-second artifact publication while preserving order', async () => {
    const world = fixture();
    world.jobs.jobs[1].steps[0].completed_at = iso(70).replace('Z', '+00:00');
    world.artifacts.artifacts[0].created_at = iso(70.9);
    await expect(verify(world)).resolves.toHaveProperty('artifactId', 991);
  });
  it.each([
    () => new Response('PRIVATE_PROVIDER_BODY', { status: 403 }),
    () => new Response('PRIVATE malformed JSON'),
    () => new Response('x'.repeat(1_048_577)),
    () => Response.json({ total_count: 1, artifacts: [null] }),
  ])('bounds/rejects provider bodies without including their values', async (failureResponse) => {
    await expect(
      verify(fixture(), 'public-key', { failurePath: '/artifacts', failureResponse }),
    ).rejects.toThrow(invalid);
  });
  it('converts thrown provider/authorization errors into a fixed error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`PRIVATE ${token}`);
    });
    await expect(
      verifyPreviewFixtureHandoffTrust({ input, role: 'public-key', token, fetchImpl }),
    ).rejects.toThrow(invalid);
  });
});
