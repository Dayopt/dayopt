/**
 * MFA AAL Cookie Tampering Integration Test (#2047)
 *
 * `@supabase/ssr` の server client は session JSON 全体（`user.factors` 含む）を
 * cookie へ保存するが、その JSON 自体には integrity 保護が無い。旧実装は
 * `getAuthenticatorAssuranceLevel()` を jwt 引数なしで呼んでいたため、AAL 判定の
 * `nextLevel` が cookie 由来の未検証 `user.factors` に依存していた。攻撃者が
 * 自分の cookie から `factors` を削るだけで、MFA 登録済みでも `nextLevel='aal1'`
 * となり `proxy.ts` / `protectedProcedure` / calendar 接続route の3 gate すべてを
 * 素通りできてしまう。
 *
 * この test は実際の local Supabase に対し、verified TOTP factor を持つユーザーで
 * aal1 session（MFA 未検証）を確立し、`storage` に書き込まれた session JSON を
 * 攻撃者視点で直接改竄した上で（storage の中身を書き換えた「別の」client instance に
 * 読み直させることで、bind 済み SDK method の内部呼び出しも改竄後の値を読む状態を
 * 忠実に再現する。cookie を書き換えて別 request として届く本番の状況と同型）、
 *
 * 1. 改竄後の storage を読む real SDK の no-jwt 分岐（`getAuthenticatorAssuranceLevel()`、
 *    fix前の実装と同じ呼び方）が実際に nextLevel='aal1' を返すこと（脆弱性の再現）
 * 2. `resolveMfaAssurance`（3 gate 共通の判定源、#2047 の fix）は同じ改竄後 client でも
 *    `getUser(jwt)` で Auth server に問い合わせ、server 検証済み factors で
 *    nextLevel='aal2' を要求し続けること
 * 3. `protectedProcedure` を実際に通し、改竄クライアントでは FORBIDDEN になること
 *    （tRPC guard 経由で 3 gate のうち1つを end-to-end で確認）
 *
 * を固定する。1 は fix を revert する（`getAuthenticatorAssuranceLevel(accessToken)` を
 * `getAuthenticatorAssuranceLevel()` に戻す）と 2 も同じ結果（nextLevel='aal1'）に
 * 落ちるようになるため、revert 検出力を持つ回帰 test として機能する。
 *
 * 実行方法:
 * 1. supabase start
 * 2. USE_LOCAL_DB=true pnpm test:integration
 */

import { createHmac } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { createTestCaller } from '@/lib/test/trpc-test-helpers';
import { protectedProcedure, type Context } from '@/lib/trpc/procedures';
import { createTRPCRouter } from '@/lib/trpc/router';
import { resolveMfaAssurance, resolveSessionAuthContext } from '@/lib/trpc/session-auth-context';

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

const testRouter = createTRPCRouter({
  probe: protectedProcedure.query(() => ({ ok: true })),
});

/**
 * `@supabase/supabase-js` の GoTrueClient は session を `storage.setItem(key, JSON.stringify(session))`
 * の形で保存する（`auth-js/dist/module/lib/helpers.js` の `setItemAsync`）。in-memory の
 * storage adapter を自作し、sign-in 後にその生 JSON 文字列を直接書き換えることで、
 * 「攻撃者が cookie の中身を編集した後、その cookie が別 request で読まれる」状況を
 * storage 層で忠実に再現する。同じ storage を指す**別の** client instance に読み直させる
 * のが要点: 同一 instance の method は内部で bind 元のメモリ上 session を参照し続けて
 * しまい、storage の改竄を経由しない。
 */
function createInMemoryStorage(): {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  raw: Map<string, string>;
} {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: async (key) => raw.get(key) ?? null,
    setItem: async (key, value) => {
      raw.set(key, value);
    },
    removeItem: async (key) => {
      raw.delete(key);
    },
  };
}

/** storage 内の session JSON から `user.factors` を全件削除する（攻撃者の cookie 改竄を再現）。 */
function tamperStoredFactors(raw: Map<string, string>): void {
  for (const [key, value] of raw) {
    try {
      const parsed = JSON.parse(value) as { user?: { factors?: unknown[] } };
      if (parsed.user && Array.isArray(parsed.user.factors)) {
        parsed.user.factors = [];
        raw.set(key, JSON.stringify(parsed));
      }
    } catch {
      // session以外のstorage entry（PKCE code verifier等）はJSONでない場合があるためskip
    }
  }
}

