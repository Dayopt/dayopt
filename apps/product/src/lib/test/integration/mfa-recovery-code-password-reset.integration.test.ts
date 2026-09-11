/**
 * MFA Recovery Code via tRPC (password-reset flow) Integration Test
 *
 * #2013 の risk-reviewer 指摘への対応: unit test は tRPC 層（protectedProcedure の
 * MFA_CHALLENGE_TRPC_PATHS 判定 / mfaAssurance の実算出）を mock しているため、
 * recovery session（aal1）から `user.verifyRecoveryCode` が実際に通ることを担保していない。
 * このテストは実際の local Supabase に対して recovery session を確立し、
 * `resolveSessionAuthContext`（本番と同じ実装）で算出した mfaAssurance を使って
 * protectedProcedure 経由で `verifyRecoveryCode` を呼び、403にならず成功することを固定する。
 *
 * 実行方法:
 * 1. supabase start
 * 2. USE_LOCAL_DB=true pnpm test:integration
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUserRouter } from '@/features/auth/server/router';
import { hashRecoveryCode } from '@/lib/auth/recovery-codes';
import type { Database } from '@/lib/database';
import { generateTotp } from '@/lib/test/totp';
import { createTestCaller } from '@/lib/test/trpc-test-helpers';
import type { Context } from '@/lib/trpc/procedures';
import { createTRPCRouter } from '@/lib/trpc/router';
import { resolveSessionAuthContext } from '@/lib/trpc/session-auth-context';

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

// 他の integration suite と同じ gate を使う。`SKIP_INTEGRATION_TESTS` は repo の
// どこにも設定されておらず、この 5 ファイルだけが別 env を見ていた（#2647）。
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const userRouter = createUserRouter({
  beforeIdentityDeletion: async () => ({ status: 'completed' }),
});
// production の app-router.ts と同じ `user:` namespace でマウントする。
// MFA_CHALLENGE_TRPC_PATHS は完全修飾 path（'user.verifyRecoveryCode'）で判定するため、
// userRouter を直接 caller に渡すと path が 'verifyRecoveryCode' になり判定が正しく検証できない
const testRouter = createTRPCRouter({ user: userRouter });

describe.skipIf(!RUN_LOCAL)('MFA recovery code via tRPC (password-reset flow)', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let userId: string;
  let email: string;
  let plainRecoveryCode: string;

  beforeAll(async () => {
    // RECOVERY_CODE_PEPPER は本番では必須だが local/test では未設定のことがある。
    // hashRecoveryCode は env 未設定時に process.env を直接fallbackで読むため、
    // ここで明示的にセットしてテストを自己完結させる
    process.env.RECOVERY_CODE_PEPPER ??= 'integration-test-pepper-do-not-use-in-production';

    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    userId = crypto.randomUUID();
    email = `mfa-recovery-trpc-${userId}@example.com`;

    const { error: createError } = await adminSupabase.auth.admin.createUser({
      email,
      password: 'initial-password-123',
      email_confirm: true,
      id: userId,
    });
    if (createError) throw new Error(`Failed to create test user: ${createError.message}`);

    // TOTP factor を enroll + verify（本人のセッションで enroll する必要があるため
    // 一時的にパスワードでサインインする）
    const enrollClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await enrollClient.auth.signInWithPassword({ email, password: 'initial-password-123' });

    const { data: enrollData, error: enrollError } = await enrollClient.auth.mfa.enroll({
      factorType: 'totp',
    });
    if (enrollError || !enrollData)
      throw new Error(`Failed to enroll TOTP: ${enrollError?.message}`);

    const { data: challengeData, error: challengeError } = await enrollClient.auth.mfa.challenge({
      factorId: enrollData.id,
    });
    if (challengeError || !challengeData) {
      throw new Error(`Failed to challenge TOTP: ${challengeError?.message}`);
    }

    const totpCode = generateTotp(enrollData.totp.secret);
    const { error: verifyError } = await enrollClient.auth.mfa.verify({
      factorId: enrollData.id,
      challengeId: challengeData.id,
      code: totpCode,
    });
    if (verifyError) throw new Error(`Failed to verify TOTP enrollment: ${verifyError.message}`);
    await enrollClient.auth.signOut();

    // リカバリーコードを1件、実装が読む形式（HMAC-SHA256 pepper付きハッシュ）でDBへ直接投入する
    // charset は紛らわしい文字（I,O,0,1）を除外している（recovery-codes.ts）
    plainRecoveryCode = 'ABCD-2345';
    const { error: insertError } = await adminSupabase.from('mfa_recovery_codes').insert({
      user_id: userId,
      code_hash: hashRecoveryCode(plainRecoveryCode),
    });
    if (insertError) throw new Error(`Failed to seed recovery code: ${insertError.message}`);
  });

  afterAll(async () => {
    if (!adminSupabase || !userId) return;
    await adminSupabase.auth.admin.deleteUser(userId);
  });

  it('recovery session（aal1）から protectedProcedure 経由で verifyRecoveryCode が成功する（403にならない）', async () => {
    // password-reset flow と同じ手段でrecovery sessionを確立する（admin.generateLink → verifyOtp）
    const { data: linkData, error: linkError } = await adminSupabase.auth.admin.generateLink({
      type: 'recovery',
      email,
    });
    if (linkError || !linkData)
      throw new Error(`Failed to generate recovery link: ${linkError?.message}`);

    const recoverySupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: otpData, error: otpError } = await recoverySupabase.auth.verifyOtp({
      type: 'recovery',
      token_hash: linkData.properties.hashed_token,
    });
    if (otpError || !otpData.session) {
      throw new Error(`Failed to establish recovery session: ${otpError?.message}`);
    }

    // 本番と同一の resolveSessionAuthContext で mfaAssurance を実算出する（mock ではない）
    const sessionContext = await resolveSessionAuthContext(recoverySupabase, 'trpc_context');
    expect(sessionContext.userId).toBe(userId);
    // recovery session は aal1 止まり（insufficient_aal の根拠となる状態）であることを確認
    expect(sessionContext.mfaAssurance?.currentLevel).toBe('aal1');
    expect(sessionContext.mfaAssurance?.nextLevel).toBe('aal2');

    const ctx: Context = {
      req: {
        headers: {},
        cookies: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as Context['req'],
      res: {
        setHeader: () => {},
        end: () => {},
      } as unknown as Context['res'],
      userId: sessionContext.userId,
      sessionId: sessionContext.sessionId,
      mfaAssurance: sessionContext.mfaAssurance,
      supabase: recoverySupabase,
      authMode: 'session' as const,
    };

    const caller = createTestCaller(testRouter, ctx);

    // protectedProcedure の MFA_CHALLENGE_TRPC_PATHS 判定を実際に通す（path は
    // production と同じ 'user.verifyRecoveryCode' で評価される）。
    // ここが通らないと本PRの主機能（recovery code経路の自己復旧）はproductionで
    // FORBIDDENになり沈黙する
    const result = await caller.user.verifyRecoveryCode({ code: plainRecoveryCode });
    expect(result.success).toBe(true);

    // recovery-service.ts の既存副作用（verified factor の削除）も実際に起きたことを確認
    const { data: factorsAfter } = await adminSupabase.auth.admin.mfa.listFactors({ userId });
    expect(factorsAfter?.factors?.some((factor) => factor.status === 'verified')).toBe(false);

    await recoverySupabase.auth.signOut();
  });
});
