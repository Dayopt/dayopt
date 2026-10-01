import { describe, expect, it, vi } from 'vitest';

import { terminatePreviewFixtureBranch } from './preview-fixture-termination.mjs';

const intent = {
  schemaVersion: 1,
  repository: 'Dayopt/dayopt',
  workflow: '.github/workflows/ci.yml',
  workflowRef: 'refs/heads/integration',
  workflowSha: 'a'.repeat(40),
  sourceRunId: 123,
  sourceAttempt: 1,
  runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: '2026-09-30T01:00:00.000Z',
  userIds: {
    desktop: '11111111-1111-4111-8111-111111111111',
    mobile: '22222222-2222-4222-8222-222222222222',
  },
  request: {
    sha: 'b'.repeat(40),
    deploymentId: 'dpl_example123',
    prNumber: 2954,
    branchName: 'codex/example',
    databaseMode: 'ephemeral',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    supabaseBranchId: '33333333-3333-4333-8333-333333333333',
  },
};
const branch = {
  name: 'pr-2954-preview',
  id: intent.request.supabaseBranchId,
  project_ref: intent.request.supabaseProjectRef,
  parent_project_ref: 'yvglwblxrnrenfifsnje',
  persistent: false,
  is_default: false,
  with_data: false,
  git_branch: intent.request.branchName,
  pr_number: 2954,
};
function world() {
  let ticks = 0;
  const queue = [
    Response.json([branch]),
    Response.json({ ...branch, preview_project_status: 'UNKNOWN' }),
    Response.json({ message: 'ok' }),
    Response.json({ ...branch, preview_project_status: 'REMOVED' }),
  ];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, _init) => {
    const result = queue.shift();
    if (!result) throw new Error('unexpected provider request');
    return result;
  });
  return {
    queue,
    fetchImpl,
    options: {
      intent,
      token: 'test-provider-token',
      fetchImpl,
      wait: async (duration: number) => {
        ticks += duration;
      },
      elapsed: () => ticks,
    },
  };
}

describe('owned Preview database termination', () => {
  // Protects the exact owned branch and positive provider terminal proof.
  it('deletes only the bound ephemeral branch and returns the observed REMOVED state', async () => {
    const w = world();
    const result = await terminatePreviewFixtureBranch(w.options);
    expect(result).toEqual({
      status: 'terminated',
      runId: intent.runId,
      supabaseBranchId: intent.request.supabaseBranchId,
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      providerStatus: 'REMOVED',
    });
    expect(w.fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.supabase.com/v1/projects/yvglwblxrnrenfifsnje/branches', 'GET'],
      ['https://api.supabase.com/v1/projects/yvglwblxrnrenfifsnje/branches/pr-2954-preview', 'GET'],
      [
        'https://api.supabase.com/v1/branches/33333333-3333-4333-8333-333333333333?force=true',
        'DELETE',
      ],
      ['https://api.supabase.com/v1/projects/yvglwblxrnrenfifsnje/branches/pr-2954-preview', 'GET'],
    ]);
    for (const [, init] of w.fetchImpl.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-provider-token' });
    }
    expect(JSON.stringify(result)).not.toContain('test-provider-token');
  });

  // Protects shared/Production DBs before any provider operation.
  it.each(['shared', 'production'])('rejects %s bindings without any request', async (mode) => {
    const w = world();
    const request =
      mode === 'shared'
        ? {
            ...intent.request,
            databaseMode: 'shared',
            supabaseProjectRef: 'tilwaprottpyhlfoggbb',
            supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
          }
        : { ...intent.request, supabaseProjectRef: 'yvglwblxrnrenfifsnje' };
    await expect(
      terminatePreviewFixtureBranch({ ...w.options, intent: { ...intent, request } }),
    ).rejects.toThrow('termination is unconfirmed');
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });

  // Protects foreign branches, cloned data, identity changes and persistent environments.
  it.each([
    { persistent: true },
    { is_default: true },
    { with_data: true },
    { pr_number: 999 },
    { git_branch: 'codex/foreign' },
    { project_ref: 'bbbbbbbbbbbbbbbbbbbb' },
    { parent_project_ref: 'bbbbbbbbbbbbbbbbbbbb' },
    { id: '44444444-4444-4444-8444-444444444444' },
  ])('refuses ownership drift before DELETE: %j', async (change) => {
    const w = world();
    w.queue[0] = Response.json([{ ...branch, ...change }]);
    await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
      'termination is unconfirmed',
    );
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Protects against missing/ambiguous inventory being treated as cleanup success.
  it.each([{ rows: [] }, { rows: [branch, branch] }])(
    'refuses missing or duplicate branch ownership',
    async ({ rows }) => {
      const w = world();
      w.queue[0] = Response.json(rows);
      await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
        'termination is unconfirmed',
      );
      expect(w.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  // Protects against 404/authorization/network errors being mistaken for DB termination.
  it.each([404, 403, 500])('keeps post-delete HTTP %i unconfirmed', async (status) => {
    const w = world();
    w.queue[3] = new Response('provider-secret-body', { status });
    await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
      'termination is unconfirmed',
    );
    expect(w.fetchImpl).toHaveBeenCalledTimes(4);
  });

  // Protects against a successful DELETE acknowledgement without terminal state.
  it('does not report success while the provider still returns GOING_DOWN', async () => {
    const w = world();
    w.queue.splice(
      3,
      1,
      ...Array.from({ length: 30 }, () =>
        Response.json({
          ...branch,
          preview_project_status: 'GOING_DOWN',
        }),
      ),
    );
    await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
      'termination is unconfirmed',
    );
    expect(w.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(w.fetchImpl).toHaveBeenCalledTimes(33);
  });

  // Protects against the provider returning a different project after DELETE.
  it('rejects mismatched terminal project identity', async () => {
    const w = world();
    w.queue[3] = Response.json({
      ...branch,
      project_ref: 'foreign',
      preview_project_status: 'REMOVED',
    });
    await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
      'termination is unconfirmed',
    );
  });

  it.each([
    { name: 'foreign' },
    { persistent: true },
    { git_branch: 'codex/foreign' },
    { pr_number: 999 },
    { parent_project_ref: 'bbbbbbbbbbbbbbbbbbbb' },
  ])('rejects terminal branch ownership drift: %j', async (change) => {
    const w = world();
    w.queue[3] = Response.json({ ...branch, ...change, preview_project_status: 'REMOVED' });
    await expect(terminatePreviewFixtureBranch(w.options)).rejects.toThrow(
      'termination is unconfirmed',
    );
  });
});
