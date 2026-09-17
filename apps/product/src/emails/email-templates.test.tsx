import type { ReactElement } from 'react';

import { render } from 'react-email';
import { describe, expect, it } from 'vitest';

import { AccountDeletionEmail } from './AccountDeletionEmail';
import { CancellationConfirmEmail } from './CancellationConfirmEmail';
import { ConfirmEmail } from './ConfirmEmail';
import { EmailChangeEmail } from './EmailChangeEmail';
import { MagicLinkEmail } from './MagicLinkEmail';
import { PasswordChangedEmail } from './PasswordChangedEmail';
import { PasswordResetEmail } from './PasswordResetEmail';
import { PaymentFailedEmail } from './PaymentFailedEmail';
import { PaymentRecoveredEmail } from './PaymentRecoveredEmail';
import { ProStartEmail } from './ProStartEmail';
import { TrialStartEmail } from './TrialStartEmail';
import { WelcomeEmail } from './WelcomeEmail';

type EmailFixture = {
  name: string;
  element: ReactElement;
};

function countHtmlOccurrences(html: string, value: string): number {
  return html.split(value.replaceAll('&', '&amp;')).length - 1;
}

function createEmailFixtures(locale: 'en' | 'ja'): EmailFixture[] {
  return [
    {
      name: `WelcomeEmail (${locale})`,
      element: WelcomeEmail({ userName: 'Tomoya', locale }),
    },
    {
      name: `ConfirmEmail (${locale})`,
      element: ConfirmEmail({
        userName: 'Tomoya',
        confirmUrl: 'https://app.dayopt.app/auth/confirm?token=test',
        locale,
      }),
    },
    {
      name: `PasswordResetEmail (${locale})`,
      element: PasswordResetEmail({
        userName: 'Tomoya',
        resetUrl: 'https://app.dayopt.app/auth/reset?token=test',
        locale,
      }),
    },
    {
      name: `EmailChangeEmail current (${locale})`,
      element: EmailChangeEmail({
        userName: 'Tomoya',
        confirmUrl: 'https://app.dayopt.app/auth/confirm?token_hash=test&type=email_change',
        newEmail: 'new@example.com',
        variant: 'current',
        locale,
      }),
    },
    {
      name: `EmailChangeEmail new (${locale})`,
      element: EmailChangeEmail({
        userName: 'Tomoya',
        confirmUrl: 'https://app.dayopt.app/auth/confirm?token_hash=test&type=email_change',
        newEmail: 'new@example.com',
        variant: 'new',
        locale,
      }),
    },
    {
      name: `MagicLinkEmail (${locale})`,
      element: MagicLinkEmail({
        loginUrl: 'https://app.dayopt.app/auth/magic-link?token=test',
        locale,
      }),
    },
    {
      name: `TrialStartEmail (${locale})`,
      element: TrialStartEmail({ userName: 'Tomoya', trialEndDate: '2026-07-31', locale }),
    },
    {
      name: `ProStartEmail (${locale})`,
      element: ProStartEmail({ userName: 'Tomoya', locale }),
    },
    {
      name: `PaymentFailedEmail (${locale})`,
      element: PaymentFailedEmail({ userName: 'Tomoya', locale }),
    },
    {
      name: `PaymentRecoveredEmail (${locale})`,
      element: PaymentRecoveredEmail({ userName: 'Tomoya', locale }),
    },
    {
      name: `PasswordChangedEmail (${locale})`,
      element: PasswordChangedEmail({ userName: 'Tomoya', locale }),
    },
    {
      name: `CancellationConfirmEmail (${locale})`,
      element: CancellationConfirmEmail({
        userName: 'Tomoya',
        periodEndDate: '2026-07-31',
        locale,
      }),
    },
    {
      name: `AccountDeletionEmail (${locale})`,
      element: AccountDeletionEmail({
        userName: 'Tomoya',
        deletionDate: '2026-07-31',
        locale,
      }),
    },
  ];
}

describe('React Email templates', () => {
  it.each([...createEmailFixtures('en'), ...createEmailFixtures('ja')])(
    'renders $name as a complete HTML document',
    async ({ element }) => {
      const html = await render(element);

      expect(html).toMatch(/<!doctype html/i);
      expect(html).toContain('<html');
      expect(html.length).toBeGreaterThan(500);
    },
  );

  describe('generated auth email previews', () => {
    it('preserves the signup text, fallback name, and confirmation URL', async () => {
      const confirmUrl = 'https://app.dayopt.app/auth/confirm?token_hash=test&type=signup';
      const html = await render(ConfirmEmail({ userName: '', confirmUrl, locale: 'en' }));

      expect(html).toContain('Hi there,');
      expect(html).toContain('Confirm Email Address');
      expect(countHtmlOccurrences(html, confirmUrl)).toBe(3);
    });

    it('preserves the current Japanese fallback passed by the Edge handler', async () => {
      const html = await render(
        ConfirmEmail({
          userName: 'there',
          confirmUrl: 'https://app.dayopt.app/auth/confirm?token_hash=test&type=signup',
          locale: 'ja',
        }),
      );

      expect(html).toContain('thereさん、こんにちは。');
    });

    it('preserves the recovery text, duplicate settings wording, and reset URL', async () => {
      const resetUrl = 'https://app.dayopt.app/auth/reset?token_hash=test&type=recovery';
      const html = await render(PasswordResetEmail({ userName: 'Tomoya', resetUrl, locale: 'en' }));

      expect(html).toContain('This link will expire in 24 hours.');
      expect(html.match(/your settings/g)).toHaveLength(2);
      expect(html).toContain('href="https://app.dayopt.app/settings/account"');
      expect(countHtmlOccurrences(html, resetUrl)).toBe(3);
    });

    it('現アドレス宛は変更先アドレスを本文に出し、変更されない旨を伝える', async () => {
      const confirmUrl = 'https://app.dayopt.app/auth/confirm?token_hash=current&type=email_change';
      const html = await render(
        EmailChangeEmail({
          userName: 'Tomoya',
          confirmUrl,
          newEmail: 'new@example.com',
          variant: 'current',
          locale: 'en',
        }),
      );

      expect(html).toContain('new@example.com');
      expect(html).toContain('Approve Email Change');
      expect(html).toContain('Your email address will not change.');
      expect(countHtmlOccurrences(html, confirmUrl)).toBe(3);
    });

    it('新アドレス宛は承認文言を含まず、確認用の文言だけを出す', async () => {
      const confirmUrl = 'https://app.dayopt.app/auth/confirm?token_hash=new&type=email_change';
      const html = await render(
        EmailChangeEmail({
          userName: 'Tomoya',
          confirmUrl,
          newEmail: 'new@example.com',
          variant: 'new',
          locale: 'en',
        }),
      );

      expect(html).toContain('Confirm New Email Address');
      expect(html).not.toContain('Approve Email Change');
      expect(countHtmlOccurrences(html, confirmUrl)).toBe(3);
    });

    it('preserves the magic-link expiry and application link', async () => {
      const loginUrl = 'https://app.dayopt.app/auth/magic-link?token_hash=test&type=magic_link';
      const html = await render(MagicLinkEmail({ loginUrl, locale: 'ja' }));

      expect(html).toContain('このリンクは1時間で有効期限が切れます。');
      expect(html).toContain('href="https://app.dayopt.app"');
      expect(countHtmlOccurrences(html, loginUrl)).toBe(3);
    });
  });
});
