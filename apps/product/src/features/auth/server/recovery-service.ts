import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { verifyRecoveryCode } from '@/lib/auth/recovery-codes';
import type { Database } from '@/lib/database';
import { getUserLocale, sendMfaDisabledEmail } from '@/lib/email/router';
import { logger } from '@/lib/logger';
import {
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
  observeAuthOperation,
} from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { ServiceError } from '@/lib/trpc/errors';
import { getDisplayName } from '@/lib/user';

class RecoveryServiceError extends ServiceError {
  constructor(
    code: 'RECOVERY_EXHAUSTED' | 'RECOVERY_INVALID' | 'RECOVERY_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message);
    this.name = 'RecoveryServiceError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class RecoveryService {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  async verify(options: { userId: string; code: string }) {
    const { userId, code } = options;

    // #2618: `mfa_recovery_codes` は認証主体（anon / authenticated）から到達できない
    // credential store になった。この読み取りは service_role で行う。
    //
    // user-scoped client で読んでいた頃は、aal1 のユーザー自身が同じ表へ INSERT できたため、
    // 「一致する行がある」ことが認証の根拠にならなかった（自分で植えた行に一致させられた）。
    // service_role で読むこと自体は認可を強めないが、表への書き込み経路を service_role only
    // へ寄せたので、ここも同じ client に揃えて grant の前提を一本化する。
    const adminClient = createServiceRoleClient();

    const { data: codes, error: fetchError } = await adminClient
      .from('mfa_recovery_codes')
      .select('id, code_hash')
      .eq('user_id', userId)
      .is('used_at', null);

    if (fetchError) {
      logger.error('Failed to fetch recovery codes');
      const original = captureUnexpectedDatabaseError(fetchError, {
        feature: 'mfa_recovery',
        operation: 'fetch_recovery_codes',
      });
      throw new RecoveryServiceError('RECOVERY_FAILED', 'Failed to fetch recovery codes', {
        cause: original,
      });
    }

    if (!codes || codes.length === 0) {
      throw new RecoveryServiceError('RECOVERY_EXHAUSTED', 'RECOVERY_EXHAUSTED');
    }

    const matchedCode = codes.find((candidate) => verifyRecoveryCode(code, candidate.code_hash));
    if (!matchedCode) {
      throw new RecoveryServiceError('RECOVERY_INVALID', 'RECOVERY_INVALID');
    }

    // factor削除 → コード消費の順で実行する（#2039）。逆順だと factor削除失敗時に
    // 「コードは消費済みだが MFA は有効なまま」というロックアウト方向の中途状態が残る。
    // この順序なら factor削除の失敗時はコード未消費のまま再試行でき、逆に factor削除
    // 成功後にコード消費が失敗しても実害は「そのコードが将来もう一度使える」だけに留まる。
    let mfaDisabled = false;
    try {
      const { data: factors, error: listFactorsError } = await observeAuthOperation(
        'recovery_list_mfa_factors',
        () => adminClient.auth.admin.mfa.listFactors({ userId }),
        { feature: 'mfa_recovery' },
      );
      if (listFactorsError) throw listFactorsError;

      if (factors?.factors) {
        for (const factor of factors.factors) {
          if (factor.status === 'verified') {
            const { error: deleteFactorError } = await observeAuthOperation(
              'recovery_delete_mfa_factor',
              () => adminClient.auth.admin.mfa.deleteFactor({ userId, id: factor.id }),
              { feature: 'mfa_recovery' },
            );
            if (deleteFactorError) throw deleteFactorError;
            mfaDisabled = true;
          }
        }
      }
    } catch (error) {
      logger.error('Failed to unenroll MFA factor:', error);
      if (mfaDisabled) {
        // 複数 verified factor のうち1つ以上は既に削除済み（MFAは実質的に弱体化/無効化
        // 済み）で、この後の factor で失敗して例外を投げる直前の状態。ここで通知せずに
        // throw すると、通知ブロック（この関数の後段）まで到達せず、攻撃者が無通知・
        // コード未消費のまま factor を剥がせる経路になる。RECOVERY_FAILED を投げる前に
        // 通知だけは送っておく
        captureUnexpectedError(
          error instanceof Error
            ? error
            : new Error('Partial MFA factor unenrollment failure', { cause: error }),
          { feature: 'mfa_recovery', operation: 'partial_mfa_factor_unenrollment' },
        );
        await this.notifyMfaDisabled(adminClient, userId);
      }
      throw new RecoveryServiceError('RECOVERY_FAILED', 'Failed to unenroll MFA factor', {
        cause: error instanceof Error ? error : undefined,
      });
    }

    const { data: used, error: rpcError } = await adminClient.rpc('use_recovery_code', {
      p_user_id: userId,
      p_code_hash: matchedCode.code_hash,
    });

    // MFA解除（ユーザーに必要な副作用）は既に確定している。コード消費の失敗は
    // 「同じコードが将来もう一度使える状態で残る」だけなので、ここでは失敗として
    // 返さない（#2039）。次にこのコードで verify() が呼ばれた時点では factor は
    // 既に存在しないため、単に消費だけが行われて収束する。
    if (rpcError) {
      logger.error('Failed to mark recovery code as used');
      captureUnexpectedDatabaseError(rpcError, {
        feature: 'mfa_recovery',
        operation: 'consume_recovery_code',
      });
    } else if (!used) {
      // rpcError が無いのに used=false は、並行リクエストが同じコードを先に消費した
      // 良性のレース（このリクエスト到達時点で対象行が既に used_at 済み）。異常ではないので
      // Sentry へは上げない
      logger.info('Recovery code already consumed by a concurrent request');
    }

    if (mfaDisabled) {
      // MFA無効化の通知メール（#2033）。送信失敗で検証成功自体は取り消さない。
      await this.notifyMfaDisabled(adminClient, userId);
    }

    const { data: remainingCount, error: countError } = await adminClient.rpc(
      'count_unused_recovery_codes',
      { p_user_id: userId },
    );

    if (countError) {
      logger.error('Failed to count remaining recovery codes');
      captureUnexpectedDatabaseError(countError, {
        feature: 'mfa_recovery',
        operation: 'count_remaining_recovery_codes',
      });
    }

    // 契約: success=true は「factorが解除された」ことの保証であり、「コードが消費された」
    // ことの保証ではない（#2039）。呼び出し元（mfa-verify page / ResetPasswordForm）は
    // MFAが解除されたことだけを前提にすればよく、remainingCodes はベストエフォートの参考値
    return {
      success: true as const,
      remainingCodes: typeof remainingCount === 'number' ? remainingCount : 0,
    };
  }

