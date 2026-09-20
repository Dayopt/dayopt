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

/**
 * Auth の password change event だけを通知メールへ変換する。
 * クライアント入力や任意の送信 endpoint を根拠にしないことで反復送信を閉じる。
 */
export function resolvePasswordChangedNotificationEmails({
  emailActionType,
  user,
  locale,
}: {
  emailActionType: string;
  user: WebhookPayload['user'];
  locale: AuthEmailLocale;
}): PasswordChangedNotificationEmail[] | undefined {
  if (emailActionType !== PASSWORD_CHANGED_NOTIFICATION_ACTION) return undefined;

  return [
    {
      to: user.email,
      subject: authEmailSubjects[locale].password_changed_notification,
      recipientRole: 'single',
      userName: user.user_metadata.full_name || '',
    },
  ];
}
