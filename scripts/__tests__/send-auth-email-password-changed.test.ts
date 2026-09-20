/** Auth Hook のパスワード変更通知契約。 */
import { describe, expect, it } from 'vitest';

import type { WebhookPayload } from '../../supabase/functions/_shared/types.ts';
import {
  PASSWORD_CHANGED_NOTIFICATION_ACTION,
  resolvePasswordChangedNotificationEmails,
} from '../../supabase/functions/send-auth-email/password-changed-notification.ts';
import { authEmailSubjects } from '../../supabase/functions/send-auth-email/subjects.ts';

const user: WebhookPayload['user'] = {
  id: 'user-1',
  email: 'user@example.com',
  user_metadata: { full_name: 'Tomoya' },
};

describe('send-auth-email password changed notification', () => {
  it.each([
    ['en', 'Your Dayopt password was changed'],
    ['ja', 'Dayopt パスワードが変更されました'],
  ] as const)('%s の件名を Auth Hook の action に持つ', (locale, subject) => {
    expect(
      (authEmailSubjects[locale] as Record<string, string>).password_changed_notification,
    ).toBe(subject);
  });

  it.each(['en', 'ja'] as const)(
    '%s の password_changed_notification を1通の通知へ変換する',
    async (locale) => {
      const result = await resolvePasswordChangedNotificationEmails({
        emailActionType: PASSWORD_CHANGED_NOTIFICATION_ACTION,
        user,
        locale,
        isEmailSuppressed: async () => false,
      });

      expect(result?.status).toBe('send');
      if (!result || result.status !== 'send') throw new Error('expected send result');
      expect(result.emails).toHaveLength(1);
      expect(result.emails[0]).toMatchObject({
        to: 'user@example.com',
        subject: authEmailSubjects[locale].password_changed_notification,
        recipientRole: 'single',
        userName: 'Tomoya',
      });
    },
  );

  it('別の Auth action は横取りせず suppression も検索しない', async () => {
    let lookupCount = 0;
    expect(
      await resolvePasswordChangedNotificationEmails({
        emailActionType: 'recovery',
        user,
        locale: 'en',
        isEmailSuppressed: async () => {
          lookupCount += 1;
          return false;
        },
      }),
    ).toBeUndefined();
    expect(lookupCount).toBe(0);
  });

  it('表示名が無ければテンプレート側のロケール別 fallback を使える', async () => {
    const result = await resolvePasswordChangedNotificationEmails({
      emailActionType: PASSWORD_CHANGED_NOTIFICATION_ACTION,
      user: { ...user, user_metadata: {} },
      locale: 'ja',
      isEmailSuppressed: async () => false,
    });

    expect(result?.status).toBe('send');
    if (!result || result.status !== 'send') throw new Error('expected send result');
    expect(result.emails[0]?.userName).toBe('');
  });

  it('suppression 済みなら Resend へ渡すメールを作らない', async () => {
    let lookedUpEmail = '';
    const result = await resolvePasswordChangedNotificationEmails({
      emailActionType: PASSWORD_CHANGED_NOTIFICATION_ACTION,
      user: { ...user, email: 'User@Example.com' },
      locale: 'en',
      isEmailSuppressed: async (email) => {
        lookedUpEmail = email;
        return email === 'user@example.com';
      },
    });

    expect(result).toEqual({ status: 'suppressed' });
    expect(lookedUpEmail).toBe('user@example.com');
  });

  it('suppression を判定できなければ fail-closed でメールを作らない', async () => {
    const lookupError = new Error('database unavailable');
    const result = await resolvePasswordChangedNotificationEmails({
      emailActionType: PASSWORD_CHANGED_NOTIFICATION_ACTION,
      user,
      locale: 'en',
      isEmailSuppressed: async () => Promise.reject(lookupError),
    });

    expect(result).toEqual({ status: 'suppression_lookup_failed', error: lookupError });
  });
});
