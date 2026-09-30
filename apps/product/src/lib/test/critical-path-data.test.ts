import { describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ expect: vi.fn() }));

import {
  cleanupCriticalPathUser,
  createCriticalPathIdentity,
  seedCriticalPathUser,
} from './e2e/critical-path-fixture';

const identity = {
  userId: 'fc521290-1ab5-4fc2-9fb4-dee96b6e01c9',
  email: 'synthetic@example.com',
  password: 'synthetic-password',
  activityName: 'Synthetic activity',
  categoryName: 'Synthetic category',
};

function fakeAdmin(failure = '') {
  const calls: string[] = [];
  const result = (operation: string) => {
    calls.push(operation);
    if (failure === `throw:${operation}`) throw new Error('private-diagnostic');
    return {
      data: { id: operation === 'createUser' ? identity.userId : 'category-id' },
      error: operation === failure ? { message: 'private-diagnostic' } : null,
    };
  };
  const admin = {
    auth: {
      admin: {
        createUser: vi.fn(async () => {
          const response = result('createUser');
          return { ...response, data: { user: { id: identity.userId } } };
        }),
        deleteUser: vi.fn(async () => result('deleteUser')),
      },
    },
    from: (table: string) => ({
      upsert: async () => result(`upsert:${table}`),
      insert: () => ({
        ...result(`insert:${table}`),
        select: () => ({ single: async () => ({ data: { id: 'category-id' }, error: null }) }),
      }),
      delete: () => ({
        eq: async (column: string, id: string) => {
          expect(id).toBe(identity.userId);
          expect(column).toBe(table === 'profiles' ? 'id' : 'user_id');
          return result(`delete:${table}`);
        },
      }),
    }),
  };
  return { admin: admin as never, calls };
}

// e2e/ 配下は Vitest の収集対象外なので、共有fixtureの回帰テストはこの階層へ置く。
describe('critical path data lifecycle', () => {
  it('ユーザーとpasswordを実行ごとに分離する', () => {
    const first = createCriticalPathIdentity('unit');
    const second = createCriticalPathIdentity('unit');
    expect(first.userId).not.toBe(second.userId);
    expect(first.email).not.toBe(second.email);
    expect(first.password).not.toBe(second.password);
    expect(first.password.length).toBeGreaterThanOrEqual(32);
  });
  it.each(['upsert:profiles', 'upsert:user_settings'])(
    'setup失敗を隠さない: %s',
    async (failure) => {
      const { admin } = fakeAdmin(failure);
      await expect(seedCriticalPathUser(admin, identity, 'synthetic')).rejects.toThrow();
    },
  );

  it.each(['delete:records', 'throw:delete:records', 'deleteUser'])(
    'cleanup失敗を報告し、残りも試みる: %s',
    async (failure) => {
      const { admin, calls } = fakeAdmin(failure);
      await seedCriticalPathUser(admin, identity, 'synthetic');
      await expect(cleanupCriticalPathUser(admin, identity.userId)).rejects.toThrow(
        /^E2E synthetic cleanup failed for fc521290-1ab5-4fc2-9fb4-dee96b6e01c9: (records|auth)$/,
      );
      expect(calls).toContain('deleteUser');
    },
  );

  it('setup途中の失敗でも作成済みユーザーを回収する', async () => {
    const { admin, calls } = fakeAdmin('upsert:profiles');
    await expect(seedCriticalPathUser(admin, identity, 'synthetic')).rejects.toThrow(
      'profile setup failed',
    );
    await cleanupCriticalPathUser(admin, identity.userId);
    expect(calls).toContain('deleteUser');
    expect(calls).not.toContain('insert:activities');
  });

  it('別clientで所有していないユーザーは削除しない', async () => {
    const first = fakeAdmin();
    const second = fakeAdmin();
    await seedCriticalPathUser(first.admin, identity, 'synthetic');
    await cleanupCriticalPathUser(second.admin, identity.userId);
    expect(second.calls).toEqual([]);
  });

  it('作成に失敗したユーザーは削除しない', async () => {
    const { admin, calls } = fakeAdmin('createUser');
    await expect(seedCriticalPathUser(admin, identity, 'synthetic')).rejects.toThrow();
    await cleanupCriticalPathUser(admin, identity.userId);
    expect(calls).toEqual(['createUser']);
  });

  it('作成したユーザーだけをcleanupし、成功後は重複削除しない', async () => {
    const { admin, calls } = fakeAdmin();
    await seedCriticalPathUser(admin, identity, 'synthetic');
    await cleanupCriticalPathUser(admin, identity.userId);
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(7);
    await cleanupCriticalPathUser(admin, identity.userId);
    expect(calls.filter((call) => call.startsWith('delete'))).toHaveLength(7);
  });
});
