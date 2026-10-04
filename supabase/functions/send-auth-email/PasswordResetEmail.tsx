/**
 * Password Reset Email Template
 * パスワードリセットリクエスト時のメール
 *
 * Supabase Auth の recovery フローで使用
 */

import { Body, Button, Container, Head, Html, Link, Section, Text } from '@react-email/components';

import * as styles from './styles.tsx';

type Locale = 'en' | 'ja';

const i18n = {
  en: {
    heading: 'Reset your password',
    greeting: (name: string) => (name ? `Hi ${name},` : 'Hi there,'),
    body: 'We received a request to reset your Dayopt password. Click the button below to choose a new password.',
    ctaButton: 'Reset Password',
    buttonFallback: "If the button doesn't work, copy and paste this link into your browser:",
    expiryNote: 'This link expires. If it has expired, request a new link.',
    ignoreLine:
      "If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.",
    securityNote: (appUrl: string) =>
      `If you're concerned about your account security, please visit your settings to update your password.`,
    settingsLinkText: 'your settings',
    teamSignature: 'The Dayopt Team',
  },
  ja: {
    heading: 'パスワードをリセット',
    greeting: (name: string) => (name ? `${name}さん、こんにちは。` : 'こんにちは。'),
    body: 'Dayopt パスワードのリセットリクエストを受け付けました。以下のボタンをクリックして、新しいパスワードを設定してください。',
    ctaButton: 'パスワードをリセット',
    buttonFallback:
      'ボタンが機能しない場合は、以下のリンクをブラウザにコピー＆ペーストしてください：',
    expiryNote:
      'このリンクには有効期限があります。期限が切れた場合は、再度リンクをリクエストしてください。',
    ignoreLine:
      'パスワードリセットをリクエストした覚えがない場合は、このメールを無視してください。パスワードは変更されません。',
    securityNote: (appUrl: string) =>
      'アカウントのセキュリティが心配な場合は、設定からパスワードを更新してください。',
    settingsLinkText: '設定',
    teamSignature: 'Dayopt チーム',
  },
} as const;

export interface PasswordResetEmailProps {
  userName: string;
  resetUrl: string;
  locale?: Locale;
  appUrl?: string;
}

export function PasswordResetEmail({
  userName,
  resetUrl,
  locale = 'en',
  appUrl = 'https://app.dayopt.app',
}: PasswordResetEmailProps) {
  const t = i18n[locale];
  return (
    <Html>
      <Head />
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Section style={styles.section}>
            <Text style={styles.heading}>{t.heading}</Text>
            <Text style={styles.paragraph}>{t.greeting(userName)}</Text>
            <Text style={styles.paragraph}>{t.body}</Text>
            <Button style={styles.button} href={resetUrl}>
              {t.ctaButton}
            </Button>
            <Text style={styles.smallText}>{t.buttonFallback}</Text>
            <Text style={{ ...styles.smallText, wordBreak: 'break-all' }}>
              <Link style={styles.link} href={resetUrl}>
                {resetUrl}
              </Link>
            </Text>
            <Text style={styles.smallText}>{t.expiryNote}</Text>
            <Text style={styles.footer}>
              {t.ignoreLine}
              <br />
              <br />
              {t.securityNote(appUrl)}{' '}
              <Link style={styles.link} href={`${appUrl}/settings/account`}>
                {t.settingsLinkText}
              </Link>
              <br />
              <br />
              {t.teamSignature}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
