/**
 * Welcome Email Template
 * 新規ユーザー登録時のウェルカムメール
 */

import { Body, Button, Container, Head, Html, Link, Section, Text } from 'react-email';

import { dayoptUrls } from '@dayopt/config';

import { createEmailTranslator, type EmailLocale } from './i18n';
import * as styles from './styles';

export interface WelcomeEmailProps {
  userName: string;
  locale?: EmailLocale;
  appUrl?: string;
}

export function WelcomeEmail({
  userName,
  locale = 'en',
  appUrl = dayoptUrls.product,
}: WelcomeEmailProps) {
  const t = createEmailTranslator(locale);
  const supportEmail = t('emailCommon.supportEmail');
  const questionsLine = t('emailCommon.questionsLine', { supportEmail });
  const [beforeEmail, afterEmail] = questionsLine.split(supportEmail);

  return (
    <Html>
      <Head />
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Section style={styles.section}>
            <Text style={styles.heading}>{t('welcome.heading')}</Text>
            <Text style={styles.paragraph}>
              {userName
                ? t('emailCommon.greeting', { userName })
                : t('emailCommon.greetingFallback')}
            </Text>
            <Text style={styles.paragraph}>{t('welcome.body')}</Text>
            <Text style={styles.paragraph}>{t('welcome.valueProp')}</Text>
            <Button style={styles.button} href={`${appUrl}/`}>
              {t('welcome.ctaButton')}
            </Button>
            <Text style={styles.paragraph}>
              {beforeEmail}
              <Link style={styles.link} href={`mailto:${supportEmail}`}>
                {supportEmail}
              </Link>
              {afterEmail}
            </Text>
            <Text style={styles.footer}>{t('emailCommon.teamSignature')}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default WelcomeEmail;
