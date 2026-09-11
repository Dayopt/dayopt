/**
 * GDPR Router Integration Tests
 *
 * 実際のSupabaseを使用した統合テスト
 * デフォルトはPreview Supabase。USE_LOCAL_DB=true でローカルDBにフォールバック
 * GDPR準拠機能のテスト:
 * - データエクスポート（Right to Data Portability）
 * - アカウント削除（Right to be Forgotten）
 *
 * 実行方法:
 * 1. supabase start
 * 2. npm run test:integration
 *
 * @see Issue - テストカバレッジ改善（Phase 4）
 */

import { createClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createUserRouter } from '@/features/auth/server/router';
import type { Database } from '@/lib/database';
import { createTestCaller } from '@/lib/test/trpc-test-helpers';
import type { Context } from '@/lib/trpc/procedures';

// 環境変数からSupabase接続情報を取得
const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SUPABASE_URL =
  process.env.USE_LOCAL_DB === 'true'
    ? LOCAL_DB_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_DB_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// テスト用のユーザーID（UUID形式が必須）
const TEST_USER_ID = crypto.randomUUID();

// テストをスキップするかどうか（CI環境でSupabaseが起動していない場合）
// 他の integration suite と同じ gate を使う。`SKIP_INTEGRATION_TESTS` は repo の
// どこにも設定されておらず、この 5 ファイルだけが別 env を見ていた（#2647）。
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const userRouter = createUserRouter({
  beforeIdentityDeletion: async () => ({ status: 'completed' }),
});

