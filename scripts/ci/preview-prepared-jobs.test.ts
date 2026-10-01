import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encryptPreviewFixtureEnvelope,
  generatePreviewFixtureKeyPair,
} from '../lib/preview-fixture-envelope.mjs';
import {
  observePreparedRuntime,
  preparedReadinessSnapshot,
  remainingPreparedBudget,
} from '../lib/preview-prepared-readiness.mjs';
import {
  assertPreparedConsumerEnvironment,
  preparedGitEnvironment,
  preparedJobContext,
  provisionPreparedFixtures,
  recordPreparedOutcome,
  removeOwnedPreparedLogin,
  requirePreparedQuarantineStore,
  runPreparedProcess,
  waitPreparedHandoff,
} from './preview-prepared-jobs.mjs';
const input = {
  operation: 'provision',
  origin: 'https://product-example123-dayopt.vercel.app',
  execution: { runId: 36508374884, attempt: 1, workflowSha: 'b'.repeat(40) },
  intent: {
    schemaVersion: 1,
    repository: 'Dayopt/dayopt',
    workflow: '.github/workflows/ci.yml',
    workflowRef: 'refs/heads/integration',
    workflowSha: 'b'.repeat(40),
    sourceRunId: 36508374884,
    sourceAttempt: 1,
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-29T00:00:00.000Z',
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
const now = Date.now();
const env = {
  PATH: process.env.PATH!,
  HOME: process.env.HOME!,
  GITHUB_REPOSITORY: 'Dayopt/dayopt',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/integration',
  GITHUB_WORKFLOW_REF: 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration',
  GITHUB_SHA: input.execution.workflowSha,
  GITHUB_RUN_ID: String(input.execution.runId),
  GITHUB_RUN_ATTEMPT: String(input.execution.attempt),
  GITHUB_TOKEN: 'synthetic-read-token',
  SUPABASE_PREVIEW_READINESS_TOKEN: 'synthetic-provider-read-token',
};
const context = { input, expectedMigrations: ['20260930020816'] };
const ready = {
  status: 'ready',
  ...input.intent.request,
  origin: input.origin,
  migrationVersions: context.expectedMigrations,
  startedAt: new Date(now).toISOString(),
  observedAt: new Date(now).toISOString(),
};
const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'prepared-jobs-'));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('prepared job binding and admission', () => {
  it('binds the trusted workflow, attempt and exact public migration set', () => {
    expect(preparedJobContext(context, env)).toEqual(context);
  });
  it.each([
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_REF',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_EVENT_NAME',
  ])('rejects changed %s', (key) => {
    expect(() => preparedJobContext(context, { ...env, [key]: 'wrong' })).toThrow();
  });
  it('requires a real configured quarantine store; no boolean or environment opt-in', () => {
    expect(() => requirePreparedQuarantineStore()).toThrow(/not configured/);
  });
  it('real CLI stops before requesting credentials or touching provider state', () => {
    const root = temp();
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve('scripts/ci/preview-prepared-jobs.mjs'), 'provision'],
        {
          env: {
            ...env,
            RUNNER_TEMP: root,
            GITHUB_WORKSPACE: process.cwd(),
            PREVIEW_PREPARED_CONTEXT: JSON.stringify(context),
          },
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 5000,
        },
      ),
    ).toThrow();
    expect(existsSync(join(root, 'prepared-envelope'))).toBe(false);
  });
  it.each([
    'SUPABASE_PREVIEW_READINESS_TOKEN',
    'SUPABASE_SECRET_KEY',
    'VERCEL_TOKEN',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NODE_OPTIONS',
    'GH_TOKEN',
  ])('rejects %s on consumer', (key) => {
    expect(() => assertPreparedConsumerEnvironment({ [key]: 'synthetic' })).toThrow();
  });
});

