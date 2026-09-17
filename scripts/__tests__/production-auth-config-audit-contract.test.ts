/**
 * production Auth Config Audit の実行経路の契約を固定する（#1926）。
 *
 * この audit は account 単位 read-write の Supabase PAT を持って走る。渡す経路と
 * 依存の広がりが仕様どおりであることを、workflow と script の中身から機械的に固定する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGED_UNPINNED_KEYS,
  AUTH_CONFIG_CONTRACT,
} from '../ci/production-auth-config-audit.mjs';

const auditScript = readFileSync(
  fileURLToPath(new URL('../ci/production-auth-config-audit.mjs', import.meta.url)),
  'utf8',
);
const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/production-config-audit.yml', import.meta.url)),
  'utf8',
);

describe('production auth config audit contract', () => {
  it('監視対象と期待値はリテラルで固定する', () => {
    // production-auth-config-audit.test.ts の fixture は AUTH_CONFIG_CONTRACT から
    // 生成されるため、期待値を反転しても key を消しても green のままになる。この
    // audit は contract 変更検出（workflow の regex）の対象外なので、弱体化を可視化
    // する層がここ以外に無い。値を変える PR は必ずこの test の diff を伴わせる。
    // key だけの固定だと `password_min_length` を 8 -> 6 にしたり `compare: 'set'` を
    // 外したりしても green のままになる（Codex #3755002041）。auth audit 本体は PR で
    // 走らないので、弱体化がレビュー差分なしで main へ入る。比較方式と出力抑止まで固定する。
    expect(
      AUTH_CONFIG_CONTRACT.map(({ key, expected, compare, redact }) => [
        key,
        expected,
        compare ?? null,
        redact ?? null,
      ]),
    ).toEqual([
      ['security_update_password_require_reauthentication', false, null, null],
      ['security_update_password_require_current_password', true, null, null],
      ['mailer_secure_email_change_enabled', true, null, null],
      ['security_captcha_enabled', true, null, null],
      ['security_captcha_provider', 'turnstile', null, null],
      ['security_manual_linking_enabled', false, null, null],
      ['external_anonymous_users_enabled', false, null, null],
      ['mailer_autoconfirm', false, null, null],
      ['mailer_allow_unverified_email_sign_ins', false, null, null],
      ['site_url', 'https://app.dayopt.app', null, null],
      [
        'uri_allow_list',
        [
          'https://app.dayopt.app/**',
          'https://app.dayopt.app/auth/reset-password',
          'https://product-dayopt.vercel.app/',
          'https://product-dayopt.vercel.app/**',
        ],
        'set',
        null,
      ],
      ['refresh_token_rotation_enabled', true, null, null],
      ['security_refresh_token_reuse_interval', 10, null, null],
      ['security_sb_forwarded_for_enabled', false, null, null],
      ['hook_send_email_enabled', true, null, null],
      ['hook_custom_access_token_enabled', false, null, null],
      ['mfa_totp_verify_enabled', true, null, null],
      ['mfa_allow_low_aal', false, null, null],
      ['password_hibp_enabled', true, null, null],
      ['password_min_length', 8, null, null],
      [
        'password_required_characters',
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
        null,
        null,
      ],
      [
        'hook_send_email_uri',
        'https://yvglwblxrnrenfifsnje.supabase.co/functions/v1/send-auth-email',
        null,
        'url',
      ],
      ['mfa_totp_enroll_enabled', true, null, null],
      ['jwt_exp', 3600, null, null],
      ['mailer_otp_exp', 3600, null, null],
      ['rate_limit_email_sent', 30, null, null],
      ['rate_limit_token_refresh', 150, null, null],
      ['sessions_timebox', 0, null, null],
      ['sessions_inactivity_timeout', 0, null, null],
      ['disable_signup', false, null, null],
      ['external_email_enabled', true, null, null],
    ]);
  });

  it('除外リストもリテラルで固定する', () => {
    // guard の唯一の抜け道。export していないと 1 行足すだけで無言で新キーを黙らせられる。
    expect(ACKNOWLEDGED_UNPINNED_KEYS).toEqual([
      'hook_after_user_created_enabled',
      'hook_after_user_created_secrets',
      'hook_after_user_created_uri',
      'hook_before_user_created_enabled',
      'hook_before_user_created_secrets',
      'hook_before_user_created_uri',
      'hook_custom_access_token_secrets',
      'hook_custom_access_token_uri',
      'hook_mfa_verification_attempt_enabled',
      'hook_mfa_verification_attempt_secrets',
      'hook_mfa_verification_attempt_uri',
      'hook_password_verification_attempt_enabled',
      'hook_password_verification_attempt_secrets',
      'hook_password_verification_attempt_uri',
      'hook_send_sms_enabled',
      'hook_send_sms_secrets',
      'hook_send_sms_uri',
      'hook_send_email_secrets',
      'security_captcha_secret',
      'mfa_phone_enroll_enabled',
      'mfa_phone_verify_enabled',
      'mfa_phone_max_frequency',
      'mfa_phone_otp_length',
      'mfa_phone_template',
      'mfa_web_authn_enroll_enabled',
      'mfa_web_authn_verify_enabled',
      'mfa_max_enrolled_factors',
      'sessions_single_per_user',
      'sessions_tags',
    ]);
  });

  it('script は repo 内の他ファイルを import しない', () => {
    // contract 保護は列挙した path にしか効かない。import 先が増えると、保護外の
    // ファイルが PAT 付きの実行経路に混ざる。
    const relativeImports = auditScript.match(/from\s+['"]\.{1,2}\//gu) ?? [];
    expect(relativeImports).toEqual([]);
  });

  it('直接実行の判定は realpath で正規化する', () => {
    // Node は entry point を realpath へ解決してから `import.meta.url` を決める。
    // 素の path と比較すると symlink 経由（macOS の /tmp -> /private/tmp）で一致せず、
    // audit が「何も実行せず exit 0」になる。2026-08-11 の dry-run で実測した fail open。
    expect(auditScript).toContain('pathToFileURL(realpathSync(process.argv[1]))');
  });

  it('auth audit job は PR / workflow_dispatch では走らない', () => {
    // `pull_request_target` と `workflow_dispatch --ref <branch>` の checkout は
    // それぞれ base.sha と **branch head**。後者は branch の code を実行するため、
    // Vercel token より権限の広い Supabase PAT をこの経路へ渡さない。
    expect(workflow).toContain(
      "if: github.event_name == 'push' || github.event_name == 'schedule'",
    );
  });

  it('SUPABASE_AUTH_AUDIT_TOKEN は job ではなく step の env に置く', () => {
    // job 単位に置くと同 job の他 step にも token が乗る。
    const jobLevelEnv = /^ {4}env:\n(?:^ {6}.*\n)*^ {6}SUPABASE_AUTH_AUDIT_TOKEN:/mu;
    expect(workflow).not.toMatch(jobLevelEnv);
    expect(workflow).toMatch(/^ {10}SUPABASE_AUTH_AUDIT_TOKEN: \$\{\{ secrets\./mu);
  });

  it('audit token を参照する workflow は production-config-audit.yml だけ', () => {
    // Management API の PAT は account 単位 read-write（production DB への任意 SQL を
    // 含む）。参照する workflow が増えるほど、PR 側の code を実行する job へ渡る経路が
    // 生まれる。integration.yml が実際に `pull_request` + workflow レベル env の形で
    // この token を配っていた（2026-08-11 に削除）ので、参照先を 1 file に固定する。
    // この file 内での job / step の限定は上下の 2 test が担う。
    const workflowDir = fileURLToPath(new URL('../../.github/workflows', import.meta.url));
    const offenders = readdirSync(workflowDir)
      .filter((name) => /\.ya?ml$/u.test(name) && name !== 'production-config-audit.yml')
      .filter((name) =>
        readFileSync(join(workflowDir, name), 'utf8').includes('SUPABASE_AUTH_AUDIT_TOKEN'),
      );

    expect(offenders).toEqual([]);
  });

  it('auth audit の結果は commit status を経由しない', () => {
    // status context「Production Config Audit」は finish-branch.sh が merge gate の
    // 解除判定に使う。auth audit（PR diff と無関係な Dashboard 由来の drift）の
    // 失敗をここへ載せると、全 PR の merge が止まる。
    const jobIndex = workflow.indexOf('auth-config:');
    // -1 だと slice(-1) が末尾 1 文字になり、下の assertion が真空で pass する。
    expect(jobIndex).toBeGreaterThanOrEqual(0);
    const authJob = workflow.slice(jobIndex);
    expect(authJob).not.toContain('statuses/');
  });
});
