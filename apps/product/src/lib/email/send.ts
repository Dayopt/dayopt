import 'server-only';

/**
 * トランザクションメール送信の唯一の経路
 *
 * サプレッションリスト（bounce / complaint 済みアドレス）の判定と Resend への送信を
 * ここに集約する。#2789 まで Stripe webhook が Resend を直接叩いており、bounce / complaint
 * 済みアドレスへ課金メールを送り続けて配信評価を落としていた。配信評価は認証メールと
 * ドメインを共有するため、影響は課金に閉じない。
 *
 * **throw しない。** tRPC 経路（`router.ts`）は `failed` を受けて `handleServiceError` で
 * TRPCError へ変換し、webhook 経路は Sentry へ流して 200 を返す。呼び出し側で意味が
 * 違うので、この層は結果を返すだけにする。
 */

import { Resend } from 'resend';

import { env } from '@/env';
import { databaseTables } from '@/lib/database';
import { logger } from '@/lib/logger';
import { captureUnexpectedDatabaseError, captureUnexpectedError } from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';

function getResend() {
  return new Resend(env.RESEND_API_KEY);
}

const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

/**
 * 送信結果。`failed` の `reason` は呼び出し側が意味を変えずに翻訳するために要る
 * （tRPC 経路は suppression 判定の失敗を「配信状態を確認できない」として返し、
 * provider 失敗とは別の message にする）。
 */
type TransactionalEmailResult =
  | { status: 'sent'; emailId: string | undefined }
  | { status: 'suppressed' }
  | { status: 'failed'; reason: 'provider' | 'suppression_lookup'; error: Error };

/**
 * サプレッションリストをチェックし、送信をスキップすべきか判定する。
 *
 * 判定できなければ送らない（fail-closed）。bounce / complaint 済みか分からないまま
 * 送ると、この関数が守っている配信評価そのものを落とすため。
 */
async function isEmailSuppressed(email: string): Promise<boolean> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from(databaseTables.emailSuppressions)
    .select('reason')
    .eq('email', email.toLowerCase())
    .limit(1);

  if (error) {
    logger.error('Failed to check email suppression');
    throw captureUnexpectedDatabaseError(error, {
      feature: 'email',
      operation: 'check_email_suppression',
    });
  }

  return data.length > 0;
}

/**
 * Resend でトランザクションメールを送る共通経路
 *
 * `securityNotification: true`（MFA 無効化・パスワード変更などセキュリティ通知）の場合、
 * suppressed でも `logger.warn` だけでなく Sentry へ痕跡を残す（#2043）。配信評価保護という
 * suppression 本来の目的は維持しつつ、セキュリティ通知が無痕跡で落ちるのを防ぐ。
 */
export async function sendTransactionalEmail({
  to,
  subject,
  react,
  context,
  securityNotification = false,
}: {
  to: string;
  subject: string;
  react: React.ReactElement;
  context: string;
  securityNotification?: boolean;
}): Promise<TransactionalEmailResult> {
  let suppressed: boolean;
  try {
    suppressed = await isEmailSuppressed(to);
  } catch (error) {
    // 判定できない時は送らない（fail-closed）。capture は `isEmailSuppressed` が済ませている。
    return { status: 'failed', reason: 'suppression_lookup', error: toError(error) };
  }

  if (suppressed) {
    logger.warn(`${context} skipped: email suppressed`);
    if (securityNotification) {
      captureUnexpectedError(new Error(`${context} skipped: recipient is suppressed`), {
        feature: 'email',
        operation: 'send_security_notification_suppressed',
      });
    }
    return { status: 'suppressed' };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: `Dayopt <${FROM_EMAIL}>`,
      to,
      subject,
      react,
    });

    if (error) {
      logger.error(`${context} failed`);
      return { status: 'failed', reason: 'provider', error: toError(error) };
    }

    logger.info(`${context} sent`, { emailId: data?.id });
    return { status: 'sent', emailId: data?.id };
  } catch (error) {
    // provider client の生成・送信が throw する経路。ここで止めるのが、webhook 側で
    // 200 を返し続けられる根拠。
    logger.error(`${context} failed`);
    return { status: 'failed', reason: 'provider', error: toError(error) };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Transactional email delivery failed', { cause: error });
}
