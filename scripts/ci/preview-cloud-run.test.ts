import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertCloudFixtureKey,
  cleanupCloudRun,
  publishCloudEvidence,
  validateCloudRequest,
  verifyCloudFixtureContract,
} from './preview-cloud-run.mjs';

const request = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_safe123',
  prNumber: 2948,
  branchName: 'codex/candidate',
  supabaseProjectRef: 'tilwaprottpyhlfoggbb',
  supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
  databaseMode: 'shared',
};
const runId = 'b617105b-9c87-44c0-b5f8-18071be8c0f9';
const userId = 'd707d390-8ad2-4776-8e46-7364f6cd7145';
const roots: string[] = [];
const reviewedFlowIds = {
  desktop: [
    'desktop-plan-create',
    'desktop-record-create',
    'desktop-past-plan-create',
    'desktop-summary-known-records',
    'desktop-summary-record-deep-link',
    'desktop-summary-empty',
    'desktop-settings-display',
    'desktop-data-export',
    'desktop-activity-lifecycle',
    'desktop-theme',
    'desktop-timezone',
    'desktop-locale',
    'desktop-category-lifecycle',
    'desktop-inspector-search',
    'desktop-plan-move',
    'desktop-conflict-merge',
    'desktop-template-lifecycle',
  ],
  mobile: [
    'mobile-plan-create',
    'mobile-record-create',
    'mobile-summary-to-inspector',
    'mobile-settings-display',
  ],
  public: [
    { file: 'smoke.spec.ts', flowId: 'product-smoke-unauth-redirect' },
    { file: 'smoke.spec.ts', flowId: 'product-smoke-en-signup-locale' },
    { file: 'smoke.spec.ts', flowId: 'product-smoke-ja-signup-locale' },
    { file: 'a11y.spec.ts', flowId: 'product-a11y-login' },
    { file: 'auth.spec.ts', flowId: 'product-auth-signup-page' },
    { file: 'auth.spec.ts', flowId: 'product-auth-login-page' },
    { file: 'auth.spec.ts', flowId: 'product-auth-password-page' },
    { file: 'pwa.spec.ts', flowId: 'product-pwa-manifest' },
  ],
  authenticated: [
    { file: 'account-deletion.spec.ts', project: 'chromium', flowId: 'product-account-deletion' },
    { file: 'auth.spec.ts', project: 'chromium', flowId: 'product-auth-login-valid' },
    { file: 'auth.spec.ts', project: 'chromium', flowId: 'product-auth-login-invalid' },
    { file: 'a11y.spec.ts', project: 'chromium', flowId: 'product-a11y-calendar' },
    { file: 'a11y.spec.ts', project: 'chromium', flowId: 'product-a11y-settings' },
    {
      file: 'calendar-navigation.spec.ts',
      project: 'chromium',
      flowId: 'product-calendar-view-navigation',
    },
    {
      file: 'calendar-navigation.spec.ts',
      project: 'chromium',
      flowId: 'product-calendar-sidebar-navigation',
    },
    { file: 'block-search.spec.ts', project: 'chromium', flowId: 'product-search-desktop' },
    { file: 'block-search.spec.ts', project: 'Mobile Chrome', flowId: 'product-search-mobile' },
    {
      file: 'plan-record-timeblock.spec.ts',
      project: 'chromium',
      flowId: 'product-plan-record-calendar',
    },
    {
      file: 'plan-record-timeblock.spec.ts',
      project: 'chromium',
      flowId: 'product-record-inspector-url',
    },
    { file: 'deep-link.spec.ts', project: 'chromium', flowId: 'product-deep-link-week' },
    { file: 'deep-link.spec.ts', project: 'chromium', flowId: 'product-deep-link-prefixless' },
    {
      file: 'deep-link.spec.ts',
      project: 'chromium',
      flowId: 'product-deep-link-default-week',
    },
    { file: 'deep-link.spec.ts', project: 'chromium', flowId: 'product-deep-link-invalid-view' },
    {
      file: 'derived-plan-record-flow.spec.ts',
      project: 'chromium',
      flowId: 'product-derived-plan-record',
    },
    { file: 'timeblock-conflict.spec.ts', project: 'chromium', flowId: 'product-plan-conflict' },
    {
      file: 'timeblock-drag-move.spec.ts',
      project: 'chromium',
      flowId: 'product-plan-drag-move',
    },
    {
      file: 'timeblock-inspector-toggle.spec.ts',
      project: 'chromium',
      flowId: 'product-inspector-toggle',
    },
    {
      file: 'mobile-navigation.spec.ts',
      project: 'Mobile Chrome',
      flowId: 'product-mobile-settings-navigation',
    },
    {
      file: 'mobile-navigation.spec.ts',
      project: 'Mobile Chrome',
      flowId: 'product-mobile-calendar-navigation',
    },
    { file: 'billing.spec.ts', project: 'chromium', flowId: 'product-billing-checkout-mocked' },
    { file: 'billing.spec.ts', project: 'chromium', flowId: 'product-billing-portal-mocked' },
    {
      file: 'billing.spec.ts',
      project: 'chromium',
      flowId: 'product-billing-checkout-success-return',
    },
    {
      file: 'billing.spec.ts',
      project: 'chromium',
      flowId: 'product-billing-checkout-cancel-return',
    },
    { file: 'billing.spec.ts', project: 'chromium', flowId: 'product-billing-portal-return' },
    {
      file: 'calendar-initial-load.spec.ts',
      project: 'chromium',
      flowId: 'product-initial-desktop-tokyo',
    },
    {
      file: 'calendar-initial-load.spec.ts',
      project: 'chromium',
      flowId: 'product-initial-desktop-la',
    },
    {
      file: 'calendar-initial-load.spec.ts',
      project: 'Mobile Chrome',
      flowId: 'product-initial-mobile-tokyo',
    },
    {
      file: 'calendar-initial-load.spec.ts',
      project: 'Mobile Chrome',
      flowId: 'product-initial-mobile-la',
    },
  ],
};
type PublicDiagnosticArtifact = {
  tests: Array<{
    procedureBudget?: {
      procedures: number;
      budget: number;
      rateLimitedResponses: number;
      mixedBatchResponses: number;
    };
    failedSteps: Array<{
      category: 'expect' | 'pw:api' | 'test.step' | 'fixture' | 'hook' | 'other';
      file:
        | 'critical-path.spec.ts'
        | 'mobile-critical-path.spec.ts'
        | 'account-deletion.spec.ts'
        | 'smoke.spec.ts'
        | 'a11y.spec.ts'
        | 'auth.spec.ts'
        | 'pwa.spec.ts'
        | 'calendar-navigation.spec.ts'
        | 'block-search.spec.ts'
        | 'plan-record-timeblock.spec.ts'
        | 'deep-link.spec.ts'
        | 'derived-plan-record-flow.spec.ts'
        | 'timeblock-conflict.spec.ts'
        | 'timeblock-drag-move.spec.ts'
        | 'timeblock-inspector-toggle.spec.ts'
        | 'mobile-navigation.spec.ts'
        | 'billing.spec.ts'
        | 'calendar-initial-load.spec.ts'
        | null;
      line: number | null;
      duration: number;
    }>;
  }>;
};
function readPublicDiagnostics(destination: string): PublicDiagnosticArtifact {
  return JSON.parse(readFileSync(join(destination, 'preview.json'), 'utf8'));
}
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-evidence-test-'));
  roots.push(root);
  const directory = join(root, 'run');
  mkdirSync(join(directory, 'evidence', 'users'), { recursive: true });
  writeFileSync(
    join(directory, 'evidence', 'run.json'),
    JSON.stringify({
      runId,
      status: 'failed',
      before: {
        ...request,
        origin: 'https://product-test123-dayopt.vercel.app',
        migrationVersions: ['20260928044000'],
      },
      ...overrides,
      password: 'PRIVATE_PASSWORD',
      token: 'PRIVATE_TOKEN',
      failure: 'PRIVATE_ERROR',
    }),
  );
  writeFileSync(
    join(directory, 'evidence', 'users', `${userId}.json`),
    JSON.stringify({ runId, userId, status: 'cleanup-failed', email: 'PRIVATE_EMAIL' }),
  );
  return { directory, destination: join(root, 'public'), request };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Cloud Preview evidence and cleanup', () => {
  it('rejects candidates that would ignore the precommitted fixture IDs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-fixture-contract-'));
    roots.push(root);
    const paths = [
      'apps/product/src/lib/test/preview-cloud-identity.ts',
      'apps/product/src/lib/test/e2e/critical-path-fixture.ts',
      'apps/product/src/lib/test/e2e/account-deletion-fixture.ts',
      'apps/product/src/lib/test/e2e/create-scoped-test-user.ts',
      'apps/product/src/lib/test/e2e/preview-access-fixture.ts',
      'apps/product/src/lib/test/e2e/trpc-response-mock.ts',
      'apps/product/src/lib/test/e2e/trpc-budget-fixture.ts',
      'apps/product/src/lib/test/preview-user-lifecycle.ts',
      'apps/product/src/lib/test/preview-access.ts',
    ];
    for (const path of paths) {
      const file = join(root, path);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, readFileSync(path));
    }
    expect(() => verifyCloudFixtureContract(root)).not.toThrow();
    writeFileSync(
      join(root, paths[1]),
      'export function createCriticalPathIdentity(){return {userId:crypto.randomUUID()}}',
    );
    expect(() => verifyCloudFixtureContract(root)).toThrow('fixture contract differs');
    writeFileSync(join(root, paths[1]), readFileSync(paths[1]));
    writeFileSync(join(root, paths[2]), 'export function unsafeDelete(){ return true }');
    expect(() => verifyCloudFixtureContract(root)).toThrow('fixture contract differs');
    rmSync(join(root, paths[0]));
    expect(() => verifyCloudFixtureContract(root)).toThrow();
  });
  it('rejects Production and malformed identifiers before any recovery', () => {
    expect(() =>
      validateCloudRequest({ ...request, supabaseProjectRef: 'yvglwblxrnrenfifsnje' }),
    ).toThrow();
    expect(() => validateCloudRequest({ ...request, branchName: 'candidate\nTOKEN=x' })).toThrow();
  });
  it('binds merged validation to a valid merge commit and rejects malformed or extra policy fields', () => {
    expect(validateCloudRequest(request)).toEqual(request);
    const merged = {
      ...request,
      mergedValidation: true,
      mergeCommitSha: 'c'.repeat(40),
    };
    expect(validateCloudRequest(merged)).toEqual(merged);
    expect(() => validateCloudRequest({ ...merged, mergeCommitSha: 'short' })).toThrow(
      'Invalid Cloud Preview merge binding',
    );
    expect(() =>
      validateCloudRequest({ ...request, mergedValidation: false, mergeCommitSha: 'c'.repeat(40) }),
    ).toThrow('Invalid Cloud Preview merge binding');
    expect(() => validateCloudRequest({ ...request, unexpected: true })).toThrow(
      'Invalid Cloud Preview binding',
    );
  });
  it('publishes interrupted execution as a terminal failure', () => {
    const options = fixture({ status: 'running' });
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      cleanupConfirmed: false,
      testsPassed: false,
    });
  });
  it('reconstructs only allowlisted metadata and ownership journal identifiers', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'e2e.json'),
      JSON.stringify({
        tests: [
          {
            file: 'critical-path.spec.ts',
            project: 'chromium',
            flowId: 'desktop-plan-create',
            line: 1,
            retry: 0,
            status: 'failed',
            expectedPassed: true,
            title: 'PRIVATE_TITLE',
            error: 'PRIVATE_ERROR',
            headers: 'PRIVATE_TOKEN',
          },
        ],
      }),
    );
    writeFileSync(join(options.directory, 'evidence', 'screenshot.png'), 'PRIVATE_SCREENSHOT');
    const result = publishCloudEvidence(options);
    expect(result.users).toEqual([{ userId, runId, status: 'cleanup-failed' }]);
    const serialized = readFileSync(join(options.destination, 'preview.json'), 'utf8');
    expect(serialized).not.toContain('PRIVATE_');
    expect(serialized).not.toContain('desktop-plan-create');
    expect(result.tests).toHaveLength(1);
  });
  it.each(['smoke.spec.ts', 'a11y.spec.ts', 'auth.spec.ts', 'pwa.spec.ts'] as const)(
    'publishes sanitized failure locations for public Product flow %s',
    (file) => {
      const options = fixture();
      writeFileSync(
        join(options.directory, 'evidence', 'e2e.json'),
        JSON.stringify({
          tests: [
            {
              file,
              project: 'chromium',
              line: 17,
              retry: 0,
              status: 'failed',
              expectedPassed: true,
              steps: [{ category: 'expect', file, line: 18, duration: 12, failed: true }],
            },
          ],
        }),
      );

      const result = publishCloudEvidence(options);
      expect('reportComplete' in result && result.reportComplete).toBe(true);
      expect(result.tests[0]).toMatchObject({
        file,
        failedSteps: [{ category: 'expect', file, line: 18, duration: 12 }],
      });
    },
  );
  it('publishes only sanitized failed Playwright step metadata for diagnosis', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'e2e.json'),
      JSON.stringify({
        tests: [
          {
            file: 'critical-path.spec.ts',
            project: 'chromium',
            line: 205,
            retry: 0,
            status: 'failed',
            expectedPassed: true,
            title: 'PRIVATE_TITLE',
            error: 'PRIVATE_ERROR',
            headers: 'PRIVATE_TOKEN',
            steps: [
              {
                category: 'pw:api',
                file: 'critical-path.spec.ts',
                line: 208,
                duration: 43,
                failed: false,
                title: 'PRIVATE_TITLE',
                error: 'PRIVATE_ERROR',
              },
              {
                category: 'expect',
                file: 'critical-path.spec.ts',
                line: 212,
                duration: 5000,
                failed: true,
                title: 'PRIVATE_TITLE',
                error: 'PRIVATE_ERROR',
                body: 'PRIVATE_BODY',
              },
              {
                category: 'untrusted-category',
                file: '/private/PRIVATE_FILE',
                line: 0,
                duration: -1,
                failed: true,
                title: 'PRIVATE_TITLE',
                error: 'PRIVATE_ERROR',
              },
            ],
          },
        ],
      }),
    );

    const result = publishCloudEvidence(options);
    expect(result.tests).toEqual([
      {
        file: 'critical-path.spec.ts',
        project: 'chromium',
        line: 205,
        status: 'failed',
        retry: 0,
        expectedPassed: true,
        failedSteps: [
          { category: 'expect', file: 'critical-path.spec.ts', line: 212, duration: 5000 },
          { category: 'other', file: null, line: null, duration: 0 },
        ],
      },
    ]);
    const serialized = readFileSync(join(options.destination, 'preview.json'), 'utf8');
    expect(serialized).not.toContain('PRIVATE_');
  });
  it('retains only four numeric procedure-budget fields from the candidate report', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'e2e.json'),
      JSON.stringify({
        tests: [
          {
            file: 'critical-path.spec.ts',
            project: 'chromium',
            line: 471,
            retry: 0,
            status: 'failed',
            expectedPassed: true,
            procedureBudget: {
              procedures: 31,
              budget: 26,
              rateLimitedResponses: 0,
              mixedBatchResponses: 0,
              counts: { PRIVATE_PROCEDURE: 31 },
              title: 'PRIVATE_TITLE',
              error: 'PRIVATE_ERROR',
            },
          },
        ],
      }),
    );
    publishCloudEvidence(options);
    const result = readPublicDiagnostics(options.destination);
    expect(result.tests[0]?.procedureBudget).toEqual({
      procedures: 31,
      budget: 26,
      rateLimitedResponses: 0,
      mixedBatchResponses: 0,
    });
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '26'])(
    'publisher independently drops an invalid procedure-budget value: %s',
    (budget) => {
      const options = fixture();
      writeFileSync(
        join(options.directory, 'evidence', 'e2e.json'),
        JSON.stringify({
          tests: [
            {
              file: 'critical-path.spec.ts',
              project: 'chromium',
              line: 471,
              retry: 0,
              status: 'failed',
              expectedPassed: true,
              procedureBudget: {
                procedures: 31,
                budget,
                rateLimitedResponses: 0,
                mixedBatchResponses: 0,
              },
              failedSteps: [
                {
                  category: 'test.step',
                  file: 'critical-path.spec.ts',
                  line: 482,
                  duration: 5000,
                  title: 'PRIVATE_TITLE',
                  error: 'PRIVATE_ERROR',
                },
              ],
            },
          ],
        }),
      );
      publishCloudEvidence(options);
      const result = readPublicDiagnostics(options.destination);
      expect(result.tests[0]).not.toHaveProperty('procedureBudget');
      expect(result.tests[0]?.failedSteps).toEqual([
        { category: 'test.step', file: 'critical-path.spec.ts', line: 482, duration: 5000 },
      ]);
      expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
        'PRIVATE_',
      );
    },
  );
  it.each([
    'reviewed',
    'old-twenty',
    'old-twelve',
    'old-seven',
    'duplicate',
    'wrong-pair',
    'substituted',
    'missing',
  ])('publisher independently enforces reviewed coverage: %s', (kind) => {
    const options = fixture();
    const tests = [
      ...reviewedFlowIds.desktop.map((flowId, index) => ({
        file: 'critical-path.spec.ts',
        project: 'chromium',
        flowId,
        line: index + 1,
      })),
      ...reviewedFlowIds.mobile.map((flowId, index) => ({
        file: 'mobile-critical-path.spec.ts',
        project: 'Mobile Chrome',
        flowId,
        line: index + 1,
      })),
      ...reviewedFlowIds.public.map(({ file, flowId }, index) => ({
        file,
        project: 'chromium',
        flowId,
        line: index + 1,
      })),
      ...reviewedFlowIds.authenticated.map(({ file, project, flowId }, index) => ({
        file,
        project,
        flowId,
        line: index + 1,
      })),
    ].map((row) => ({ ...row, status: 'passed', expectedPassed: true, retry: 0 }));
    if (kind === 'old-twenty') tests.splice(16, 1);
    if (kind === 'old-twelve') {
      tests.splice(9, 8);
      tests.pop();
    }
    if (kind === 'old-seven') {
      tests.splice(4, 13);
      tests.pop();
    }
    if (kind === 'duplicate') tests[8] = { ...tests[0]! };
    if (kind === 'wrong-pair') tests[0]!.file = 'mobile-critical-path.spec.ts';
    if (kind === 'substituted') tests[3]!.flowId = 'desktop-unreviewed-flow';
    if (kind === 'missing') tests.splice(8, 1);
    writeFileSync(
      join(options.directory, 'evidence', 'e2e.json'),
      JSON.stringify({
        status: 'passed',
        expected: tests.length,
        tests,
      }),
    );
    expect(publishCloudEvidence(options)).toMatchObject({ testsPassed: kind === 'reviewed' });
  });
  it('refuses a changed candidate binding before recovery and before artifact creation', async () => {
    const options = fixture({ before: { ...request, sha: 'b'.repeat(40) } });
    const recover = vi.fn();
    await expect(cleanupCloudRun({ ...options, serviceKey: 'unused', recover })).rejects.toThrow();
    expect(recover).not.toHaveBeenCalled();
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      runBindingConfirmed: false,
    });
  });
  it('rejects a key for another project before any HTTP request', async () => {
    const fetchImpl = vi.fn();
    const claims = Buffer.from(
      JSON.stringify({ role: 'service_role', ref: 'yvglwblxrnrenfifsnje' }),
    ).toString('base64url');
    await expect(
      assertCloudFixtureKey({ request, serviceKey: `header.${claims}.signature`, fetchImpl }),
    ).rejects.toThrow('binding differs');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('authenticates an opaque key only at the selected nonproduction baseline endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', email: 'PRIVATE_EMAIL' }),
          { status: 200 },
        ),
      );
    await assertCloudFixtureKey({ request, serviceKey: 'sb_secret_safe-dummy', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://tilwaprottpyhlfoggbb.supabase.co/auth/v1/admin/users/00000000-0000-0000-0000-000000000001',
    );
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('apikey')).toBe(
      'sb_secret_safe-dummy',
    );
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('Authorization')).toBeNull();
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('apikey')).toBe(
      'sb_secret_safe-dummy',
    );
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get('Authorization')).toBeNull();
    fetchImpl.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR', { status: 401 }));
    await expect(
      assertCloudFixtureKey({ request, serviceKey: 'sb_secret_wrong', fetchImpl }),
    ).rejects.toThrow('key or baseline is not ready');
  });
  it('requires every planned fixture ID to be absent before the cloud browser starts', async () => {
    const ids = {
      desktop: 'd707d390-8ad2-4776-8e46-7364f6cd7145',
      mobile: 'e707d390-8ad2-4776-8e46-7364f6cd7145',
      accountDeletion: 'f707d390-8ad2-4776-8e46-7364f6cd7145',
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/00000000-0000-0000-0000-000000000001'))
        return new Response(JSON.stringify({ id: '00000000-0000-0000-0000-000000000001' }), {
          status: 200,
        });
      return new Response('', { status: 404 });
    });
    await assertCloudFixtureKey({
      request,
      serviceKey: 'sb_secret_safe-dummy',
      userIds: ids,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map(([input]) => String(input).split('/').at(-1))).toEqual([
      '00000000-0000-0000-0000-000000000001',
      ids.desktop,
      ids.mobile,
      ids.accountDeletion,
    ]);
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/00000000-0000-0000-0000-000000000001'))
        return new Response(JSON.stringify({ id: '00000000-0000-0000-0000-000000000001' }), {
          status: 200,
        });
      return new Response('', { status: url.endsWith(ids.accountDeletion) ? 200 : 404 });
    });
    await expect(
      assertCloudFixtureKey({
        request,
        serviceKey: 'sb_secret_safe-dummy',
        userIds: ids,
        fetchImpl,
      }),
    ).rejects.toThrow('key or baseline is not ready');
  });
  it('publishes only a fixed preflight stage when the run journal was never created', () => {
    const options = fixture();
    rmSync(join(options.directory, 'evidence', 'run.json'));
    writeFileSync(
      join(options.directory, 'preflight-failure.json'),
      JSON.stringify({
        stage: 'fixture-contract',
        error: 'PRIVATE_PROVIDER_ERROR',
        url: 'https://PRIVATE_PROVIDER.invalid',
        id: 'PRIVATE_ID',
        email: 'PRIVATE_EMAIL',
        credential: 'PRIVATE_CREDENTIAL',
        output: 'PRIVATE_CANDIDATE_OUTPUT',
      }),
    );
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      runBindingConfirmed: false,
      cleanupConfirmed: false,
      preflightFailureStage: 'fixture-contract',
    });
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
  it.each(['candidate-binding', 'fixture-contract'])(
    'records a CLI failure before run.json without exposing child errors: %s',
    (stage) => {
      const root = mkdtempSync(join(tmpdir(), 'cloud-preflight-cli-'));
      roots.push(root);
      const bin = join(root, 'bin');
      const candidate = join(root, 'PRIVATE_CANDIDATE');
      const directory = join(root, 'run');
      const destination = join(root, 'public');
      mkdirSync(bin);
      mkdirSync(candidate);
      const git = join(bin, 'git');
      const observedSha = stage === 'candidate-binding' ? 'PRIVATE_CANDIDATE_OUTPUT' : request.sha;
      writeFileSync(
        git,
        `#!/bin/sh
if [ "$1" = rev-parse ]; then printf '%s' '${observedSha}'; fi
`,
      );
      chmodSync(git, 0o700);
      const requestFile = join(root, 'request.json');
      const intentFile = join(root, 'intent.json');
      writeFileSync(requestFile, JSON.stringify(request));
      const workflowSha = 'c'.repeat(40);
      writeFileSync(
        intentFile,
        JSON.stringify({
          schemaVersion: 2,
          repository: 'Dayopt/dayopt',
          workflow: '.github/workflows/ci.yml',
          workflowRef: 'refs/heads/integration',
          workflowSha,
          sourceRunId: 4500,
          sourceAttempt: 1,
          runId,
          createdAt: '2026-10-05T00:00:00.000Z',
          userIds: {
            desktop: userId,
            mobile: '11111111-1111-4111-8111-111111111111',
            accountDeletion: '22222222-2222-4222-8222-222222222222',
          },
          request,
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          'scripts/ci/preview-cloud-run.mjs',
          'execute',
          requestFile,
          candidate,
          directory,
          destination,
          intentFile,
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_RUN_ID: '4500',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_SHA: workflowSha,
            SUPABASE_PREVIEW_PROVISION_TOKEN: 'PRIVATE_CREDENTIAL',
          },
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cloud Preview operation failed;');
      expect(result.stderr).toContain(stage);
      expect(`${result.stdout}${result.stderr}`).not.toContain('PRIVATE_');
      expect(existsSync(join(directory, 'evidence', 'run.json'))).toBe(false);
      expect(JSON.parse(readFileSync(join(directory, 'preflight-failure.json'), 'utf8'))).toEqual({
        stage,
      });
      expect(publishCloudEvidence({ directory, destination, request })).toMatchObject({
        preflightFailureStage: stage,
        runBindingConfirmed: false,
      });
    },
  );
  it.each(['candidate-binding', 'fixture-key', 'migration-inventory', 'runner-preflight'])(
    'retains only the known preflight enum in the public artifact: %s',
    (stage) => {
      const options = fixture();
      rmSync(join(options.directory, 'evidence', 'run.json'));
      writeFileSync(join(options.directory, 'preflight-failure.json'), JSON.stringify({ stage }));
      expect(publishCloudEvidence(options)).toMatchObject({ preflightFailureStage: stage });
    },
  );
  it.each(['not-json', '{}', 'null', '{"stage":"PRIVATE_PROVIDER_ERROR"}'])(
    'keeps the generic fallback for missing or untrusted diagnostic data: %s',
    (marker) => {
      const options = fixture();
      rmSync(join(options.directory, 'evidence', 'run.json'));
      writeFileSync(join(options.directory, 'preflight-failure.json'), marker);
      const result = publishCloudEvidence(options);
      expect(result).toMatchObject({ status: 'failed', runBindingConfirmed: false });
      expect(result).not.toHaveProperty('preflightFailureStage');
      expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
        'PRIVATE_',
      );
    },
  );
  it('does not classify an existing journal with a mismatched binding as a preflight failure', () => {
    const options = fixture({ before: { ...request, sha: 'b'.repeat(40) } });
    writeFileSync(
      join(options.directory, 'preflight-failure.json'),
      JSON.stringify({ stage: 'fixture-contract' }),
    );
    const result = publishCloudEvidence(options);
    expect(result).toMatchObject({ status: 'failed', runBindingConfirmed: false });
    expect(result).not.toHaveProperty('preflightFailureStage');
  });
  it('publishes a failed binding marker when execution stopped before a run journal existed', () => {
    const options = fixture();
    rmSync(join(options.directory, 'evidence', 'run.json'));
    expect(publishCloudEvidence(options)).toMatchObject({
      status: 'failed',
      runBindingConfirmed: false,
      cleanupConfirmed: false,
    });
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
  it('invokes recovery for the bound run and selected database only', async () => {
    const options = fixture();
    const recover = vi.fn().mockResolvedValue({ status: 'clean', checked: 1, recovered: 1 });
    await cleanupCloudRun({ ...options, serviceKey: 'safe-dummy-key', recover });
    expect(recover).toHaveBeenCalledWith({
      evidenceDirectory: join(options.directory, 'evidence'),
      runId,
      supabaseProjectRef: request.supabaseProjectRef,
      serviceKey: 'safe-dummy-key',
    });
  });
  it('validates the owned journal before resolving the Preview key for cleanup', async () => {
    const options = fixture();
    const resolveServiceKey = vi.fn(async () => 'safe-dummy-key');
    const recover = vi.fn().mockResolvedValue({ status: 'clean', checked: 1, recovered: 0 });
    await cleanupCloudRun({ ...options, resolveServiceKey, recover });
    expect(resolveServiceKey).toHaveBeenCalledWith(
      expect.objectContaining({ bound: request, run: expect.objectContaining({ runId }) }),
    );

    const missing = fixture();
    rmSync(missing.directory, { recursive: true, force: true });
    const forbiddenResolve = vi.fn(async () => 'safe-dummy-key');
    await expect(
      cleanupCloudRun({ ...missing, resolveServiceKey: forbiddenResolve }),
    ).rejects.toThrow();
    expect(forbiddenResolve).not.toHaveBeenCalled();
  });
  it('does not publish an ownership journal claiming another run', () => {
    const options = fixture();
    writeFileSync(
      join(options.directory, 'evidence', 'users', `${userId}.json`),
      JSON.stringify({ runId: userId, userId, status: 'created', secret: 'PRIVATE_SECRET' }),
    );
    expect(publishCloudEvidence(options).users).toEqual([]);
    expect(readFileSync(join(options.destination, 'preview.json'), 'utf8')).not.toContain(
      'PRIVATE_',
    );
  });
});
