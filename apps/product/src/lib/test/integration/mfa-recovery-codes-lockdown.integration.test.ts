/**
 * MFA リカバリコード表の認可境界（#2618）
 *
 * `public.mfa_recovery_codes` は「MFA を解除してよいか」という認証判断の根拠なので、
 * 判断される当人（`authenticated` ロール）から読み書きできてはいけない。以前は aal1 の JWT で
 * PostgREST へ直接 INSERT でき、攻撃者が別アカウントで学んだ `code_hash` を被害者の行として
 * 植えてから `user.verifyRecoveryCode` を呼ぶことで MFA を恒久的に迂回できた。
 *
 * grant / RLS の話なので unit test では証明にならない。実 DB に対して
 * 「ブラウザロールで拒否される」「service_role の正規経路は通る」の両方を固定する。
 *
 * 実行方法:
 * 1. supabase start
 * 2. USE_LOCAL_DB=true pnpm test:integration
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { generateTotp } from '@/lib/test/totp';

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

const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

/** grant が無い時に PostgREST / PostgreSQL が返すコード */
const PERMISSION_DENIED = '42501';

describe.skipIf(!RUN_LOCAL)('mfa_recovery_codes の認可境界（#2618）', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let victimClient: ReturnType<typeof createClient<Database>>;
  let attackerClient: ReturnType<typeof createClient<Database>>;
  let victimId: string;
  let attackerId: string;

  beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const createUser = async (label: string) => {
      const id = crypto.randomUUID();
      const email = `mfa-lockdown-${label}-${id}@example.com`;
      const password = 'lockdown-password-123';
      const { error } = await adminSupabase.auth.admin.createUser({
        id,
        email,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(`Failed to create ${label}: ${error.message}`);

      const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(`Failed to sign in ${label}: ${signInError.message}`);

      return { id, client };
    };

    const victim = await createUser('victim');
    const attacker = await createUser('attacker');
    victimId = victim.id;
    victimClient = victim.client;
    attackerId = attacker.id;
    attackerClient = attacker.client;
  });

  afterAll(async () => {
    if (!adminSupabase) return;
    for (const id of [victimId, attackerId]) {
      if (id) await adminSupabase.auth.admin.deleteUser(id);
    }
  });

  // 攻撃連鎖の核心。ここが通ると、パスワードだけ知る攻撃者が MFA を迂回できる。
  it('authenticated ロールは被害者の行を INSERT できない', async () => {
    const { error } = await attackerClient
      .from('mfa_recovery_codes')
      .insert({ user_id: victimId, code_hash: 'planted-hash' });

    expect(error?.code).toBe(PERMISSION_DENIED);

    const { data: rows } = await adminSupabase
      .from('mfa_recovery_codes')
      .select('id')
      .eq('user_id', victimId);
    expect(rows).toEqual([]);
  });

  // 自分の行であっても書けない。「自分の分なら安全」ではなく、表そのものを
  // 認証主体から切り離すのが本 fix の設計。
  it('authenticated ロールは自分の行すら INSERT できない', async () => {
    const { error } = await attackerClient
      .from('mfa_recovery_codes')
      .insert({ user_id: attackerId, code_hash: 'self-hash' });

    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  // 攻撃連鎖の 2 段目（既知の平文に対応する hash を学ぶ）を塞ぐ。
  it('authenticated ロールは code_hash を SELECT できない', async () => {
    await seedVictimCodes(['hash-a']);

    const { error } = await attackerClient.from('mfa_recovery_codes').select('code_hash');

    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it('authenticated ロールは行を DELETE / UPDATE できない', async () => {
    await seedVictimCodes(['hash-a']);

    const { error: deleteError } = await victimClient
      .from('mfa_recovery_codes')
      .delete()
      .eq('user_id', victimId);
    expect(deleteError?.code).toBe(PERMISSION_DENIED);

    const { error: updateError } = await victimClient
      .from('mfa_recovery_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', victimId);
    expect(updateError?.code).toBe(PERMISSION_DENIED);
  });

  it('authenticated ロールは再発行 RPC を実行できない', async () => {
    const { error } = await victimClient.rpc('replace_mfa_recovery_codes_v1', {
      p_user_id: victimId,
      p_code_hashes: ['planted-hash'],
    });

    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  // 正側: 塞いだ結果アプリが壊れていないこと。生成・件数取得の両方を通す。
  it('service_role は再発行でき、旧コードは同じ操作で無効化される', async () => {
    await seedVictimCodes(['old-1', 'old-2']);

    const { data: inserted, error } = await adminSupabase.rpc('replace_mfa_recovery_codes_v1', {
      p_user_id: victimId,
      p_code_hashes: ['new-1', 'new-2', 'new-3'],
    });

    expect(error).toBeNull();
    expect(inserted).toBe(3);

    const { data: rows } = await adminSupabase
      .from('mfa_recovery_codes')
      .select('code_hash')
      .eq('user_id', victimId);
    expect(rows?.map((row) => row.code_hash).sort()).toEqual(['new-1', 'new-2', 'new-3']);
  });

  // 件数取得はブラウザから直接呼ぶ read。表の SELECT grant を剥がしたので
  // SECURITY DEFINER 化したが、他人の件数は見えないままであること。
  it('count_unused_recovery_codes は本人だけが自分の件数を取れる', async () => {
    await seedVictimCodes(['hash-a', 'hash-b']);

    const { data: own, error: ownError } = await victimClient.rpc('count_unused_recovery_codes', {
      p_user_id: victimId,
    });
    expect(ownError).toBeNull();
    expect(own).toBe(2);

    const { data: other, error: otherError } = await attackerClient.rpc(
      'count_unused_recovery_codes',
      { p_user_id: victimId },
    );
    expect(otherError).not.toBeNull();
    expect(other).toBeNull();
  });

  // 発行に aal2 を要求する前提（recovery-code-actions.ts）が、実際の登録フローで満たされる
  // ことを固定する。登録直後にコードを発行するのは `useMFA.verifyMFA` で、`mfa.verify()` の
  // 直後に呼ぶ。ここが aal1 のままだと MFA 登録そのものが完了できなくなる。
  it('TOTP を verify した直後のセッションは aal2 になる（発行ゲートを通せる）', async () => {
    const email = `mfa-lockdown-enroll-${crypto.randomUUID()}@example.com`;
    const password = 'lockdown-enroll-password-123';
    const { data: created, error: createError } = await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !created.user) {
      throw new Error(`Failed to create enrolling user: ${createError?.message}`);
    }

    const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    try {
      await client.auth.signInWithPassword({ email, password });

      const beforeEnroll = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(beforeEnroll.data?.currentLevel).toBe('aal1');

      const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({
        factorType: 'totp',
      });
      if (enrollError || !enrollData) throw new Error(`enroll failed: ${enrollError?.message}`);

      const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({
        factorId: enrollData.id,
      });
      if (challengeError || !challengeData) {
        throw new Error(`challenge failed: ${challengeError?.message}`);
      }

      const { error: verifyError } = await client.auth.mfa.verify({
        factorId: enrollData.id,
        challengeId: challengeData.id,
        code: generateTotp(enrollData.totp.secret),
      });
      if (verifyError) throw new Error(`verify failed: ${verifyError.message}`);

      const afterVerify = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(afterVerify.data?.currentLevel).toBe('aal2');
    } finally {
      await client.auth.signOut();
      await adminSupabase.auth.admin.deleteUser(created.user.id);
    }
  });

  async function seedVictimCodes(hashes: string[]): Promise<void> {
    const { error } = await adminSupabase.rpc('replace_mfa_recovery_codes_v1', {
      p_user_id: victimId,
      p_code_hashes: hashes,
    });
    if (error) throw new Error(`Failed to seed recovery codes: ${error.message}`);
  }
});
