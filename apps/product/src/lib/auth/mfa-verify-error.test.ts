/**
 * MFA 検証の失敗を利用者向けの文言へ写す。
 *
 * GoTrue の `message` は英語で provider 都合で変わる。そのまま描画すると日本語の
 * 利用者に英語が出るうえ、文言が変わった時に気付けない。判定は構造化 code で行う。
 */
import { describe, expect, it } from 'vitest';

import { isMfaChallengeExpired, resolveMfaVerifyErrorKey } from './mfa-verify-error';

describe('resolveMfaVerifyErrorKey', () => {
  it('コード誤りは入力し直しを促すキーへ写す', () => {
    expect(resolveMfaVerifyErrorKey('mfa_verification_failed')).toBe(
      'common.errors.mfa.codeInvalid',
    );
  });

  // challenge は mount 時に 1 度だけ発行される。寿命を過ぎた後の失敗を「コードが違う」
  // と伝えると、正しいコードを入れ続けて永久に通らない。
  it('challenge 期限切れは専用のキーへ写す', () => {
    expect(resolveMfaVerifyErrorKey('mfa_challenge_expired')).toBe(
      'common.errors.mfa.challengeExpired',
    );
  });

  it('拒否と多すぎる試行はそれぞれのキーへ写す', () => {
    expect(resolveMfaVerifyErrorKey('mfa_verification_rejected')).toBe(
      'common.errors.mfa.verificationRejected',
    );
    expect(resolveMfaVerifyErrorKey('over_request_rate_limit')).toBe(
      'common.errors.mfa.tooManyAttempts',
    );
  });

  // 未知の code で英語の生メッセージへ落ちないこと（この関数を置いた理由そのもの）
  it('未知の code と code 無しは汎用キーへ落とす', () => {
    expect(resolveMfaVerifyErrorKey('some_new_gotrue_code')).toBe(
      'common.errors.mfa.verificationFailed',
    );
    expect(resolveMfaVerifyErrorKey(undefined)).toBe('common.errors.mfa.verificationFailed');
  });
});

describe('isMfaChallengeExpired', () => {
  it('期限切れだけを引き直しの対象にする', () => {
    expect(isMfaChallengeExpired('mfa_challenge_expired')).toBe(true);
    expect(isMfaChallengeExpired('mfa_verification_failed')).toBe(false);
    expect(isMfaChallengeExpired(undefined)).toBe(false);
  });
});
