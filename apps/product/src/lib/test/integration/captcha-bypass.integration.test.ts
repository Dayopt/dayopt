/**
 * captcha 迂回の成立を実 GoTrue に対して検証する（#1925）
 *
 * unit test（`features/auth/server/__tests__/password-reauthentication.test.ts`）は
 * client を完全に mock するため、**迂回そのものが壊れても緑のまま**になる。
 * 「GoTrue は Authorization が admin role なら `verifyCaptcha` を skip する」は
 * repo 内から検証できない外部契約なので、実サーバーに対して確かめるのはここだけ。
 *
 * ## 実行方法（既定では skip される）
 *
 * `supabase/config.toml` の `[auth.captcha]` は既定でコメントアウトされている。
 * **常時有効化はできない** — 有効にすると他の integration test と local dev の
 * ログインが captcha token 未添付で全部 `captcha_failed` になる。したがって
 * この test は「captcha が有効な時だけ走る」形にし、既定では skip する。
 *
 * 1. `supabase/config.toml` に一時的に足す（commit しない）:
 *
 *    ```toml
 *    [auth.captcha]
 *    enabled = true
 *    provider = "turnstile"
 *    # Cloudflare が公開している testing key（always passes）。機密ではない
 *    secret = "1x0000000000000000000000000000000AA"
 *    ```
 *
 * 2. `supabase stop && supabase start`
 * 3. `pnpm --filter @dayopt/product test:integration -- captcha-bypass`
 * 4. 終わったら `config.toml` を戻して `supabase stop && supabase start`
 *
 * ## いつ走らせるか
 *
 * `docs/product/specs/auth.md` が定める再検証トリガー — **service role key を
 * 回転する / 新形式（`sb_secret_`）へ移行する前** — にここを通す。新形式は Bearer
 * として送られず admin と解釈されないため、迂回が成立しなくなり削除が止まる。
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const TEST_EMAIL = `captcha-bypass-${crypto.randomUUID()}@example.test`;
const TEST_PASSWORD = 'Captcha-Bypass-Verify-Passw0rd';

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string | undefined;
/** captcha が有効な環境でのみ意味を持つ test 群。既定の local では skip する */
let captchaEnabled = false;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`テストユーザーを作成できない: ${error.message}`);
  userId = data.user?.id;

  // 有効・無効を設定ファイルではなく**実挙動**から判定する。config.toml を読むと
  // 「書いてあるが supabase を再起動していない」状態を有効と誤認する
  const probe = await anon.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  captchaEnabled = probe.error?.code === 'captcha_failed';

  if (!captchaEnabled) {
    console.warn(
      '[captcha-bypass] captcha が無効なので skip する。' +
        '検証するには config.toml の [auth.captcha] を一時有効化して supabase を再起動する（ファイル冒頭の手順参照）',
    );
  }
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

/**
 * `it.skipIf(...)` は**収集時**に評価されるため使えない。`captchaEnabled` は
 * `beforeAll` の probe で決まるので、収集時点では常に false になり
 * **captcha を有効にしても全部 skip される**（実際に踏んだ）。実行時に skip する。
 */
function skipUnlessCaptchaEnabled(ctx: { skip: (note?: string) => void }): void {
  if (!captchaEnabled) {
    ctx.skip('captcha が無効。有効化の手順はこのファイル冒頭を参照');
  }
}

describe('captcha 迂回（service-role 経由の再認証）', () => {
  it('user-scoped client は captcha_failed になる（修正前の経路 = 故障の再現）', async (ctx) => {
    skipUnlessCaptchaEnabled(ctx);

    const { error } = await anon.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(error?.code).toBe('captcha_failed');
  });

  it('service-role client は captcha を免除されて成功する（迂回の成立）', async (ctx) => {
    skipUnlessCaptchaEnabled(ctx);

    const { data, error } = await admin.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(error).toBeNull();
    expect(data.session?.access_token).toBeTruthy();

    // 検証のために mint した session を残さない（本番実装と同じ後始末）
    await admin.auth.signOut({ scope: 'local' });
  });

  // 本 PR の安全性の核心。免除されるのは captcha だけで、パスワード検証は生きている
  it('service-role でも誤ったパスワードは拒否される（認証強度は落ちていない）', async (ctx) => {
    skipUnlessCaptchaEnabled(ctx);

    const { error } = await admin.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: 'wrong-password',
    });

    expect(error?.code).toBe('invalid_credentials');
  });
});
