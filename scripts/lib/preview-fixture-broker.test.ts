import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { prepareFixtureAuthority } from './preview-fixture-authority.mjs';
import { executeDurableFixtureBroker, executeFixtureBroker } from './preview-fixture-broker.mjs';

// Exercise the installed SDK's real Auth and PostgREST request/response contract.
const { createClient } = createRequire(new URL('../../apps/product/package.json', import.meta.url))(
  '@supabase/supabase-js',
);
const now = 1_800_000_000;
const seed = '00000000-0000-0000-0000-000000000001';
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
const env = {
  VERCEL_ENV: 'preview',
  VERCEL_PROJECT_ID: 'prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa',
  VERCEL_URL: 'product-example123-dayopt.vercel.app',
  VERCEL_DEPLOYMENT_ID: 'dpl_example123',
  VERCEL_GIT_REPO_OWNER: 'Dayopt',
  VERCEL_GIT_REPO_SLUG: 'dayopt',
  VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  VERCEL_GIT_COMMIT_REF: 'codex/example',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic-test-key-not-real',
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  use: 'sig',
  kid: 'broker-test',
};
function token(selected = input) {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: prepareFixtureAuthority(selected).audience,
    sub: 'repo:Dayopt/dayopt:environment:Preview – product',
    repository: 'Dayopt/dayopt',
    repository_id: '1006944000',
    repository_owner: 'Dayopt',
    repository_owner_id: '254866353',
    environment: 'Preview – product',
    ref: 'refs/heads/integration',
    ref_type: 'branch',
    workflow_ref: 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration',
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    sha: selected.execution.workflowSha,
    workflow_sha: selected.execution.workflowSha,
    run_id: String(selected.execution.runId),
    run_attempt: String(selected.execution.attempt),
    iat: now,
    nbf: now - 600,
    exp: now + 300,
  };
  const body = [{ alg: 'RS256', typ: 'JWT', kid: 'broker-test' }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

type Row = Record<string, unknown> & { app_metadata?: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Contract harness only. It models the required adapter across independent
// executor calls; it is NOT the production distributed/persistent adapter.
function lifecycleHarness() {
  const runs = new Map<string, { tail: Promise<void>; digest: string; closed: boolean }>();
  return async (
    binding: { key: string; intentDigest: string; operation: string },
    execute: (scope: { beforeMutation: () => Promise<void> }) => Promise<unknown>,
  ) => {
    let state = runs.get(binding.key);
    if (!state) {
      state = { tail: Promise.resolve(), digest: binding.intentDigest, closed: false };
      runs.set(binding.key, state);
    }
    if (state.digest !== binding.intentDigest) throw new Error('Different intent');
    const previous = state.tail;
    const done = deferred();
    state.tail = previous.then(() => done.promise);
    await previous;
    try {
      if (binding.operation === 'provision') {
        if (state.closed) throw new Error('Run is closed');
      } else state.closed = true;
      return await execute({ beforeMutation: async () => {} });
    } finally {
      done.resolve();
    }
  };
}

function provider() {
  const withLifecycle = lifecycleHarness();
  const users = new Map<string, Row>([
    [seed, { id: seed, email: 'baseline@example.com', app_metadata: {} }],
  ]);
  const tables = new Map<string, Map<string, Row>>(
    ['profiles', 'user_settings', 'categories', 'activities', 'plans', 'records'].map((name) => [
      name,
      new Map(),
    ]),
  );
  const writes: { path: string; method: string; body: Row }[] = [];
  const failures = {
    lifecycleAction: '',
    createResponseLost: false,
    createErrorResponse: false,
    table: '',
    deleteId: '',
    skipCascade: '',
    readyUpdate: false,
    pauseCreate: null as Promise<void> | null,
    signalCreate: () => {},
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn<typeof fetch>(async (target, init = {}) => {
    const url = new URL(
      typeof target === 'string' ? target : target instanceof URL ? target.href : target.url,
    );
    if (url.origin === 'https://token.actions.githubusercontent.com') return json({ keys: [jwk] });
    if (url.origin !== env.NEXT_PUBLIC_SUPABASE_URL) throw new Error('Unexpected request target');
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    expect(headers.get('apikey')).toBe(env.SUPABASE_SECRET_KEY);
    expect(init.redirect).toBe('error');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (!['GET', 'HEAD'].includes(method)) writes.push({ path: url.pathname, method, body });
    if (url.pathname === '/rest/v1/rpc/preview_fixture_lifecycle_v1') {
      if (body.p_action === failures.lifecycleAction) return json({ status: 'unknown' });
      return json({
        status:
          body.p_action === 'claim'
            ? 'acquired'
            : body.p_action === 'guard'
              ? 'owned'
              : body.p_success
                ? 'finished'
                : 'unknown',
      });
    }
    if (url.pathname.startsWith('/auth/v1/admin/users')) {
      const id = url.pathname.split('/')[5];
      if (method === 'POST') {
        if (failures.pauseCreate) {
          const pending = failures.pauseCreate;
          failures.pauseCreate = null;
          failures.signalCreate();
          await pending;
        }
        if (users.has(body.id)) return json({ msg: 'duplicate' }, 422);
        users.set(body.id, { ...body, password: undefined });
        if (failures.createErrorResponse) return json({ msg: 'PRIVATE uncertain create' }, 500);
        if (failures.createResponseLost) {
          failures.createResponseLost = false;
          throw new Error('Lost response');
        }
        return json(users.get(body.id));
      }
      if (method === 'PUT') {
        if (failures.readyUpdate) return json({ msg: 'PRIVATE provider failure' }, 500);
        users.set(id, { ...users.get(id), ...body });
        return json(users.get(id));
      }
      if (method === 'DELETE') {
        if (id === failures.deleteId) return json({ msg: 'PRIVATE provider failure' }, 500);
        users.delete(id);
        for (const [name, rows] of tables)
          if (name !== failures.skipCascade) {
            for (const [key, row] of rows)
              if ((name === 'profiles' ? row.id : row.user_id) === id) rows.delete(key);
          }
        return json({});
      }
      return users.has(id)
        ? json(users.get(id))
        : json({ code: 'user_not_found', msg: 'not found' }, 404);
    }
    const name = url.pathname.split('/')[3];
    const table = tables.get(name);
    if (!table || failures.table === name) return json({ message: 'PRIVATE table failure' }, 500);
    if (method === 'POST') {
      const key = name === 'user_settings' ? body.user_id : body.id;
      if (!headers.get('prefer')?.includes('ignore-duplicates') || !table.has(key))
        table.set(key, { ...table.get(key), ...body });
      return new Response(null, { status: 201 });
    }
    const matches = [...table.values()].filter((row) =>
      [...url.searchParams].every(
        ([key, value]) => !value.startsWith('eq.') || row[key] === value.slice(3),
      ),
    );
    if (method === 'HEAD')
      return new Response(null, {
        status: 200,
        headers: { 'content-range': `*/${matches.length}` },
      });
    return headers.get('accept')?.includes('vnd.pgrst.object')
      ? matches.length === 1
        ? json(matches[0])
        : json({ code: 'PGRST116' }, 406)
      : json(matches);
  });
  async function run(selected = input, overrides: Record<string, unknown> = {}) {
    return executeFixtureBroker({
      input: selected,
      token: token(selected),
      env,
      createClient,
      withLifecycle,
      fetchImpl,
      now: () => now,
      ...overrides,
    });
  }
  async function runDurable(selected = input, overrides: Record<string, unknown> = {}) {
    return executeDurableFixtureBroker({
      input: selected,
      token: token(selected),
      env,
      createClient,
      fetchImpl,
      now: () => now,
      ...overrides,
    });
  }
  return { users, tables, writes, failures, fetchImpl, run, runDurable };
}

describe('trusted durable broker composition with installed SDK and mocked providers', () => {
  it('claims, guards every fixture write and finishes through the SDK RPC bridge', async () => {
    const p = provider();
    expect(await p.runDurable()).toMatchObject({
      operation: 'provision',
      runId: input.intent.runId,
    });
    const rpcPath = '/rest/v1/rpc/preview_fixture_lifecycle_v1';
    expect(p.writes[0]).toMatchObject({ path: rpcPath, body: { p_action: 'claim' } });
    expect(p.writes.at(-1)).toMatchObject({
      path: rpcPath,
      body: { p_action: 'finish', p_success: true },
    });
    for (let i = 0; i < p.writes.length; i++) {
      if (p.writes[i].path !== rpcPath)
        expect(p.writes[i - 1]).toMatchObject({ path: rpcPath, body: { p_action: 'guard' } });
    }
    expect(await p.runDurable({ ...input, operation: 'cleanup' })).toMatchObject({
      status: 'passed',
    });
    expect(p.users.size).toBe(1);
  });
  it('rejects an invalid job token before reading the secret or claiming', async () => {
    const p = provider();
    const secret = vi.fn(() => env.SUPABASE_SECRET_KEY);
    const selectedEnv = { ...env };
    Object.defineProperty(selectedEnv, 'SUPABASE_SECRET_KEY', { get: secret });
    await expect(p.runDurable(input, { env: selectedEnv, token: 'invalid' })).rejects.toThrow(
      /^Preview fixture operation failed$/,
    );
    expect(secret).not.toHaveBeenCalled();
    expect(p.writes).toEqual([]);
  });
  it('does not create users when the durable claim returns UNKNOWN', async () => {
    const p = provider();
    p.failures.lifecycleAction = 'claim';
    await expect(p.runDurable()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.users.size).toBe(1);
    expect(p.writes.map((w) => w.path)).toEqual(['/rest/v1/rpc/preview_fixture_lifecycle_v1']);
  });
  it('finishes with failure after guard loss and sends no fixture writes', async () => {
    const p = provider();
    p.failures.lifecycleAction = 'guard';
    await expect(p.runDurable()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.users.size).toBe(1);
    expect(p.writes.map((w) => [w.body.p_action, w.body.p_success])).toEqual([
      ['claim', null],
      ['guard', null],
      ['finish', false],
    ]);
  });
});

describe('authenticated Preview fixture executor with installed Supabase SDK', () => {
  it('rechecks expiry after waiting for lifecycle ownership, before reading the key', async () => {
    const p = provider();
    const secret = vi.fn(() => env.SUPABASE_SECRET_KEY);
    const selectedEnv = { ...env };
    Object.defineProperty(selectedEnv, 'SUPABASE_SECRET_KEY', { get: secret });
    let clock = now;
    await expect(
      p.run(input, {
        env: selectedEnv,
        now: () => clock,
        withLifecycle: async (
          _binding: unknown,
          execute: (scope: { beforeMutation: () => Promise<void> }) => Promise<unknown>,
        ) => {
          clock += 301;
          return execute({ beforeMutation: async () => {} });
        },
      }),
    ).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(secret).not.toHaveBeenCalled();
    expect(p.writes).toEqual([]);
  });

  it('fails closed without the required lifecycle adapter before reading any admin key', async () => {
    const p = provider();
    const secret = vi.fn(() => env.SUPABASE_SECRET_KEY);
    const selectedEnv = { ...env };
    Object.defineProperty(selectedEnv, 'SUPABASE_SECRET_KEY', { get: secret });
    await expect(p.run(input, { env: selectedEnv, withLifecycle: undefined })).rejects.toThrow(
      /^Preview fixture operation failed$/,
    );
    expect(secret).not.toHaveBeenCalled();
    expect(p.writes).toEqual([]);
  });
  it('requires the per-mutation ownership guard before reading an admin key', async () => {
    const p = provider();
    const secret = vi.fn(() => env.SUPABASE_SECRET_KEY);
    const selectedEnv = { ...env };
    Object.defineProperty(selectedEnv, 'SUPABASE_SECRET_KEY', { get: secret });
    await expect(
      p.run(input, {
        env: selectedEnv,
        withLifecycle: async (_binding: unknown, execute: () => Promise<unknown>) => execute(),
      }),
    ).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(secret).not.toHaveBeenCalled();
  });
  it('awaits ownership checks before every provider mutation and stops after ownership loss', async () => {
    const p = provider();
    let checks = 0;
    await expect(
      p.run(input, {
        withLifecycle: async (
          _binding: unknown,
          execute: (scope: { beforeMutation: () => Promise<void> }) => Promise<unknown>,
        ) =>
          execute({
            beforeMutation: async () => {
              expect(p.writes).toHaveLength(checks);
              checks++;
              if (checks === 2) throw new Error('PRIVATE expired ownership');
            },
          }),
      }),
    ).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(checks).toBe(2);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0].path).toBe('/auth/v1/admin/users');
    expect(p.tables.get('profiles')?.size).toBe(0);
  });
  it('does not send a mutation if the time budget expired while checking ownership', async () => {
    const p = provider();
    let elapsed = 0;
    await expect(
      p.run(input, {
        elapsed: () => elapsed,
        withLifecycle: async (
          _binding: unknown,
          execute: (scope: { beforeMutation: () => Promise<void> }) => Promise<unknown>,
        ) =>
          execute({
            beforeMutation: async () => {
              elapsed = 120_001;
            },
          }),
      }),
    ).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.writes).toEqual([]);
  });
  it('does not send an awaiting cleanup write after a parallel ownership check failed', async () => {
    const p = provider();
    await p.run();
    const count = p.writes.length;
    const first = deferred();
    const failed = deferred();
    let checks = 0;
    const cleaning = p.run(
      { ...input, operation: 'cleanup' },
      {
        withLifecycle: async (
          _binding: unknown,
          execute: (scope: { beforeMutation: () => Promise<void> }) => Promise<unknown>,
        ) =>
          execute({
            beforeMutation: async () => {
              checks++;
              if (checks === 1) return first.promise;
              failed.resolve();
              throw new Error('Ownership lost');
            },
          }),
      },
    );
    const rejected = expect(cleaning).rejects.toThrow(/^Preview fixture operation failed$/);
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.resolve();
    await rejected;
    expect(p.writes).toHaveLength(count);
    expect(p.users.has(input.intent.userIds.desktop)).toBe(true);
    expect(p.users.has(input.intent.userIds.mobile)).toBe(true);
  });
  it('keeps a terminal run closed even when cleanup precedes the first provision', async () => {
    const p = provider();
    expect(await p.run({ ...input, operation: 'cleanup' })).toMatchObject({ status: 'passed' });
    await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.writes).toEqual([]);
  });
  it('does not finish cleanup before an in-flight provision, or recreate users afterward', async () => {
    const p = provider();
    const entered = deferred();
    const resume = deferred();
    p.failures.pauseCreate = resume.promise;
    p.failures.signalCreate = entered.resolve;
    const creating = p.run();
    await entered.promise;
    let settled = false;
    const cleaning = p.run({ ...input, operation: 'cleanup' }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedWhileCreating = settled;
    resume.resolve();
    await Promise.all([creating, cleaning]);
    expect(finishedWhileCreating).toBe(false);
    expect(p.users.has(input.intent.userIds.desktop)).toBe(false);
    expect(p.users.has(input.intent.userIds.mobile)).toBe(false);
    await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
  });
  it('provisions exactly two planned users and reuses identical credentials without reseeding', async () => {
    const p = provider();
    const baseline = structuredClone(p.users.get(seed));
    const first = await p.run();
    expect(first.operation).toBe('provision');
    expect(first.users?.desktop.userId).toBe(input.intent.userIds.desktop);
    expect(first.users?.mobile.userId).toBe(input.intent.userIds.mobile);
    expect(first.users?.desktop.password).not.toBe(first.users?.mobile.password);
    expect(JSON.stringify(first)).not.toContain(env.SUPABASE_SECRET_KEY);
    expect(p.users.size).toBe(3);
    expect(p.tables.get('categories')?.size).toBe(2);
    expect(p.tables.get('activities')?.size).toBe(2);
    const count = p.writes.length;
    expect(await p.run()).toEqual(first);
    expect(p.writes).toHaveLength(count);
    expect(p.users.get(seed)).toEqual(baseline);
  });
  it.each(['createResponseLost', 'createErrorResponse'] as const)(
    'propagates %s instead of treating readback as a confirmed provision',
    async (failure) => {
      const p = provider();
      p.failures[failure] = true;
      await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
      // Provider state may have changed even though no credentials may be returned.
      expect(p.users.has(input.intent.userIds.desktop)).toBe(true);
      expect(p.users.has(input.intent.userIds.mobile)).toBe(false);
      expect(p.writes).toHaveLength(1);
      expect(p.tables.get('activities')?.size).toBe(0);
      expect(p.users.get(input.intent.userIds.desktop)?.app_metadata?.e2e_fixture_ready).toBe(
        false,
      );
    },
  );
  it('resumes interrupted seeding and marks ready only after all required rows exist', async () => {
    const p = provider();
    p.failures.table = 'activities';
    await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.users.get(input.intent.userIds.desktop)?.app_metadata?.e2e_fixture_ready).toBe(false);
    p.failures.table = '';
    await p.run();
    expect(p.tables.get('categories')?.size).toBe(2);
    expect(p.tables.get('activities')?.size).toBe(2);
    expect(p.users.get(input.intent.userIds.desktop)?.app_metadata?.e2e_fixture_ready).toBe(true);
  });
  it.each(['provision', 'cleanup', 'recover'])(
    'rejects a foreign second slot before any %s writes',
    async (operation) => {
      const p = provider();
      p.users.set(input.intent.userIds.mobile, {
        id: input.intent.userIds.mobile,
        email: 'foreign@example.com',
        app_metadata: { e2e_run_id: 'different' },
      });
      const selected = {
        ...input,
        operation,
        ...(operation === 'recover' ? { execution: { ...input.execution, attempt: 2 } } : {}),
      };
      await expect(p.run(selected)).rejects.toThrow(/^Preview fixture operation failed$/);
      expect(p.writes).toEqual([]);
    },
  );
  it('does not read a key or construct an admin client before both target and token validation', async () => {
    const p = provider();
    const secret = vi.fn(() => env.SUPABASE_SECRET_KEY);
    const selectedEnv = { ...env };
    Object.defineProperty(selectedEnv, 'SUPABASE_SECRET_KEY', { get: secret });
    const factory = vi.fn();
    selectedEnv.VERCEL_ENV = 'production';
    await expect(p.run(input, { env: selectedEnv, createClient: factory })).rejects.toThrow();
    expect(secret).not.toHaveBeenCalled();
    selectedEnv.VERCEL_ENV = 'preview';
    await expect(
      p.run(input, { env: selectedEnv, createClient: factory, token: 'invalid' }),
    ).rejects.toThrow();
    expect(secret).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(p.writes).toEqual([]);
  });
  it('deletes only the two owned users, verifies table absence, and performs no repeat deletes', async () => {
    const p = provider();
    await p.run();
    const foreignId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    p.users.set(foreignId, { id: foreignId, email: 'foreign@example.com', app_metadata: {} });
    p.tables.get('records')!.set('foreign-row', { id: 'foreign-row', user_id: foreignId });
    for (const id of Object.values(input.intent.userIds))
      p.tables.get('records')!.set(id, { id, user_id: id });
    const selected = { ...input, operation: 'cleanup' };
    expect(await p.run(selected)).toMatchObject({
      status: 'passed',
      absentUserIds: Object.values(input.intent.userIds),
    });
    const deletes = p.writes.filter((write) => write.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(p.users.has(seed)).toBe(true);
    expect(p.users.has(foreignId)).toBe(true);
    expect([...p.tables.get('records')!.values()]).toEqual([
      { id: 'foreign-row', user_id: foreignId },
    ]);
    await p.run(selected);
    expect(p.writes.filter((write) => write.method === 'DELETE')).toHaveLength(2);
  });
  it('uses the original intent on an independent recovery worker and attempts both deletions', async () => {
    const p = provider();
    await p.run();
    p.failures.deleteId = input.intent.userIds.desktop;
    const recovery = {
      ...input,
      operation: 'recover',
      execution: { ...input.execution, runId: 99999 },
    };
    await expect(p.run(recovery)).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.users.has(input.intent.userIds.desktop)).toBe(true);
    expect(p.users.has(input.intent.userIds.mobile)).toBe(false);
    p.failures.deleteId = '';
    const count = p.writes.length;
    await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect(p.writes).toHaveLength(count);
    expect(await p.run(recovery)).toMatchObject({ status: 'passed' });
    expect(p.users.size).toBe(1);
  });
  it('does not call cleanup successful when an owned table row survives Auth deletion', async () => {
    const p = provider();
    await p.run();
    p.failures.skipCascade = 'activities';
    await expect(p.run({ ...input, operation: 'cleanup' })).rejects.toThrow(
      /^Preview fixture operation failed$/,
    );
    expect(p.users.size).toBe(1);
    expect(p.tables.get('activities')?.size).toBe(2);
  });
  it('rejects a changed server credential generation without resetting existing passwords', async () => {
    const p = provider();
    await p.run();
    p.users.get(input.intent.userIds.mobile)!.app_metadata!.e2e_fixture_generation =
      'old-generation';
    const count = p.writes.length;
    await expect(p.run()).rejects.toThrow();
    expect(p.writes).toHaveLength(count);
    expect(await p.run({ ...input, operation: 'cleanup' })).toMatchObject({ status: 'passed' });
  });
  it('rejects an expired operation deadline before the first SDK request', async () => {
    const p = provider();
    let ticks = 0;
    await expect(p.run(input, { elapsed: () => (ticks++ === 0 ? 0 : 120_001) })).rejects.toThrow(
      /^Preview fixture operation failed$/,
    );
    expect(p.writes).toEqual([]);
  });
  it('does not overwrite a foreign category primary key during interrupted seed retry', async () => {
    const p = provider();
    p.failures.table = 'activities';
    await expect(p.run()).rejects.toThrow();
    const category = [...p.tables.get('categories')!.values()][0];
    category.user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const before = structuredClone(category);
    p.failures.table = '';
    await expect(p.run()).rejects.toThrow(/^Preview fixture operation failed$/);
    expect([...p.tables.get('categories')!.values()]).toEqual([before]);
  });
});
