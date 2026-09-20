import 'server-only';

/**
 * Server-side Email Notifications
 *
 * 認証・アカウント処理から呼ぶ、クライアントに公開しない通知メール。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';

import { AccountDeletionEmail } from '@/emails/AccountDeletionEmail';
import { createEmailTranslator, type EmailLocale } from '@/emails/i18n';
import { MfaDisabledEmail } from '@/emails/MfaDisabledEmail';
import { WelcomeEmail } from '@/emails/WelcomeEmail';
import { getAppUrl } from '@/lib/app-url';
import { databaseTables } from '@/lib/database';
import { sendTransactionalEmail } from '@/lib/email/send';
import { captureUnexpectedDatabaseError } from '@/lib/sentry';
import { handleServiceError } from '@/lib/trpc/errors';

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
 * server-side service 経路のメール送信
 *
 * 送信と suppression 判定そのものは `@/lib/email/send` が持つ（Stripe webhook と共有。
 * #2789）。ここはその結果を server-side service の契約へ翻訳するだけ — 失敗は `handleServiceError` で
 * TRPCError にして throw し、suppressed は成功として返す（呼び出し元の本体処理を
 * 巻き戻さない。セキュリティ通知の痕跡は send 側が Sentry へ残す）。
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
  const result = await sendTransactionalEmail({
    to,
    subject,
    react,
    context,
    securityNotification,
  });

  if (result.status === 'failed') {
    if (result.reason === 'suppression_lookup') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unable to verify email delivery status',
        cause: result.error,
      });
    }
    handleServiceError(result.error);
  }

  if (result.status === 'suppressed') {
    return { success: true as const, emailId: undefined, suppressed: true as const };
  }

  return { success: true as const, emailId: result.emailId };
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
