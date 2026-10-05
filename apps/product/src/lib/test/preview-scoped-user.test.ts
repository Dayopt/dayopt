import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => sdk);

import { createScopedTestUser, deleteScopedTestUser } from './e2e/create-scoped-test-user';

const RUN = '11111111-1111-4111-8111-111111111111';
const DESKTOP = '22222222-2222-4222-8222-222222222222';
const MOBILE = '33333333-3333-4333-8333-333333333333';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';
let directory: string;
let admin: ReturnType<typeof mockAdmin>;

function mockAdmin() {
  const removed: { table: string; column: string; id: string }[] = [];
  const createUser = vi.fn(async (input: { id?: string }) => ({
    data: { user: { id: input.id ?? crypto.randomUUID() } },
    error: null,
  }));
  const deleteUser = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => ({
    upsert: vi.fn(async () => ({ error: null })),
    delete: () => ({
      eq: async (column: string, id: string) => {
        removed.push({ table, column, id });
        return { error: null };
      },
    }),
  }));
  return { auth: { admin: { createUser, deleteUser } }, from, removed };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'preview-scoped-user-'));
  for (const [key, value] of Object.entries({
    E2E_PREVIEW_CLOUD_INTENT: '1',
    E2E_PREVIEW_RUN_ID: RUN,
    E2E_PREVIEW_DESKTOP_USER_ID: DESKTOP,
    E2E_PREVIEW_MOBILE_USER_ID: MOBILE,
    E2E_PREVIEW_EVIDENCE_DIR: directory,
  }))
    vi.stubEnv(key, value);
  admin = mockAdmin();
  sdk.createClient.mockReturnValue(admin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function journal(id: string) {
  return JSON.parse(readFileSync(join(directory, 'users', `${id}.json`), 'utf8'));
}

describe('owned scoped Preview users', () => {
  it.each([
    ['auth', 'chromium', DESKTOP, 'critical-path'],
    ['initial-load', 'Mobile Chrome', MOBILE, 'mobile-critical-path'],
  ])(
    'binds %s on %s to the allocated user and journals before Auth creation',
    async (scope, project, id, prefix) => {
      admin.auth.admin.createUser.mockImplementationOnce(async (input) => {
        expect(journal(id)).toMatchObject({ runId: RUN, userId: id, status: 'creating' });
        return { data: { user: { id: input.id! } }, error: null };
      });
      const user = await createScopedTestUser(URL, 'synthetic-admin', scope, project);
      expect(user.userId).toBe(id);
      expect(user.email).toMatch(new RegExp(`^${prefix}-[a-f0-9-]{36}@example.com$`));
      expect(admin.auth.admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id,
          app_metadata: { e2e_run_id: RUN },
          email_confirm: true,
        }),
      );
      expect(journal(id).status).toBe('created');
      await deleteScopedTestUser(URL, 'synthetic-admin', id);
      expect(admin.removed).toHaveLength(6);
      expect(admin.removed.every((row) => row.id === id)).toBe(true);
      expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(id);
      expect(journal(id).status).toBe('deleted');
    },
  );

  it.each([
    ['unreviewed scope', 'account-deletion', 'chromium'],
    ['unknown project', 'auth', 'webkit'],
  ])('rejects %s before Auth creation', async (_reason, scope, project) => {
    await expect(createScopedTestUser(URL, 'synthetic-admin', scope, project)).rejects.toThrow();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('requires a durable journal before Cloud creation', async () => {
    vi.stubEnv('E2E_PREVIEW_EVIDENCE_DIR', '');
    await expect(
      createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium'),
    ).rejects.toThrow();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('never cleans a collision or an unconfirmed creation', async () => {
    admin.auth.admin.createUser.mockResolvedValueOnce({
      data: { user: { id: MOBILE } },
      error: null,
    });
    await expect(
      createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium'),
    ).rejects.toThrow();
    await deleteScopedTestUser(URL, 'synthetic-admin', DESKTOP);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(admin.removed).toHaveLength(0);
    expect(journal(DESKTOP).status).toBe('creation-unconfirmed');
  });

  it('leaves cleanup failure in the ownership journal and fails the suite', async () => {
    await createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium');
    admin.auth.admin.deleteUser.mockRejectedValueOnce(new Error('private-provider-error'));
    await expect(deleteScopedTestUser(URL, 'synthetic-admin', DESKTOP)).rejects.toThrow(
      'E2E synthetic cleanup failed',
    );
    expect(journal(DESKTOP).status).toBe('cleanup-failed');
    await deleteScopedTestUser(URL, 'synthetic-admin', DESKTOP);
  });

  it('does not clean an arbitrary user outside this fixture ownership', async () => {
    await deleteScopedTestUser(URL, 'synthetic-admin', crypto.randomUUID());
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(admin.removed).toHaveLength(0);
  });

  it('reclaims an owned user when profile setup fails before returning the fixture', async () => {
    admin.from.mockImplementationOnce(() => {
      throw new Error('private-profile-error');
    });
    await expect(createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium')).rejects.toThrow(
      'E2E synthetic profile setup failed',
    );
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(DESKTOP);
    expect(journal(DESKTOP).status).toBe('deleted');
  });

  it('keeps unconfirmed Auth failures recoverable and does not claim local cleanup ownership', async () => {
    admin.auth.admin.createUser.mockRejectedValueOnce(new Error('private-auth-error'));
    await expect(createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium')).rejects.toThrow(
      'E2E synthetic user creation failed',
    );
    await deleteScopedTestUser(URL, 'synthetic-admin', DESKTOP);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(journal(DESKTOP).status).toBe('creation-unconfirmed');
  });

  it('requires the original target/key for owned cleanup', async () => {
    await createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium');
    await deleteScopedTestUser('https://other.example.com', 'synthetic-admin', DESKTOP);
    await deleteScopedTestUser(URL, 'different-key', DESKTOP);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    await deleteScopedTestUser(URL, 'synthetic-admin', DESKTOP);
  });

  it('reuses the allocated ID only after previous scoped cleanup has succeeded', async () => {
    const first = await createScopedTestUser(URL, 'synthetic-admin', 'auth', 'chromium');
    await expect(createScopedTestUser(URL, 'synthetic-admin', 'a11y', 'chromium')).rejects.toThrow(
      'still owned',
    );
    expect(admin.auth.admin.createUser).toHaveBeenCalledOnce();
    await deleteScopedTestUser(URL, 'synthetic-admin', first.userId);
    const next = await createScopedTestUser(URL, 'synthetic-admin', 'a11y', 'chromium');
    expect(next.userId).toBe(first.userId);
    expect(next.email).not.toBe(first.email);
    expect(journal(DESKTOP).status).toBe('created');
    await deleteScopedTestUser(URL, 'synthetic-admin', next.userId);
  });

  it('keeps random local users and permits existing local-only scopes', async () => {
    vi.stubEnv('E2E_PREVIEW_CLOUD_INTENT', '0');
    vi.stubEnv('E2E_PREVIEW_EVIDENCE_DIR', '');
    const user = await createScopedTestUser(
      'http://127.0.0.1:54321',
      'synthetic-admin',
      'account-deletion',
    );
    expect(user.userId).not.toBe(DESKTOP);
    expect(user.userId).not.toBe(MOBILE);
    expect(user.email).toMatch(/^e2e-account-deletion-/);
    const input = admin.auth.admin.createUser.mock.calls[0]![0];
    expect(input).not.toHaveProperty('app_metadata');
    await deleteScopedTestUser('http://127.0.0.1:54321', 'synthetic-admin', user.userId);
  });
});
