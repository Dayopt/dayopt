import { describe, expect, it, vi } from 'vitest';

import { runAuthConfigSafeGet, SAFE_AUTH_CONFIG_FIELDS } from './supabase-mgmt-safe-get.mjs';

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  };
}

describe('runAuthConfigSafeGet', () => {
  it('allowlist 内の field だけを射影して返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        security_captcha_enabled: true,
        security_captcha_secret: 'must-not-appear',
        disable_signup: false,
      }),
    );

    const result = await runAuthConfigSafeGet({
      fields: ['security_captcha_enabled', 'disable_signup'],
      token: 'test-token',
      fetchImpl,
    });

    expect(result).toEqual({ security_captcha_enabled: true, disable_signup: false });
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  // 2026-08-11 incident（#1920）の再現: security_captcha_enabled を確認する意図で
  // security_captcha_secret まで要求しても値を返さない。denylist / 部分一致フィルタが
  // 2回とも漏らした field を、allowlist方式で正面から拒否する。
  it('過去incident再現: security_captcha_secret を要求すると全体を拒否する（fetchも呼ばない）', async () => {
    const fetchImpl = vi.fn();

    await expect(
      runAuthConfigSafeGet({
        fields: ['security_captcha_enabled', 'security_captcha_secret'],
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/security_captcha_secret/);

    // allowlist外を検出した時点で拒否する。fetchを呼んでからfilterするのではなく、
    // そもそもtokenを使ったnetwork callを発生させない。
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('smtp_pass のような未知のsecret系keyも拒否する', async () => {
    const fetchImpl = vi.fn();

    await expect(
      runAuthConfigSafeGet({ fields: ['smtp_pass'], token: 'test-token', fetchImpl }),
    ).rejects.toThrow(/smtp_pass/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redact: url の field（hook_send_email_uri）はallowlistに含まれない', () => {
    expect(SAFE_AUTH_CONFIG_FIELDS.has('hook_send_email_uri')).toBe(false);
  });

  it('security_captcha_secret はallowlistに含まれない', () => {
    expect(SAFE_AUTH_CONFIG_FIELDS.has('security_captcha_secret')).toBe(false);
  });

  // push前反証レビューで指摘: SAFE_AUTH_CONFIG_FIELDS は AUTH_CONFIG_CONTRACT から
  // 「redact: 'url' を除外」という denylist 形で導出している。将来 contract に
  // redact 未指定の secret 系 entry が1件増えるだけで、この wrapper が自動的に
  // 値を返す側へ倒れる（`db_pass` が `password` denylist を素通りした08-11と
  // 同じ形）。allowlist をリテラルで固定し、増減が必ずこの test の diff を
  // 伴うようにする（production-auth-config-audit-contract.test.ts の
  // 「監視対象と期待値はリテラルで固定する」と同型の防御）。
  it('allowlist はリテラルで固定する（denylist形の導出に対する二重防御）', () => {
    expect([...SAFE_AUTH_CONFIG_FIELDS].sort()).toEqual([
      'disable_signup',
      'external_anonymous_users_enabled',
      'external_email_enabled',
      'hook_custom_access_token_enabled',
      'hook_send_email_enabled',
      'jwt_exp',
      'mailer_allow_unverified_email_sign_ins',
      'mailer_autoconfirm',
      'mailer_notifications_password_changed_enabled',
      'mailer_otp_exp',
      'mailer_secure_email_change_enabled',
      'mfa_allow_low_aal',
      'mfa_totp_enroll_enabled',
      'mfa_totp_verify_enabled',
      'password_hibp_enabled',
      'password_min_length',
      'password_required_characters',
      'rate_limit_email_sent',
      'rate_limit_token_refresh',
      'refresh_token_rotation_enabled',
      'security_captcha_enabled',
      'security_captcha_provider',
      'security_manual_linking_enabled',
      'security_refresh_token_reuse_interval',
      'security_sb_forwarded_for_enabled',
      'security_update_password_require_current_password',
      'security_update_password_require_reauthentication',
      'sessions_inactivity_timeout',
      'sessions_timebox',
      'site_url',
      'uri_allow_list',
    ]);
  });

  it('token が無いと拒否する', async () => {
    await expect(
      runAuthConfigSafeGet({ fields: ['disable_signup'], token: '', fetchImpl: vi.fn() }),
    ).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  it('field を1つも指定しないと拒否する', async () => {
    await expect(
      runAuthConfigSafeGet({ fields: [], token: 'test-token', fetchImpl: vi.fn() }),
    ).rejects.toThrow();
  });

  it('応答に無いfieldはnullを返す（存在しない扱いを黙って通さない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    const result = await runAuthConfigSafeGet({
      fields: ['disable_signup'],
      token: 'test-token',
      fetchImpl,
    });

    expect(result).toEqual({ disable_signup: null });
  });

  it('HTTP失敗時は応答本文を出力しない（secret同梱のため）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ security_captcha_secret: 'leaked-if-shown' }, false));

    await expect(
      runAuthConfigSafeGet({ fields: ['disable_signup'], token: 'test-token', fetchImpl }),
    ).rejects.toThrow(/request failed/);
  });

  it('JSON parseに失敗した応答は固定文言で失敗する（本文を出力しない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('unexpected token < in JSON at position 0')),
    });

    await expect(
      runAuthConfigSafeGet({ fields: ['disable_signup'], token: 'test-token', fetchImpl }),
    ).rejects.toThrow(/was not JSON/);
  });
});
