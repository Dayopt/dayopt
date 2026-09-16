import 'server-only';

/**
 * Email tRPC Router
 *
 * メール送信のtRPCエンドポイント
 * Resend + React Emailを使用
 */

import { TRPCError } from '@trpc/server';
import { Resend } from 'resend';
import { z } from 'zod';

import type { SupabaseClient } from '@supabase/supabase-js';

import { AccountDeletionEmail } from '@/emails/AccountDeletionEmail';
import { createEmailTranslator, type EmailLocale } from '@/emails/i18n';
import { MfaDisabledEmail } from '@/emails/MfaDisabledEmail';
import { PasswordChangedEmail } from '@/emails/PasswordChangedEmail';
import { WelcomeEmail } from '@/emails/WelcomeEmail';
import { env } from '@/env';
import { getAppUrl } from '@/lib/app-url';
import { databaseTables } from '@/lib/database';
import { logger } from '@/lib/logger';
import {
  captureUnexpectedDatabaseError,
  captureUnexpectedError,
  observeAuthOperation,
} from '@/lib/sentry';
import { createServiceRoleClient } from '@/lib/supabase/oauth';
import { handleServiceError } from '@/lib/trpc/errors';
import type { Context } from '@/lib/trpc/procedures';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';

function getResend() {
  return new Resend(env.RESEND_API_KEY);
}

const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const APP_URL = getAppUrl();

/**
 * ユーザーの preferred_locale を user_settings から取得する
 * 未設定の場合は 'en' にフォールバック
 */
/** メール文面の locale を user_settings から引く。削除処理は CASCADE 前に呼ぶ必要がある */
export async function getUserLocale(
  supabase: SupabaseClient,
  userId: string,
): Promise<EmailLocale> {
  const { data, error } = await supabase
    .from(databaseTables.userSettings)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw captureUnexpectedDatabaseError(error, {
      feature: 'email',
      operation: 'get_user_locale',
    });
  }
  const locale = (data as Record<string, unknown> | null)?.preferred_locale;
  return (locale as EmailLocale) ?? 'en';
}

/**
 * 送信先メールアドレスがログインユーザー自身のものか検証する
 * 他ユーザーへのスパム送信を防止
 */
async function verifyEmailOwnership(ctx: Context, inputEmail: string): Promise<void> {
  const {
    data: { user },
    error,
  } = await observeAuthOperation('email_verify_ownership', () => ctx.supabase.auth.getUser());

  if (error) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      cause: error,
    });
  }

  if (!user?.email || user.email !== inputEmail) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Can only send emails to your own address',
    });
  }
}

/**
 * サプレッションリストをチェックし、送信をスキップすべきか判定
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
    const original = captureUnexpectedDatabaseError(error, {
      feature: 'email',
      operation: 'check_email_suppression',
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unable to verify email delivery status',
      cause: original,
    });
  }

  return data.length > 0;
}

/**
 * Resend APIでメールを送信する共通ヘルパー
 *
 * サプレッションリスト（バウンス/苦情）に含まれるアドレスへの送信をスキップ。
 * `securityNotification: true`（MFA無効化・パスワード変更などセキュリティ通知）
 * の場合、suppressed でも `logger.warn` だけでなく Sentry へ痕跡を残す（#2043）。
 * 配信評価保護という suppression 本来の目的（bounce/complaint 済みアドレスへ
 * 送り続けない）は維持しつつ、セキュリティ通知が無痕跡で落ちるのを防ぐ。
 */
async function sendEmail({
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
}) {
  if (await isEmailSuppressed(to)) {
    logger.warn(`${context} skipped: email suppressed`);
    if (securityNotification) {
      captureUnexpectedError(new Error(`${context} skipped: recipient is suppressed`), {
        feature: 'email',
        operation: 'send_security_notification_suppressed',
      });
    }
    return { success: true as const, emailId: undefined, suppressed: true as const };
  }

  const { data, error } = await getResend().emails.send({
    from: `Dayopt <${FROM_EMAIL}>`,
    to,
    subject,
    react,
  });

  if (error) {
    logger.error(`${context} failed`);
    const original =
      error instanceof Error
        ? error
        : new Error('Transactional email provider failed', { cause: error });
    handleServiceError(original);
  }

  logger.info(`${context} sent`, { emailId: data?.id });
  return { success: true as const, emailId: data?.id };
}