describe('readiness is a bounded trusted snapshot, not provider credentials', () => {
  it('reconstructs public fields and never reflects extras', () => {
    expect(preparedReadinessSnapshot(input, { ...ready, providerSecret: 'PRIVATE' }, now)).toEqual(
      ready,
    );
  });
  it.each([
    { sha: 'c'.repeat(40) },
    { supabaseProjectRef: 'z'.repeat(20) },
    { origin: 'https://other.invalid' },
    { observedAt: new Date(now + 1).toISOString() },
    { startedAt: new Date(now - 600001).toISOString() },
    { migrationVersions: ['invalid'] },
    { migrationVersions: ['20260930020816', '20260930020816'] },
  ])('rejects changed binding or stale schema evidence', (change) => {
    expect(() => preparedReadinessSnapshot(input, { ...ready, ...change }, now)).toThrow();
  });
  it('uses only the pinned runtime endpoints and short-lived token, and labels provider post as unconfirmed', async () => {
    const fetchImpl = vi.fn(async (url) =>
      Response.json(
        String(url).endsWith('/version')
          ? {
              preview: {
                sha: ready.sha,
                deploymentId: ready.deploymentId,
                supabaseProjectRef: ready.supabaseProjectRef,
              },
            }
          : { status: 'healthy', environment: 'preview', checks: { database: 'ok' } },
      ),
    );
    const result = await observePreparedRuntime({
      input,
      snapshot: ready,
      token: 'synthetic-access',
      deadline: now + 120000,
      expectedMigrations: context.expectedMigrations,
      fetchImpl,
      now: () => now,
    });
    expect(result.providerPostConfirmed).toBe(false);
    expect(result.observedAt).toBe(ready.observedAt);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(url.startsWith(input.origin + '/api/health')).toBe(true);
      expect(options.redirect).toBe('error');
      expect(options.headers).toEqual({ 'x-vercel-trusted-oidc-idp-token': 'synthetic-access' });
    }
  });
  it('does not contact runtime after expiration or for a different migration set', async () => {
    const fetchImpl = vi.fn();
    await expect(
      observePreparedRuntime({
        input,
        snapshot: ready,
        token: 'synthetic-access',
        deadline: now,
        expectedMigrations: context.expectedMigrations,
        fetchImpl,
        now: () => now,
      }),
    ).rejects.toThrow();
    await expect(
      observePreparedRuntime({
        input,
        snapshot: ready,
        token: 'synthetic-access',
        deadline: now + 120000,
        expectedMigrations: ['20260930020817'],
        fetchImpl,
        now: () => now,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds execution by expiry with cleanup reserve and never extends the seven minute runner limit', () => {
    expect(remainingPreparedBudget(now + 120000, now)).toBe(90000);
    expect(remainingPreparedBudget(now + 600000, now)).toBe(420000);
    expect(() => remainingPreparedBudget(now + 30000, now)).toThrow();
    expect(() => remainingPreparedBudget(now + 600001, now)).toThrow();
  });
});

describe('trusted provision transfer without candidate code', () => {
  const pair = generatePreviewFixtureKeyPair();
  function setup() {
    const events: string[] = [];
    const envelope = encryptPreviewFixtureEnvelope({
      input,
      publicKey: pair.publicKey,
      payload: { synthetic: true },
    });
    const receive = vi.fn(async () => {
      events.push('receive-public-key');
      return pair.publicKey;
    });
    const access = vi.fn(async () => {
      events.push('access');
      return 'synthetic-access';
    });
    const authenticate = vi.fn(async () => {
      events.push('broker-token');
      return 'synthetic-broker';
    });
    const observe = vi.fn(async () => {
      events.push('provider-pre');
      return { ...ready, providerEvidence: {} };
    });
    const fetchImpl = vi.fn(async () => {
      events.push('post');
      return Response.json(envelope);
    });
    const quarantine = vi.fn(async () => {
      events.push('quarantine');
    }); // Test-only adapter, not persistence evidence.
    return {
      context,
      env,
      receive,
      access,
      authenticate,
      observe,
      fetchImpl,
      quarantine,
      events,
      envelope,
    };
  }
  it('checks quarantine, authenticated key, pre-readiness, then sends both distinct tokens to the exact origin', async () => {
    const s = setup();
    expect(await provisionPreparedFixtures(s)).toEqual(s.envelope);
    expect(s.events).toEqual([
      'quarantine',
      'receive-public-key',
      'access',
      'provider-pre',
      'broker-token',
      'post',
    ]);
    const [url, options] = s.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(input.origin + '/api/preview-fixtures');
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({
      authorization: 'Bearer synthetic-broker',
      'x-vercel-trusted-oidc-idp-token': 'synthetic-access',
    });
    const body = JSON.parse(String(options.body));
    expect(body.previewAccessToken).toBe('synthetic-access');
    expect(body.readiness).toEqual(ready);
    expect(String(options.body)).not.toContain(env.SUPABASE_PREVIEW_READINESS_TOKEN);
  });
  it('default missing quarantine adapter stops before OIDC, provider reads, or provision', async () => {
    const s = setup();
    await expect(provisionPreparedFixtures({ ...s, quarantine: undefined })).rejects.toThrow(
      /not configured/,
    );
    expect(s.events).toEqual([]);
  });
  it('does not POST when pre-readiness differs', async () => {
    const s = setup();
    s.observe.mockResolvedValue({ ...ready, providerEvidence: {}, sha: 'c'.repeat(40) });
    await expect(provisionPreparedFixtures(s)).rejects.toThrow();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([403, 404, 503])(
    'never treats HTTP %s as a successful encrypted transfer',
    async (status) => {
      const s = setup();
      s.fetchImpl.mockResolvedValue(new Response('PRIVATE_PROVIDER_BODY', { status }));
      await expect(provisionPreparedFixtures(s)).rejects.toThrow();
    },
  );
  it('never publishes plaintext fields returned instead of an envelope', async () => {
    const s = setup();
    s.fetchImpl.mockResolvedValue(Response.json({ credentials: 'PRIVATE' }));
    await expect(provisionPreparedFixtures(s)).rejects.toThrow();
  });
  it('waits only for authenticated handoff and stops after bounded failures', async () => {
    const receive = vi.fn().mockRejectedValue(new Error('PRIVATE'));
    const pause = vi.fn(async () => {});
    await expect(
      waitPreparedHandoff(receive, { now: () => now, pause, attempts: 2 }),
    ).rejects.toThrow(/^Prepared Preview authenticated handoff unavailable$/);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

describe('independent post observation cannot claim cleanup or durable quarantine', () => {
  it.each([true, false])(
    'records UNKNOWN when provider observation success=%s',
    async (success) => {
      const directory = join(temp(), 'outcome');
      const access = vi.fn(async () => 'synthetic-access');
      const observe = success
        ? vi.fn(async () => ({ ...ready, providerEvidence: {} }))
        : vi.fn(async () => {
            throw new Error('PRIVATE');
          });
      const result = await recordPreparedOutcome({ context, env, directory, access, observe });
      expect(result).toMatchObject({
        status: 'unknown',
        cleanupConfirmed: false,
        reusable: false,
        quarantinePersisted: false,
        providerPostConfirmed: success,
      });
      expect(readFileSync(join(directory, 'recovery.json'), 'utf8')).not.toMatch(
        /PRIVATE|synthetic/,
      );
    },
  );
});

describe('worker interruption and owned private cleanup', () => {
  it('does not inherit arbitrary credentials into the candidate process', async () => {
    const code = await runPreparedProcess(
      process.execPath,
      ['-e', 'process.exit(process.env.TEST_PRIVATE || process.env.GITHUB_TOKEN ? 9 : 0)'],
      { cwd: process.cwd(), env: { ...env, TEST_PRIVATE: 'synthetic' }, timeoutMs: 5000 },
    );
    expect(code).toBe(0);
  });
  it('terminates a hung process group within its bounded deadline', async () => {
    const started = Date.now();
    expect(
      await runPreparedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: process.cwd(),
        env,
        timeoutMs: 25,
      }),
    ).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it.each(['owned', 'foreign', 'symlink'])('removes only the current run registry: %s', (kind) => {
    const root = temp();
    const directory = mkdtempSync(join(root, 'preview-login-'));
    const path = join(directory, 'registry.json');
    const row = {
      runId: input.intent.runId,
      origin: input.origin,
      supabaseProjectRef: input.intent.request.supabaseProjectRef,
      users: Object.fromEntries(
        Object.entries(input.intent.userIds).map(([slot, userId]) => [slot, { userId }]),
      ),
    };
    if (kind === 'foreign') row.runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    if (kind === 'symlink') {
      const target = join(root, 'foreign');
      writeFileSync(target, JSON.stringify(row), { mode: 0o600 });
      symlinkSync(target, path);
    } else writeFileSync(path, JSON.stringify(row), { mode: 0o600 });
    const remove = () => removeOwnedPreparedLogin({ session: { directory, path }, root, input });
    if (kind === 'owned') {
      remove();
      expect(existsSync(directory)).toBe(false);
    } else {
      expect(remove).toThrow();
      expect(existsSync(path)).toBe(true);
    }
  });
});

it('authenticates private repository metadata/checkout only through a transient Git env, not argv or persisted config', () => {
  const selected = preparedGitEnvironment({ ...env, SUPABASE_SECRET_KEY: 'PRIVATE' });
  expect(selected.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader');
  expect(selected.GIT_CONFIG_VALUE_1).toBe(
    'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + env.GITHUB_TOKEN).toString('base64'),
  );
  expect(selected.GIT_CONFIG_VALUE_0).toBe('false');
  expect(selected.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  expect(selected).not.toHaveProperty('SUPABASE_SECRET_KEY');
  expect(selected).not.toHaveProperty('GITHUB_TOKEN');
});