describe.skipIf(!RUN_LOCAL)('GDPR Router Integration', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let supabase: ReturnType<typeof createClient<Database>>;
  let ctx: Context;

  const TEST_EMAIL = `gdpr-test-${TEST_USER_ID}@example.com`;
  const TEST_PASSWORD = 'test-password-123';

  beforeAll(async () => {
    // Admin Supabaseクライアントを作成（ユーザー作成・削除用）
    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // テスト用ユーザーをauth.usersに作成（Admin API使用）
    const { error: authError } = await adminSupabase.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `gdpr_test_${Date.now()}` },
      app_metadata: {},
      id: TEST_USER_ID,
    });

    if (authError && !authError.message.includes('already exists')) {
      throw new Error(`Failed to create test user: ${authError.message}`);
    }

    // profilesテーブルにレコード作成
    await adminSupabase.from('profiles').upsert({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // テストユーザーとしてサインインしたクライアントを作成
    supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // テストユーザーとしてサインイン
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    if (signInError) {
      throw new Error(`Failed to sign in test user: ${signInError.message}`);
    }

    // テストデータを作成（エクスポートテスト用）
    await adminSupabase.from('activities').insert({
      user_id: TEST_USER_ID,
      name: 'GDPR Test Activity',
    });

    await adminSupabase.from('plans').insert({
      user_id: TEST_USER_ID,
      title: 'GDPR Test Plan',
      start_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      end_at: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
    });

    await adminSupabase.from('records').insert({
      user_id: TEST_USER_ID,
      title: 'GDPR Test Record',
      start_at: '2026-01-03T09:00:00Z',
      end_at: '2026-01-03T10:00:00Z',
    });

    const { error: settingsError } = await adminSupabase.from('user_settings').insert({
      user_id: TEST_USER_ID,
      timezone: 'Asia/Tokyo',
    });
    expect(settingsError).toBeNull();
  });

  afterAll(async () => {
    if (supabase) {
      // サインアウト
      await supabase.auth.signOut();
    }

    if (!adminSupabase) return;

    // テストデータをクリーンアップ
    await adminSupabase.from('records').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('plans').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('activities').delete().eq('user_id', TEST_USER_ID);
    await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);

    // テスト用ユーザーを削除（auth.usersから削除するとprofilesもカスケード削除される）
    await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
  });

  beforeEach(() => {
    // 各テストでコンテキストを初期化
    ctx = {
      req: {
        headers: {},
        cookies: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as Context['req'],
      res: {
        setHeader: () => {},
        end: () => {},
      } as unknown as Context['res'],
      userId: TEST_USER_ID,
      sessionId: 'test-session-id',
      mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal1' },
      supabase: supabase,
      authMode: 'session' as const,
    };
  });

  describe('Data Export (Right to Data Portability)', () => {
    it('should export user data successfully', async () => {
      const caller = createTestCaller(userRouter, ctx);

      const result = await caller.exportData();

      expect(result).toBeDefined();
      expect(result.userId).toBe(TEST_USER_ID);
      expect(result.exportedAt).toBeDefined();
      expect(result.data).toBeDefined();

      // エクスポートデータの構造を確認
      expect(result.data).toHaveProperty('profile');
      expect(result.data).toHaveProperty('plans');
      expect(result.data).toHaveProperty('records');
      expect(result.data).toHaveProperty('activities');
      expect(result.data).toHaveProperty('userSettings');
    });

    it('should include user plans and records in export', async () => {
      const caller = createTestCaller(userRouter, ctx);

      const result = await caller.exportData();

      expect(Array.isArray(result.data.plans)).toBe(true);
      expect(Array.isArray(result.data.records)).toBe(true);
      const testPlan = result.data.plans.find(
        (p: { title?: string }) => p.title === 'GDPR Test Plan',
      );
      expect(testPlan).toBeDefined();
      const testRecord = result.data.records.find(
        (record: { title?: string }) => record.title === 'GDPR Test Record',
      );
      expect(testRecord).toBeDefined();
      expect(testRecord).not.toHaveProperty('fulfillment_score');
      expect(result.data.userSettings).not.toBeNull();
      expect(result.data.userSettings).not.toHaveProperty('chronotype_settings');
    });

    it('should include user activities in export', async () => {
      const caller = createTestCaller(userRouter, ctx);

      const result = await caller.exportData();

      expect(Array.isArray(result.data.activities)).toBe(true);
      // テストで作成したアクティビティが含まれている
      const testActivity = result.data.activities.find(
        (a: { name?: string }) => a.name === 'GDPR Test Activity',
      );
      expect(testActivity).toBeDefined();
    });

    it('should not allow access without authentication', async () => {
      const unauthenticatedCtx = {
        ...ctx,
        userId: undefined,
      };
      const caller = createTestCaller(userRouter, unauthenticatedCtx);

      await expect(caller.exportData()).rejects.toThrow(TRPCError);
    });
  });

  describe('Account Deletion (Right to be Forgotten)', () => {
    // 注意: アカウント削除は実際に削除されるため、別のテストユーザーを使用
    let deleteTestUserId: string;
    let deleteTestEmail: string;
    let deleteTestPassword: string;
    let deleteTestSupabase: ReturnType<typeof createClient<Database>>;
    let deleteTestCtx: Context;
    let deleteTestUserDeleted = false;

    beforeAll(async () => {
      // 削除テスト用の別ユーザーを作成
      deleteTestUserId = crypto.randomUUID();
      deleteTestEmail = `delete-test-${deleteTestUserId}@example.com`;
      deleteTestPassword = 'delete-password-123';

      const { error: authError } = await adminSupabase.auth.admin.createUser({
        email: deleteTestEmail,
        password: deleteTestPassword,
        email_confirm: true,
        id: deleteTestUserId,
      });

      if (authError && !authError.message.includes('already exists')) {
        throw new Error(`Failed to create delete test user: ${authError.message}`);
      }

      await adminSupabase.from('profiles').upsert({
        id: deleteTestUserId,
        email: deleteTestEmail,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 削除テスト用ユーザーでサインイン
      deleteTestSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });

      await deleteTestSupabase.auth.signInWithPassword({
        email: deleteTestEmail,
        password: deleteTestPassword,
      });
    });

    afterAll(async () => {
      if (deleteTestSupabase) {
        await deleteTestSupabase.auth.signOut();
      }

      if (!adminSupabase || !deleteTestUserId || deleteTestUserDeleted) return;

      // 削除テスト用ユーザーのクリーンアップ
      await adminSupabase.auth.admin.deleteUser(deleteTestUserId);
    });

    beforeEach(() => {
      deleteTestCtx = {
        req: {
          headers: {},
          cookies: {},
          socket: { remoteAddress: '127.0.0.1' },
        } as Context['req'],
        res: {
          setHeader: () => {},
          end: () => {},
        } as unknown as Context['res'],
        userId: deleteTestUserId,
        sessionId: 'delete-test-session-id',
        mfaAssurance: { currentLevel: 'aal1', nextLevel: 'aal1' },
        supabase: deleteTestSupabase,
        authMode: 'session' as const,
      };
    });

    it('should reject deletion with incorrect password', async () => {
      const caller = createTestCaller(userRouter, deleteTestCtx);

      await expect(
        caller.deleteAccount({
          password: 'wrong-password',
          confirmText: 'DELETE',
        }),
      ).rejects.toThrow();
    });

    it('should reject deletion with incorrect confirmation text', async () => {
      const caller = createTestCaller(userRouter, deleteTestCtx);

      await expect(
        caller.deleteAccount({
          password: deleteTestPassword,
          // @ts-expect-error - テスト目的で意図的に間違った値を渡す
          confirmText: 'WRONG',
        }),
      ).rejects.toThrow();
    });

    it('should reject deletion without authentication', async () => {
      const unauthenticatedCtx = {
        ...deleteTestCtx,
        userId: undefined,
      };
      const caller = createTestCaller(userRouter, unauthenticatedCtx);

      await expect(
        caller.deleteAccount({
          password: deleteTestPassword,
          confirmText: 'DELETE',
        }),
      ).rejects.toThrow(TRPCError);
    });

    it('should delete account immediately with correct credentials', async () => {
      const caller = createTestCaller(userRouter, deleteTestCtx);

      const result = await caller.deleteAccount({
        password: deleteTestPassword,
        confirmText: 'DELETE',
      });

      expect(result.success).toBe(true);

      const { data } = await adminSupabase.auth.admin.getUserById(deleteTestUserId);
      expect(data.user).toBeNull();
      deleteTestUserDeleted = true;
    });

    // #2028: 「削除→同メール再登録失敗」の production 報告を調査した結果、原因は
    // 削除フローとは無関係な production incident（#2031、Turnstile secret 無効化）と
    // 判明し、削除フロー自体のバグは無かった（ローカル実測でも再現せず）。
    // 診断目的ではなく、削除済みメールアドレスが再利用可能という現状の保証を
    // 契約として固定するために追加する（直前のテストで対象ユーザーは削除済み）。
    it('削除済みメールアドレスは同一アドレスで signup できる（#2028）', async () => {
      expect(deleteTestUserDeleted).toBe(true);

      const freshSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data, error } = await freshSupabase.auth.signUp({
        email: deleteTestEmail,
        password: 'new-password-456',
      });

      expect(error).toBeNull();
      expect(data.user).not.toBeNull();
      expect(data.user?.id).not.toBe(deleteTestUserId);

      if (data.user?.id) {
        await adminSupabase.auth.admin.deleteUser(data.user.id);
      }
    });
  });

  describe('Data Export Format', () => {
    it('should export data in JSON-serializable format', async () => {
      const caller = createTestCaller(userRouter, ctx);

      const result = await caller.exportData();

      // JSON.stringifyでエラーが発生しないことを確認
      const jsonString = JSON.stringify(result);
      expect(jsonString).toBeDefined();

      // JSONとしてパースできることを確認
      const parsed = JSON.parse(jsonString);
      expect(parsed.userId).toBe(TEST_USER_ID);
    });

    it('should include ISO 8601 formatted timestamps', async () => {
      const caller = createTestCaller(userRouter, ctx);

      const result = await caller.exportData();

      // exportedAtがISO 8601形式であることを確認
      const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
      expect(result.exportedAt).toMatch(dateRegex);
    });
  });
});
