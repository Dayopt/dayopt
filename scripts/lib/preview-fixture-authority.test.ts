import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  assertFixtureBrokerTarget,
  prepareFixtureAuthority,
  PREVIEW_ACCESS_AUDIENCE,
  requestFixtureJobToken,
  requestPreviewAccessToken,
  verifyFixtureJobToken,
  verifyPreviewAccessToken,
} from './preview-fixture-authority.mjs';

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
};
const now = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'test-key' };
function claims(selected = input) {
  return {
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
}
function token(payload = claims(), header = { alg: 'RS256', typ: 'JWT', kid: 'test-key' }) {
  const body = [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
function keys(body: unknown = { keys: [jwk] }) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
}

const jobEnv = {
  GITHUB_REPOSITORY: 'Dayopt/dayopt',
  GITHUB_REF: 'refs/heads/integration',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_SHA: input.execution.workflowSha,
  GITHUB_RUN_ID: String(input.execution.runId),
  GITHUB_RUN_ATTEMPT: String(input.execution.attempt),
  ACTIONS_ID_TOKEN_REQUEST_URL:
    'https://pipelinesghubeus10.actions.githubusercontent.com/oidc?api-version=2.0&audience=old',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-bearer',
};

describe('trusted job token request', () => {
  it('requests only the bound audience and verifies the returned signature before use', async () => {
    const minted = token();
    const fetchImpl = vi.fn<typeof fetch>(
      async (url) =>
        new Response(
          JSON.stringify(String(url).includes('/oidc?') ? { value: minted } : { keys: [jwk] }),
        ),
    );
    expect(await requestFixtureJobToken({ input, env: jobEnv, fetchImpl, now: () => now })).toBe(
      minted,
    );
    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(String(url)).searchParams.getAll('audience')).toEqual([
      prepareFixtureAuthority(input).audience,
    ]);
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer private-request-bearer' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]).not.toHaveProperty('headers');
  });
  it.each(Object.keys(jobEnv).filter((key) => key !== 'ACTIONS_ID_TOKEN_REQUEST_URL'))(
    'rejects missing or different %s before network access',
    async (key) => {
      for (const value of ['', 'different']) {
        const fetchImpl = keys();
        await expect(
          requestFixtureJobToken({ input, env: { ...jobEnv, [key]: value }, fetchImpl }),
        ).rejects.toThrow('token could not be requested');
        expect(fetchImpl).not.toHaveBeenCalled();
        // A bearer is opaque; any nonempty bearer reaches only GitHub, which
        // authenticates it. That case is covered separately, not a context mismatch.
        if (key === 'ACTIONS_ID_TOKEN_REQUEST_TOKEN') break;
      }
    },
  );
  it.each([
    'http://pipelinesghubeus10.actions.githubusercontent.com/oidc',
    'https://actions.githubusercontent.com.evil.example/oidc',
    'https://evil.example/oidc',
    'https://user:password@pipelinesghubeus10.actions.githubusercontent.com/oidc',
    'https://pipelinesghubeus10.actions.githubusercontent.com:444/oidc',
    'https://pipelinesghubeus10.actions.githubusercontent.com/oidc#private',
    'not-a-url',
  ])('never sends the request bearer to invalid endpoint %s', async (endpoint) => {
    const fetchImpl = keys();
    await expect(
      requestFixtureJobToken({
        input,
        env: { ...jobEnv, ACTIONS_ID_TOKEN_REQUEST_URL: endpoint },
        fetchImpl,
      }),
    ).rejects.toThrow('token could not be requested');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects a correctly signed token for another operation', async () => {
    const minted = token(claims({ ...input, operation: 'cleanup' }));
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ value: minted })),
    );
    await expect(
      requestFixtureJobToken({ input, env: jobEnv, fetchImpl, now: () => now }),
    ).rejects.toThrow('token could not be requested');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not expose provider error bodies or request credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('PRIVATE token password body');
    });
    await expect(requestFixtureJobToken({ input, env: jobEnv, fetchImpl })).rejects.toThrow(
      /^Preview fixture job token could not be requested$/,
    );
  });
  it('rejects oversized token responses without returning a token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ value: 'x'.repeat(70_000) })),
    );
    await expect(requestFixtureJobToken({ input, env: jobEnv, fetchImpl })).rejects.toThrow(
      'token could not be requested',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Preview fixture authority binding', () => {
  it('normalizes public input without creating credentials', () => {
    const prepared = prepareFixtureAuthority(input);
    expect(prepared.intent.userIds).toEqual(input.intent.userIds);
    expect(prepared.audience).toMatch(/^urn:dayopt:preview-fixture:v1:[a-f0-9]{64}$/);
    expect(JSON.stringify(prepared)).not.toMatch(/password|secret|token/);
    const reordered = {
      ...input,
      intent: {
        ...input.intent,
        userIds: { mobile: input.intent.userIds.mobile, desktop: input.intent.userIds.desktop },
      },
    };
    expect(prepareFixtureAuthority(reordered).audience).toBe(prepared.audience);
  });
  it.each(['cleanup', 'recover'])('binds operation %s into its audience', (operation) => {
    const changed = {
      ...input,
      operation,
      execution: operation === 'recover' ? { ...input.execution, attempt: 2 } : input.execution,
    };
    expect(prepareFixtureAuthority(changed).audience).not.toBe(
      prepareFixtureAuthority(input).audience,
    );
  });
  it('requires a later independent attempt for recovery', () => {
    expect(() => prepareFixtureAuthority({ ...input, operation: 'recover' })).toThrow();
    expect(() =>
      prepareFixtureAuthority({ ...input, execution: { ...input.execution, attempt: 2 } }),
    ).toThrow();
  });
  it('rejects shared mode, extra inputs, seed collision and Production', () => {
    expect(() => prepareFixtureAuthority({ ...input, extra: 'PRIVATE' })).toThrow();
    expect(() =>
      prepareFixtureAuthority({
        ...input,
        intent: {
          ...input.intent,
          userIds: { ...input.intent.userIds, desktop: '00000000-0000-0000-0000-000000000001' },
        },
      }),
    ).toThrow();
    for (const supabaseProjectRef of ['yvglwblxrnrenfifsnje', 'tilwaprottpyhlfoggbb']) {
      expect(() =>
        prepareFixtureAuthority({
          ...input,
          intent: { ...input.intent, request: { ...input.intent.request, supabaseProjectRef } },
        }),
      ).toThrow();
    }
    expect(() =>
      prepareFixtureAuthority({
        ...input,
        intent: {
          ...input.intent,
          request: {
            ...input.intent.request,
            databaseMode: 'shared',
            supabaseProjectRef: 'tilwaprottpyhlfoggbb',
            supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
          },
        },
      }),
    ).toThrow();
  });
  it('accepts only the same immutable Preview and selected database', () => {
    expect(assertFixtureBrokerTarget(input, env).audience).toBe(
      prepareFixtureAuthority(input).audience,
    );
  });
  it.each(Object.keys(env))('rejects a different or missing %s', (key) => {
    expect(() => assertFixtureBrokerTarget(input, { ...env, [key]: 'different' })).toThrow(
      'target differs',
    );
    const missing = { ...env } as Record<string, string>;
    delete missing[key];
    expect(() => assertFixtureBrokerTarget(input, missing)).toThrow('target differs');
  });
});