/**
 * アカウント削除の通知メールを送る
 *
 * 削除処理そのもの（`features/auth/server/user-service.ts`）からも呼ぶため、
 * procedure ではなく関数として公開する。本文が「削除されました」と完了を伝えるので、
 * 呼ぶのは削除が確定したあと。locale を引数で受けるのは、削除後には
 * `user_settings` が CASCADE で消えていて引けないため。
 */
export async function sendAccountDeletionEmail({
  email,
  userName,
  locale,
}: {
  email: string;
  userName: string;
  locale: EmailLocale;
}) {
  const t = createEmailTranslator(locale);

  const deletionDate = new Date().toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return sendEmail({
    to: email,
    subject: t('accountDeletion.subject'),
    react: AccountDeletionEmail({
      userName,
      deletionDate,
      locale,
      appUrl: APP_URL,
    }),
    context: 'Account deletion email',
  });
}

/**
 * 新規登録の歓迎メールを送る
 *
 * サインアップ直後のサーバー経路（`features/auth/server/welcome-email.ts`）からのみ呼ぶため、
 * procedure ではなく関数として公開する。「1 ユーザー 1 通」の保証はここではなく、
 * 呼び出し元が `profiles.welcome_email_sent_at` を conditional UPDATE で掴むことで行う。
 */
export async function sendWelcomeEmail({
  email,
  userName,
  locale,
}: {
  email: string;
  userName: string;
  locale: EmailLocale;
}) {
  const t = createEmailTranslator(locale);

  return sendEmail({
    to: email,
    subject: t('welcome.subject'),
    react: WelcomeEmail({ userName, locale, appUrl: APP_URL }),
    context: 'Welcome email',
  });
}

/**
 * MFA無効化（リカバリーコードによる多要素認証解除）の通知メールを送る
 *
 * `features/auth/server/recovery-service.ts` の `RecoveryService.verify()` からのみ呼ぶ。
 * 攻撃者がクライアントを制御していても迂回できないよう、procedure ではなく
 * サーバー側の呼び出し元固定の関数として公開する（PasswordChangeDialog のような
 * client mutation 起点にしない）。送信失敗で検証成功自体は取り消さない。
 */
export async function sendMfaDisabledEmail({
  email,
  userName,
  locale,
}: {
  email: string;
  userName: string;
  locale: EmailLocale;
}) {
  const t = createEmailTranslator(locale);

  const disabledAt = new Date().toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return sendEmail({
    to: email,
    subject: t('mfaDisabled.subject'),
    react: MfaDisabledEmail({
      userName,
      disabledAt,
      locale,
      appUrl: APP_URL,
    }),
    context: 'MFA disabled email',
    securityNotification: true,
  });
}

/** トランザクショナルメール送信（ウェルカム / Trial / Pro / 課金 / アカウント削除）を提供する tRPC ルーター */
export const emailRouter = createTRPCRouter({
  sendPasswordChanged: protectedProcedure
    .meta({ description: 'パスワード変更通知メール送信' })
    .input(
      z.object({
        email: z.string().email(),
        userName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await verifyEmailOwnership(ctx, input.email);
        logger.info('Sending password changed email', { userId: ctx.userId });

        const locale = await getUserLocale(ctx.supabase, ctx.userId);
        const t = createEmailTranslator(locale);

        return sendEmail({
          to: input.email,
          subject: t('passwordChanged.subject'),
          react: PasswordChangedEmail({
            userName: input.userName,
            locale,
            appUrl: APP_URL,
          }),
          context: 'Password changed email',
          securityNotification: true,
        });
      } catch (error) {
        return handleServiceError(error);
      }
    }),
});
