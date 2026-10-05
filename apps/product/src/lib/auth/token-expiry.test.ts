import { describe, expect, it } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';

import { createCallerFactory, createTRPCRouter, protectedProcedure } from '../trpc/procedures';

// protectedProcedure の認証ガードテスト用ルーター
const authTestRouter = createTRPCRouter({
  whoami: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
  plans: createTRPCRouter({
    list: protectedProcedure.query(() => 'plans'),
  }),
  records: createTRPCRouter({
    list: protectedProcedure.query(() => 'records'),
  }),
  userSettings: createTRPCRouter({
    update: protectedProcedure.mutation(() => 'updated'),
  }),
  user: createTRPCRouter({
    verifyRecoveryCode: protectedProcedure.mutation(() => 'recovered'),
  }),
});

const createCaller = createCallerFactory(authTestRouter);

describe('tRPCのセッション・OAuth認可境界', () => {
  describe('protectedProcedure 認証ガード', () => {
    it('userId がない場合は UNAUTHORIZED', async () => {
      const ctx = createMockContext({ userId: undefined });
      const caller = createCaller(ctx as never);

      await expect(caller.whoami()).rejects.toThrow(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      );
    });

    it('userId がある場合は通過する', async () => {
      const ctx = createMockContext({ userId: 'user-1' });
      const caller = createCaller(ctx as never);

      const result = await caller.whoami();
      expect(result.userId).toBe('user-1');
    });

    it('session context にMFA assuranceがない場合はfail closedでFORBIDDEN', async () => {
      const ctx = createMockContext({ userId: 'user-1' });
      ctx.mfaAssurance = undefined;
      const caller = createCaller(ctx as never);

      await expect(caller.whoami()).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      await expect(caller.user.verifyRecoveryCode()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });

    it('MFA無効化直後のaal2→aal1は通過する（#2150）', async () => {
      // JWT由来のcurrentLevelがaal2のまま(token refresh前)、実際のfactor状態
      // から算出したnextLevelが既にaal1になる正常な降格。aal2は要求水準を
      // 満たしている側なので、これを許可しても権限昇格にはならない。
      const ctx = createMockContext({
        userId: 'user-1',
        mfaAssurance: { currentLevel: 'aal2', nextLevel: 'aal1' },
      });
      const caller = createCaller(ctx as never);

      const result = await caller.whoami();
      expect(result.userId).toBe('user-1');
    });

    it('MFA登録済みAAL1セッションはFORBIDDEN', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal2' },
      });
      const caller = createCaller(ctx as never);

      await expect(caller.whoami()).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });

    it('MFA登録済みAAL1セッションでもリカバリーコード検証は通過する', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal2' },
      });
      const caller = createCaller(ctx as never);

      await expect(caller.user.verifyRecoveryCode()).resolves.toBe('recovered');
    });

    it('AAL取得失敗時はfail closedでFORBIDDEN', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        mfaAssurance: { currentLevel: null, nextLevel: null, lookupFailed: true },
      });
      const caller = createCaller(ctx as never);

      await expect(caller.whoami()).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      await expect(caller.user.verifyRecoveryCode()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });

    it('AAL2セッションは通過する', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        mfaAssurance: { currentLevel: 'aal2', nextLevel: 'aal2' },
      });
      const caller = createCaller(ctx as never);

      const result = await caller.whoami();
      expect(result.userId).toBe('user-1');
    });

    it('OAuth read:entries token は read-only の plans.list / records.list だけ通過する', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        authMode: 'oauth',
        oauthClientId: 'claude-ai',
        oauthExecution: 'mcp_internal',
        oauthScopes: ['read:entries'],
      });
      const caller = createCaller(ctx as never);

      await expect(caller.plans.list()).resolves.toBe('plans');
      await expect(caller.records.list()).resolves.toBe('records');
      await expect(caller.userSettings.update()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });

    // OAuth token は MCP endpoint 経由でしか受け付けない。公開 tRPC endpoint へ
    // 同じ token を投げても scope 判定より手前で落ちる。
    it('OAuth token は MCP endpoint 以外から公開 tRPC を通過できない', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        authMode: 'oauth',
        oauthClientId: 'claude-ai',
        oauthScopes: ['read:entries'],
      });
      const caller = createCaller(ctx as never);

      await expect(caller.plans.list()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
      await expect(caller.records.list()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });

    it('OAuth token は scope なしで plans.list / records.list を通過できない', async () => {
      const ctx = createMockContext({
        userId: 'user-1',
        authMode: 'oauth',
        oauthClientId: 'claude-ai',
        oauthExecution: 'mcp_internal',
        oauthScopes: ['read:activities'],
      });
      const caller = createCaller(ctx as never);

      await expect(caller.plans.list()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
      await expect(caller.records.list()).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    });
  });
});
