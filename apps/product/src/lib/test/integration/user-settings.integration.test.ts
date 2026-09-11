/**
 * UserSettings Router Integration Tests
 *
 * ユーザー設定の統合テスト
 * - 設定取得
 * - 設定更新（upsert）
 * - バリデーション
 */

import { createClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { userSettingsRouter } from '@/features/settings/server/router';
import type { Database } from '@/lib/database';
import { createTestCaller } from '@/lib/test/trpc-test-helpers';
import type { Context } from '@/lib/trpc/procedures';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SUPABASE_URL =
  process.env.USE_LOCAL_DB === 'true'
    ? LOCAL_DB_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_DB_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const TEST_USER_ID = crypto.randomUUID();
// 他の integration suite と同じ gate を使う。`SKIP_INTEGRATION_TESTS` は repo の
// どこにも設定されておらず、この 5 ファイルだけが別 env を見ていた（#2647）。
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

describe.skipIf(!RUN_LOCAL)('UserSettings Router Integration', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let supabase: ReturnType<typeof createClient<Database>>;
  let ctx: Context;

  const TEST_EMAIL = `test-settings-${TEST_USER_ID}@example.com`;
  const TEST_PASSWORD = 'test-password-123';

  beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: authError } = await adminSupabase.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `testuser_settings_${Date.now()}` },
      id: TEST_USER_ID,
    });

    if (authError && !authError.message.includes('already exists')) {
      throw new Error(`Failed to create test user: ${authError.message}`);
    }

    await adminSupabase.from('profiles').upsert({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    supabase = createClient<Database>(
      SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    if (signInError) {
      throw new Error(`Failed to sign in test user: ${signInError.message}`);
    }
  });

  afterAll(async () => {
    await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);
    await supabase.auth.signOut();
    await adminSupabase.auth.admin.deleteUser(TEST_USER_ID);
  });

  beforeEach(() => {
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

  describe('Get Settings', () => {
    it('should return null for new user without settings', async () => {
      // 既存の設定を削除
      await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);

      const caller = createTestCaller(userSettingsRouter, ctx);
      const result = await caller.get();

      expect(result).toBeNull();
    });

    it('should return settings after update', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      // 設定を更新
      await caller.update({
        timezone: 'Asia/Tokyo',
        timeFormat: '24h',
      });

      const result = await caller.get();

      expect(result).toBeDefined();
      expect(result?.timezone).toBe('Asia/Tokyo');
      expect(result?.timeFormat).toBe('24h');
      expect(result).not.toHaveProperty('chronotype_settings');
    });

    it('should create and regenerate an iCal feed token', async () => {
      await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);

      const caller = createTestCaller(userSettingsRouter, ctx);
      await caller.update({ timezone: 'Asia/Tokyo' });

      const initial = await caller.getICalToken();
      expect(initial.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const regenerated = await caller.regenerateICalToken();
      expect(regenerated.token).not.toBe(initial.token);

      const current = await caller.getICalToken();
      expect(current.token).toBe(regenerated.token);
    });
  });

  describe('Update Settings', () => {
    it('should create settings for new user', async () => {
      // 既存の設定を削除
      await adminSupabase.from('user_settings').delete().eq('user_id', TEST_USER_ID);

      const caller = createTestCaller(userSettingsRouter, ctx);

      const result = await caller.update({
        timezone: 'America/New_York',
        weekStartsOn: 0,
      });

      expect(result.success).toBe(true);
    });

    it('should update existing settings', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      // 初回設定
      await caller.update({
        timeFormat: '24h',
      });

      // 更新
      const result = await caller.update({
        timeFormat: '12h',
      });

      expect(result.success).toBe(true);

      // 確認
      const settings = await caller.get();
      expect(settings?.timeFormat).toBe('12h');
    });

    it('should update timezone settings', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await caller.update({
        timezone: 'Europe/London',
      });

      const settings = await caller.get();
      expect(settings?.timezone).toBe('Europe/London');
    });

    it('should update week settings', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await caller.update({
        weekStartsOn: 1,
        showWeekends: false,
        showWeekNumbers: true,
      });

      const settings = await caller.get();
      expect(settings?.weekStartsOn).toBe(1);
      expect(settings?.showWeekends).toBe(false);
      expect(settings?.showWeekNumbers).toBe(true);
    });

    it('should update task settings', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await caller.update({
        defaultDuration: 60,
      });

      const settings = await caller.get();
      expect(settings?.defaultDuration).toBe(60);
    });

    it('should update theme settings', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await caller.update({
        theme: 'dark',
      });

      const settings = await caller.get();
      expect(settings?.theme).toBe('dark');
    });
  });

  describe('Validation', () => {
    it('should reject invalid time format', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await expect(
        caller.update({
          // @ts-expect-error - Testing invalid input
          timeFormat: 'invalid',
        }),
      ).rejects.toThrow();
    });

    it('should reject invalid week starts on value', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await expect(
        caller.update({
          // @ts-expect-error - Testing invalid input
          weekStartsOn: 5,
        }),
      ).rejects.toThrow();
    });

    it('should reject default duration below minimum', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await expect(
        caller.update({
          defaultDuration: 1, // minimum is 5
        }),
      ).rejects.toThrow();
    });

    it('should reject default duration above maximum', async () => {
      const caller = createTestCaller(userSettingsRouter, ctx);

      await expect(
        caller.update({
          defaultDuration: 500, // maximum is 480
        }),
      ).rejects.toThrow();
    });
  });

  describe('Authorization', () => {
    it('should not allow unauthenticated access to get', async () => {
      const unauthenticatedCtx = { ...ctx, userId: undefined };
      const caller = createTestCaller(userSettingsRouter, unauthenticatedCtx);

      await expect(caller.get()).rejects.toThrow(TRPCError);
    });

    it('should not allow unauthenticated access to update', async () => {
      const unauthenticatedCtx = { ...ctx, userId: undefined };
      const caller = createTestCaller(userSettingsRouter, unauthenticatedCtx);

      await expect(caller.update({ timezone: 'UTC' })).rejects.toThrow(TRPCError);
    });
  });
});
