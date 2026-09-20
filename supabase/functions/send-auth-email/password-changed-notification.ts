import type { WebhookPayload } from '../_shared/types.ts';

import type { AuthEmailRecipientRole } from './idempotency.ts';
import { authEmailSubjects, type AuthEmailLocale } from './subjects.ts';

export const PASSWORD_CHANGED_NOTIFICATION_ACTION = 'password_changed_notification';

export interface PasswordChangedNotificationEmail {
  to: string;
  subject: string;
  recipientRole: AuthEmailRecipientRole;
  userName: string;
}

export type PasswordChangedNotificationResolution =
  | { status: 'send'; emails: PasswordChangedNotificationEmail[] }
  | { status: 'suppressed' }
  | { status: 'suppression_lookup_failed'; error: unknown };

/**
 * Auth の password change event だけを通知メールへ変換する。
 * クライアント入力や任意の送信 endpoint を根拠にしないことで反復送信を閉じる。
 */
export async function resolvePasswordChangedNotificationEmails({
  emailActionType,
  user,
  locale,
  isEmailSuppressed,
}: {
  emailActionType: string;
  user: WebhookPayload['user'];
  locale: AuthEmailLocale;
  isEmailSuppressed: (email: string) => Promise<boolean>;
}): Promise<PasswordChangedNotificationResolution | undefined> {
  if (emailActionType !== PASSWORD_CHANGED_NOTIFICATION_ACTION) return undefined;

  try {
    if (await isEmailSuppressed(user.email.toLowerCase())) {
      return { status: 'suppressed' };
    }
  } catch (error) {
    // 配信可否を判定できない時は、既知の不達先へ送るリスクを取らない。
    return { status: 'suppression_lookup_failed', error };
  }

  return {
    status: 'send',
    emails: [
      {
        to: user.email,
        subject: authEmailSubjects[locale].password_changed_notification,
        recipientRole: 'single',
        userName: user.user_metadata.full_name || '',
      },
    ],
  };
}
