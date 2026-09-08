/**
 * `send-auth-email` の確認 URL 組み立て（#2616）。
 *
 * 認証メールのリンクは `token_hash` を含むため、載せる origin を Edge Function 自身が
 * allowlist で閉じる。GoTrue の redirect allowlist（production は Dashboard が正本で、
 * repo からは強制できない）だけに依存させないための二重化で、ここはその契約を固定する。
 *
 * 実体は `supabase/functions/send-auth-email/confirm-url.ts`。`index.ts` は module scope で
 * `Deno.env.get` を呼ぶため import できないので、純関数だけを分離してここから検証する
 * （edge function を scripts 側の vitest から扱う先例は `scripts/auth-hook-config.test.ts`）。
 */

import { describe, expect, it } from 'vitest';

import type { EmailData } from '../../supabase/functions/_shared/types.ts';
import {
  buildConfirmUrl,
  resolveConfirmOrigin,
} from '../../supabase/functions/send-auth-email/confirm-url.ts';

const APP_URL = 'https://app.dayopt.app';

function emailData(overrides: Partial<EmailData> = {}): EmailData {
  return {
    token: '123456',
    token_hash: 'hash-current',
    redirect_to: '',
    email_action_type: 'signup',
    site_url: APP_URL,
    token_new: '',
    token_hash_new: '',
    ...overrides,
  };
}

describe('resolveConfirmOrigin', () => {
  it('allowlist 外の origin は appUrl へ落とす', () => {
    expect(resolveConfirmOrigin('https://attacker.example/auth/confirm', APP_URL)).toBe(APP_URL);
  });

  it('appUrl 自身の origin は許可する（Preview branch は appUrl が preview URL になる）', () => {
    const previewAppUrl = 'https://product-abc123-dayopt.vercel.app';
    expect(resolveConfirmOrigin(`${previewAppUrl}/calendar`, previewAppUrl)).toBe(previewAppUrl);
  });

  it('production origin を許可する', () => {
    expect(resolveConfirmOrigin('https://app.dayopt.app/calendar', APP_URL)).toBe(APP_URL);
  });

  it.each([
    ['hash 付き preview', 'https://product-abc123-dayopt.vercel.app'],
    ['branch 付き preview', 'https://product-git-feat-x-dayopt.vercel.app'],
    ['production alias', 'https://product-dayopt.vercel.app'],
  ])('Vercel の %s を許可する', (_label, origin) => {
    expect(resolveConfirmOrigin(`${origin}/calendar`, APP_URL)).toBe(origin);
  });

  // wildcard の `*` はドットを含まない。サブドメインを足して allowlist をすり抜ける形を塞ぐ。
  it.each([
    ['ドット入りのサブドメイン', 'https://product-x.evil-dayopt.vercel.app/calendar'],
    ['末尾に追加ラベル', 'https://product-abc-dayopt.vercel.app.evil.example/calendar'],
    ['接尾辞の偽装', 'https://product-abc-dayopt.vercel.appx/calendar'],
    ['http へのダウングレード', 'http://app.dayopt.app/calendar'],
    ['別 project 名', 'https://web-abc123-dayopt.vercel.app/calendar'],
  ])('%s は拒否して appUrl へ落とす', (_label, redirectTo) => {
    expect(resolveConfirmOrigin(redirectTo, APP_URL)).toBe(APP_URL);
  });

  it('URL として解釈できない redirect_to は appUrl へ落とす', () => {
    expect(resolveConfirmOrigin('not-a-url', APP_URL)).toBe(APP_URL);
  });

  it('redirect_to が空なら appUrl を使う', () => {
    expect(resolveConfirmOrigin('', APP_URL)).toBe(APP_URL);
    expect(resolveConfirmOrigin(undefined, APP_URL)).toBe(APP_URL);
  });
});

describe('buildConfirmUrl', () => {
  // 本 issue の核心: 第三者が支配する origin へ token_hash を載せない。
  it('攻撃者 origin の redirect_to でも token_hash は app origin にしか載らない', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({
          redirect_to: 'https://attacker.example/steal?y=1',
          email_action_type: 'recovery',
        }),
        appUrl: APP_URL,
      }),
    );

    expect(url.origin).toBe(APP_URL);
    expect(url.pathname).toBe('/auth/confirm');
    expect(url.searchParams.get('token_hash')).toBe('hash-current');
  });

  // origin を拒否しても next は落とさない。着地先の検証は app 側の getSafeRedirectPath が
  // 行っており、ここで next を捨てると「リンクが死ぬ」過去バグを再発させる。
  it('origin を拒否しても next（path + query）は従来どおり渡す', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({ redirect_to: 'https://attacker.example/x?y=1' }),
        appUrl: APP_URL,
      }),
    );

    expect(url.searchParams.get('next')).toBe('/x?y=1');
  });

  it('許可された preview origin はそのまま採用する', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({
          redirect_to: 'https://product-abc123-dayopt.vercel.app/calendar?view=day',
        }),
        appUrl: APP_URL,
      }),
    );

    expect(url.origin).toBe('https://product-abc123-dayopt.vercel.app');
    expect(url.searchParams.get('next')).toBe('/calendar?view=day');
  });

  it('next が "/" だけなら付けない', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({ redirect_to: 'https://app.dayopt.app/' }),
        appUrl: APP_URL,
      }),
    );

    expect(url.searchParams.has('next')).toBe(false);
  });

  // verifyOtp の EmailOtpType はアンダースコアなし
  it('magic_link は magiclink へ正規化する', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({ email_action_type: 'magic_link' }),
        appUrl: APP_URL,
      }),
    );

    expect(url.searchParams.get('type')).toBe('magiclink');
  });

  it('tokenHash を上書きできる（email_change は宛先ごとに hash が違う）', () => {
    const url = new URL(
      buildConfirmUrl({
        emailData: emailData({ token_hash_new: 'hash-new' }),
        appUrl: APP_URL,
        tokenHash: 'hash-new',
      }),
    );

    expect(url.searchParams.get('token_hash')).toBe('hash-new');
  });
});