describe('GitHub fixture job authentication', () => {
  it('verifies a real RSA signature and returns only normalized public authority', async () => {
    const fetchImpl = keys();
    const result = await verifyFixtureJobToken({
      input,
      token: token(),
      now: () => now,
      fetchImpl,
    });
    expect(result).toEqual(prepareFixtureAuthority(input));
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token.actions.githubusercontent.com/.well-known/jwks',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(JSON.stringify(result)).not.toContain('repository_id');
  });
  it.each([
    ['iss', 'https://untrusted.example'],
    ['aud', 'other-audience'],
    ['sub', 'repo:Dayopt/dayopt:ref:refs/heads/integration'],
    ['repository', 'someone/dayopt'],
    ['repository_id', '1'],
    ['repository_owner_id', '1'],
    ['environment', 'Production'],
    ['ref', 'refs/heads/main'],
    ['workflow_ref', 'Dayopt/dayopt/evil.yml@refs/heads/integration'],
    ['event_name', 'pull_request'],
    ['runner_environment', 'self-hosted'],
    ['sha', 'c'.repeat(40)],
    ['workflow_sha', 'c'.repeat(40)],
    ['run_id', '1'],
    ['run_attempt', '2'],
    ['iat', now + 60],
    ['nbf', now + 60],
    ['exp', now],
    ['exp', now + 601],
  ])('rejects signed mismatched claim %s before any network access', async (key, value) => {
    const fetchImpl = keys();
    await expect(
      verifyFixtureJobToken({
        input,
        token: token({ ...claims(), [key]: value }),
        now: () => now,
        fetchImpl,
      }),
    ).rejects.toThrow('job authentication failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('cannot transfer a provision token to cleanup or to a different planned user', async () => {
    const cleanup = { ...input, operation: 'cleanup' };
    const changed = {
      ...input,
      intent: {
        ...input.intent,
        userIds: { ...input.intent.userIds, mobile: '44444444-4444-4444-8444-444444444444' },
      },
    };
    for (const selected of [cleanup, changed]) {
      await expect(
        verifyFixtureJobToken({
          input: selected,
          token: token(),
          now: () => now,
          fetchImpl: keys(),
        }),
      ).rejects.toThrow('job authentication failed');
    }
  });
  it('binds recovery to the new job while preserving the original intent', async () => {
    const recovery = {
      ...input,
      operation: 'recover',
      execution: { ...input.execution, attempt: 2 },
    };
    const result = await verifyFixtureJobToken({
      input: recovery,
      token: token(claims(recovery)),
      now: () => now,
      fetchImpl: keys(),
    });
    expect(result.intent.sourceAttempt).toBe(1);
    expect(result.execution.attempt).toBe(2);
  });
  it('rejects a forged signature even when claims and key ID match', async () => {
    const signed = token().split('.');
    const signature = Buffer.from(signed[2]!, 'base64url');
    signature[0] ^= 1;
    signed[2] = signature.toString('base64url');
    await expect(
      verifyFixtureJobToken({ input, token: signed.join('.'), now: () => now, fetchImpl: keys() }),
    ).rejects.toThrow('job authentication failed');
  });
  it('rejects a token that expires while its verification key is fetched', async () => {
    let clock = now;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      clock = now + 301;
      return new Response(JSON.stringify({ keys: [jwk] }));
    });
    await expect(
      verifyFixtureJobToken({ input, token: token(), now: () => clock, fetchImpl }),
    ).rejects.toThrow('job authentication failed');
  });
  it('rejects alg none and header-supplied key URLs', async () => {
    for (const header of [
      { alg: 'none', typ: 'JWT', kid: 'test-key' },
      { alg: 'RS256', typ: 'JWT', kid: 'test-key', jku: 'https://PRIVATE.example' },
    ]) {
      const fetchImpl = keys();
      await expect(
        verifyFixtureJobToken({ input, token: token(claims(), header), now: () => now, fetchImpl }),
      ).rejects.toThrow('job authentication failed');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it.each([
    { keys: [] },
    { keys: [jwk, jwk] },
    { keys: [{ ...jwk, kid: 'unknown' }] },
    { keys: [{ ...jwk, use: 'enc' }] },
    { keys: [{ ...jwk, alg: 'HS256' }] },
  ])('rejects missing, ambiguous or incompatible keys', async (body) => {
    await expect(
      verifyFixtureJobToken({ input, token: token(), now: () => now, fetchImpl: keys(body) }),
    ).rejects.toThrow('job authentication failed');
  });
  it('bounds provider bodies and never exposes token or provider errors', async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => new Response('PRIVATE_BODY'.repeat(10_000))),
      vi.fn<typeof fetch>(async () => {
        throw new Error('PRIVATE_PROVIDER_TOKEN');
      }),
      vi.fn<typeof fetch>(async () => new Response('PRIVATE_PROVIDER_TOKEN', { status: 403 })),
    ]) {
      await expect(
        verifyFixtureJobToken({ input, token: token(), now: () => now, fetchImpl }),
      ).rejects.toThrow(/^Preview fixture job authentication failed$/);
    }
  });
});

describe('Preview-only Trusted Sources token', () => {
  it('uses a distinct audience which cannot authorize fixture mutation', async () => {
    const access = token({ ...claims(), aud: PREVIEW_ACCESS_AUDIENCE });
    await expect(
      verifyPreviewAccessToken({ input, token: access, fetchImpl: keys(), now: () => now }),
    ).resolves.toBeDefined();
    await expect(
      verifyFixtureJobToken({ input, token: access, fetchImpl: keys(), now: () => now }),
    ).rejects.toThrow();
    await expect(
      verifyPreviewAccessToken({ input, token: token(), fetchImpl: keys(), now: () => now }),
    ).rejects.toThrow();
  });
  it('requests only the fixed access audience and verifies provider signature', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://token.actions.githubusercontent.com/')
        ? Response.json({ keys: [jwk] })
        : Response.json({ value: token({ ...claims(), aud: PREVIEW_ACCESS_AUDIENCE }) }),
    );
    await expect(
      requestPreviewAccessToken({ input, env: jobEnv, fetchImpl, now: () => now }),
    ).resolves.toBeDefined();
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('audience')).toBe(
      PREVIEW_ACCESS_AUDIENCE,
    );
  });
});