describe.skipIf(!RUN_LOCAL)('MFA AAL cookie tampering (#2047)', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let userId: string;
  let email: string;
  const password = 'initial-password-123';

  beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    userId = crypto.randomUUID();
    email = `mfa-aal-tamper-${userId}@example.com`;

    const { error: createError } = await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      id: userId,
    });
    if (createError) throw new Error(`Failed to create test user: ${createError.message}`);

    // TOTP factor を enroll + verify（本人のセッションで enroll する必要がある）
    const enrollClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await enrollClient.auth.signInWithPassword({ email, password });

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
  });

  afterAll(async () => {
    if (!adminSupabase || !userId) return;
    await adminSupabase.auth.admin.deleteUser(userId);
  });

  /**
   * storage を改竄した状態から、その storage を読む**フレッシュな** client を返す。
   * sign-in に使った client instance をそのまま使うとメモリ上の session を使い回して
   * しまい、storage の改竄を経由しない（このファイル冒頭の createInMemoryStorage 参照）。
   */
  async function createTamperedClient(): Promise<SupabaseClient<Database>> {
    const storage = createInMemoryStorage();
    const signInClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage, persistSession: true, autoRefreshToken: false },
    });
    const { error: signInError } = await signInClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw new Error(`Failed to sign in: ${signInError.message}`);

    tamperStoredFactors(storage.raw);

    return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage, persistSession: true, autoRefreshToken: false },
    });
  }

  it('改竄されたstorageを読む旧ロジック(no-jwt)はnextLevelをaal1に倒す(脆弱性の再現)', async () => {
    const tampered = await createTamperedClient();

    // 改竄が効いていることをまず確認する（このtestが空振りでないこと）
    const { data: sessionData } = await tampered.auth.getSession();
    expect(sessionData.session?.user.factors).toEqual([]);

    // #2047 fix前の実装と同じ呼び方（jwt引数なし）。real SDK の no-jwt 分岐は
    // getSession() が返す session.user.factors を直接信頼するため、verified
    // factor が存在するのに nextLevel が aal1 に落ちる（= MFA gate を素通りできる）。
    const { data: vulnerableResult } = await tampered.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(vulnerableResult?.currentLevel).toBe('aal1');
    expect(vulnerableResult?.nextLevel).toBe('aal1');

    await tampered.auth.signOut();
  });

  it('resolveMfaAssuranceは改竄後もserver検証済みfactorsでnextLevel=aal2を要求する', async () => {
    const tampered = await createTamperedClient();

    const mfaAssurance = await resolveMfaAssurance(tampered, 'trpc_context');
    expect(mfaAssurance.lookupFailed).toBeFalsy();
    expect(mfaAssurance.currentLevel).toBe('aal1');
    // #2047の核心: 改竄されたstorageのuser.factors=[]に関わらず、jwt引数付きの
    // getAuthenticatorAssuranceLevel(accessToken)が内部でgetUser(jwt)をAuth server
    // へ問い合わせ、その応答(server検証済み)のfactorsでnextLevel=aal2になる。
    // fixをrevertする(jwt引数を外す)と、このtestは直前のtestと同じくaal1に落ちる。
    expect(mfaAssurance.nextLevel).toBe('aal2');

    await tampered.auth.signOut();
  });

  it('protectedProcedure経由でも改竄クライアントはFORBIDDEN(MFA verification required)になる', async () => {
    const tampered = await createTamperedClient();
    const sessionContext = await resolveSessionAuthContext(tampered, 'trpc_context');
    expect(sessionContext.userId).toBe(userId);

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
      supabase: tampered,
      authMode: 'session' as const,
    };

    const caller = createTestCaller(testRouter, ctx);

    await expect(caller.probe()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>);

    await tampered.auth.signOut();
  });
});

/** RFC 6238 TOTP（SHA-1, 30秒間隔, 6桁）。テスト専用の最小実装 */
function generateTotp(base32Secret: string, forTime: number = Date.now()): string {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(forTime / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 1_000_000).padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