  /**
   * MFA無効化通知メールの送信（#2033）。factor削除が確定した経路（成功パス /
   * 途中で失敗した部分削除パスの両方）から呼ぶ。失敗しても呼び出し元の処理は続行する。
   */
  private async notifyMfaDisabled(
    adminClient: ReturnType<typeof createServiceRoleClient>,
    userId: string,
  ): Promise<void> {
    try {
      const { data: userData, error: getUserError } = await observeAuthOperation(
        'recovery_get_user_for_notification',
        () => adminClient.auth.admin.getUserById(userId),
        { feature: 'mfa_recovery' },
      );
      if (getUserError || !userData?.user?.email) {
        throw getUserError ?? new Error('User email not found for MFA disabled notification');
      }

      const locale = await getUserLocale(this.supabase, userId).catch(() => 'en' as const);

      try {
        await sendMfaDisabledEmail({
          email: userData.user.email,
          userName: getDisplayName(userData.user, 'there'),
          locale,
        });
      } catch (error) {
        const original =
          error instanceof Error
            ? error
            : new Error('MFA disabled notification email failed', { cause: error });
        captureUnexpectedError(original, {
          feature: 'mfa_recovery',
          operation: 'send_mfa_disabled_email',
          source: 'resend',
        });
      }
    } catch (error) {
      // getUserById 自体の失敗は observeAuthOperation が既に 'supabase_auth' として
      // capture 済み（同一 Error インスタンスなら capturedErrors の重複排除が効く）。
      // ここは「email が見つからない」など observeAuthOperation を経由しない失敗を、
      // 誤って 'resend' 起因のように見せずに拾うためのフォールバック
      const original =
        error instanceof Error
          ? error
          : new Error('Failed to resolve user for MFA disabled notification', { cause: error });
      captureUnexpectedError(original, {
        feature: 'mfa_recovery',
        operation: 'recovery_get_user_for_notification',
        source: 'supabase_auth',
      });
    }
  }
}

export function createRecoveryService(supabase: SupabaseClient<Database>): RecoveryService {
  return new RecoveryService(supabase);
}
