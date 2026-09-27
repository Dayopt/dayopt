/**
 * Password Changed Notification Email Template
 * パスワード変更完了時のセキュリティ通知
 *
 * Supabase Auth の password_changed_notification フローで使用。
 */

import { Body, Container, Head, Html, Link, Preview, Section, Text } from '@react-email/components';

import * as styles from './styles.tsx';

type Locale = 'en' | 'ja';

const SUPPORT_EMAIL = 'support@dayopt.app';

const i18n = {
  en: {
    preview: 'The password for your Dayopt account was changed.',
    heading: 'Your password was changed',
    greeting: (name: string) => (name ? `Hi ${name},` : 'Hi there,'),
    body: 'The password for your Dayopt account was changed.',
    warningBefore: "If you didn't make this change, ",
    resetLinkText: 'request a password reset',
    warningBetween: ' immediately and contact us at ',
    warningAfter: '.',
    teamSignature: 'The Dayopt Team',
  },
  ja: {
    preview: 'Dayopt アカウントのパスワードが変更されました。',
    heading: 'パスワードが変更されました',
    greeting: (name: string) => (name ? `${name}さん、こんにちは。` : 'こんにちは。'),
    body: 'Dayopt アカウントのパスワードが変更されました。',
    warningBefore: 'この変更に覚えがない場合は、すぐに',
    resetLinkText: 'パスワードのリセットをリクエスト',
    warningBetween: 'し、',
    warningAfter: 'までご連絡ください。',
    teamSignature: 'Dayopt チーム',
  },
} as const;

export interface PasswordChangedEmailProps {
  userName: string;
  locale?: Locale;
  appUrl?: string;
}

export function PasswordChangedEmail({
  userName,
  locale = 'en',
  appUrl = 'https://app.dayopt.app',
}: PasswordChangedEmailProps) {
  const t = i18n[locale];
  const resetRequestUrl = `${appUrl}/auth/password`;

  return (
    <Html lang={locale}>
      <Head />
      <Body style={styles.main}>
        <Preview>{t.preview}</Preview>
        <Container style={styles.container}>
          <Section style={styles.section}>
            <Text style={styles.heading}>{t.heading}</Text>
            <Text style={styles.paragraph}>{t.greeting(userName)}</Text>
            <Text style={styles.paragraph}>{t.body}</Text>
            <Text style={styles.paragraph}>
              {t.warningBefore}
              <Link style={styles.link} href={resetRequestUrl}>
                {t.resetLinkText}
              </Link>
              {t.warningBetween}
              <Link style={styles.link} href={`mailto:${SUPPORT_EMAIL}`}>
                {SUPPORT_EMAIL}
              </Link>
              {t.warningAfter}
            </Text>
            <Text style={styles.footer}>{t.teamSignature}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
