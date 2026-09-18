import type { MessageKey } from '@/lib/i18n';

/**
 * MFA 検証の失敗を利用者向けの文言へ写す。
 *
 * GoTrue の `message` は英語で、provider 側の都合で変わる。そのまま描画すると
 * 日本語の利用者に英語が出るうえ、文言が変わった時に気付けない。判定は
 * 構造化 code（`AuthError.code`）で行い、未知の code は汎用キーへ落とす。
 *
 * ログインの列挙防止（`@/lib/auth-error`）とは目的が別。ここへ到達する時点で
 * 本人確認は 1 段通っており、隠すべき情報は無い。隠すと復帰できなくなる。
 */

/** challenge の寿命切れ。新しい challenge を引き直せば回復する */
const MFA_CHALLENGE_EXPIRED_CODE = 'mfa_challenge_expired';

export function resolveMfaVerifyErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case MFA_CHALLENGE_EXPIRED_CODE:
      return 'common.errors.mfa.challengeExpired';
    case 'mfa_verification_failed':
      return 'common.errors.mfa.codeInvalid';
    case 'mfa_verification_rejected':
      return 'common.errors.mfa.verificationRejected';
    case 'over_request_rate_limit':
      return 'common.errors.mfa.tooManyAttempts';
    default:
      return 'common.errors.mfa.verificationFailed';
  }
}

/** この失敗は challenge を引き直せば解消するか */
export function isMfaChallengeExpired(code: string | undefined): boolean {
  return code === MFA_CHALLENGE_EXPIRED_CODE;
}
