import { describe, expect, it, vi } from 'vitest';

import {
  auditSupabaseAuthConfig,
  AUTH_CONFIG_CONTRACT,
  runProductionAuthConfigAudit,
  SUPABASE_PRODUCTION_PROJECT_REF,
} from './production-auth-config-audit.mjs';

/** 契約を満たす応答。secret 同梱の実レスポンスを模して余分な key も混ぜる。 */
function compliantAuthConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    security_captcha_secret: 'must-not-appear',
    smtp_pass: 'must-not-appear',
    site_url: 'https://app.dayopt.app',
  };
  for (const { key, expected, compare } of AUTH_CONFIG_CONTRACT) {
    config[key] = compare === 'set' ? (expected as string[]).join(',') : expected;
  }
  return config;
}

describe('auditSupabaseAuthConfig', () => {
  it('現在の production 値と一致する応答は error を返さない', () => {
    expect(auditSupabaseAuthConfig(compliantAuthConfig())).toEqual([]);
  });

  it('期待値と違う値は key ごとに error を返す', () => {
    const config = { ...compliantAuthConfig(), mailer_secure_email_change_enabled: false };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('mailer_secure_email_change_enabled must be true, got false');
  });

  it('enum の drift も検出する', () => {
    const config = { ...compliantAuthConfig(), security_captcha_provider: 'hcaptcha' };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('security_captcha_provider must be "turnstile", got "hcaptcha"');
  });

  it('key が欠落した応答は failure にする（fail closed）', () => {
    const config = compliantAuthConfig();
    delete config.security_captcha_enabled;

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('security_captcha_enabled is missing');
  });

  it('null は compliant にしない（nullable 応答を素通りさせない）', () => {
    const config = { ...compliantAuthConfig(), security_manual_linking_enabled: null };

    expect(auditSupabaseAuthConfig(config)).toHaveLength(1);
  });

  it('object でない応答は failure にする', () => {
    expect(auditSupabaseAuthConfig(null)).toEqual(['Supabase Auth config response is invalid']);
    expect(auditSupabaseAuthConfig([])).toEqual(['Supabase Auth config response is invalid']);
  });

  it('締まる方向（fail-closed）の drift も検出する', () => {
    // 「緩んだら警報」の片方向設計にしない。security_captcha_provider の変更や
    // 再認証要求の有効化は、安全側に倒れるように見えて login / password reset を
    // 止めうる。判定を等値にしてあるので両方向が failure になることを固定する。
    const config = {
      ...compliantAuthConfig(),
      security_update_password_require_reauthentication: true,
    };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[fail-closed]');
  });

  it('パスワード変更通知が無効なら failure にする', () => {
    const config = {
      ...compliantAuthConfig(),
      mailer_notifications_password_changed_enabled: false,
    };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('mailer_notifications_password_changed_enabled must be true');
    expect(errors[0]).toContain('[fail-closed]');
  });

  it('契約にも除外リストにも無い security_* キーは failure にする', () => {
    // 契約は「知っているキー」しか守れない。未知の設定が現れたら 1 度止めて、
    // pin するか除外リストへ入れるかの判断を強制する（2026-08-11 に
    // security_update_password_require_current_password を取りこぼした事故の構造対策）。
    const config = { ...compliantAuthConfig(), security_brand_new_toggle: false };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('security_brand_new_toggle');
  });

  it('除外リストに載せたキーは boolean 以外でも failure にしない', () => {
    const config = {
      ...compliantAuthConfig(),
      sessions_single_per_user: false,
      security_captcha_secret: 'must-not-appear',
      mfa_phone_template: 'ignored',
    };

    expect(auditSupabaseAuthConfig(config)).toEqual([]);
  });

  it('guard 対象外の名前空間は未分類にしない', () => {
    // external_*(95) / mailer_*(40) は provider や template が増えるたびにキーが増え、
    // キーの存在自体は危険ではない。入れると誤検出が主成分になり形骸化する。
    const config = { ...compliantAuthConfig(), external_zoom_enabled: false };

    expect(auditSupabaseAuthConfig(config)).toEqual([]);
  });

  it('guard 対象の非 boolean な新設キーも failure にする', () => {
    // hook_send_email_uri（全認証メールの token 配送先）のような string の危険値を
    // 構造的に見落とさないため、boolean 限定にしない。
    const config = { ...compliantAuthConfig(), hook_brand_new_uri: 'https://example.com/hook' };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hook_brand_new_uri');
  });

  it('hook URI の drift は実測値を出さずに failure にする', () => {
    // drift 先は Dashboard で任意に設定でき、query / userinfo / path のいずれにも
    // secret が入りうる。名前ベースの test では防げないので出力側で落とす。
    const leaky = 'https://attacker.example/collect?sig=super-secret-value';
    const config = { ...compliantAuthConfig(), hook_send_email_uri: leaky };

    const errors = auditSupabaseAuthConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hook_send_email_uri');
    expect(errors[0]).not.toContain('super-secret-value');
    expect(errors[0]).not.toContain('attacker.example');
  });

  it('全 key に故障の向きが分類されている', () => {
    for (const { key, failureMode } of AUTH_CONFIG_CONTRACT) {
      expect(['fail-open', 'fail-closed'], key).toContain(failureMode);
    }
  });

  it('契約は値が credential になり得ない設定値に限る', () => {
    for (const { key, expected } of AUTH_CONFIG_CONTRACT) {
      expect(['boolean', 'string', 'number', 'object'], key).toContain(typeof expected);
      // 値を出力するキーが契約へ紛れ込まないための唯一の層。複数形・中置も落とす。
      expect(key, key).not.toMatch(/_secrets?$|_keys?$|_tokens?$|_pass$|_credentials?$/u);
    }
  });
});

describe('runProductionAuthConfigAudit', () => {
  it('token 未設定は実行前に落とす', async () => {
    await expect(runProductionAuthConfigAudit({ token: '' })).rejects.toThrow(
      'SUPABASE_AUTH_AUDIT_TOKEN is required',
    );
  });

  it('production project の auth config endpoint を Bearer token で読む', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(compliantAuthConfig()),
    );

    await runProductionAuthConfigAudit({ token: 'test-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://api.supabase.com/v1/projects/${SUPABASE_PRODUCTION_PROJECT_REF}/config/auth`,
    );
    expect(init?.headers).toEqual({ Authorization: 'Bearer test-token' });
  });

  it('非 2xx はレスポンス本文を出さずに throw する', async () => {
    const body = 'unauthorized: token-shaped-secret';
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));

    await expect(runProductionAuthConfigAudit({ token: 'bad', fetchImpl })).rejects.toThrow(
      /Supabase Auth config request failed/u,
    );
    await expect(runProductionAuthConfigAudit({ token: 'bad', fetchImpl })).rejects.not.toThrow(
      new RegExp(body, 'u'),
    );
  });

  it('drift があれば全件を並べて throw する', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ...compliantAuthConfig(),
        security_captcha_enabled: false,
        mailer_autoconfirm: true,
      }),
    );

    await expect(runProductionAuthConfigAudit({ token: 'test-token', fetchImpl })).rejects.toThrow(
      /security_captcha_enabled[\s\S]*mailer_autoconfirm/u,
    );
  });
});
