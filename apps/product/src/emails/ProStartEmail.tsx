/**
 * Pro Start Email Template
 * Proサブスクリプション開始時に送信
 *
 * トリガー: checkout.session.completed (status=active) or
 *          customer.subscription.updated (trialing → active)
 */

import { Body, Button, Container, Head, Html, Section, Text } from 'react-email';

import { dayoptUrls } from '@dayopt/config';

import { createEmailTranslator, type EmailLocale } from './i18n';
import * as styles from './styles';

export interface ProStartEmailProps {
  userName: string;
  locale?: EmailLocale;
  appUrl?: string;
}

export function ProStartEmail({
  userName,
  locale = 'en',
  appUrl = dayoptUrls.product,
}: ProStartEmailProps) {
  const t = createEmailTranslator(locale);
  return (
    <Html>
      <Head />
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Section style={styles.section}>
            <Text style={styles.heading}>{t('proStart.heading')}</Text>
            <Text style={styles.paragraph}>
              {userName
                ? t('emailCommon.greeting', { userName })
                : t('emailCommon.greetingFallback')}
            </Text>
            <Text style={styles.paragraph}>{t('proStart.body')}</Text>
            <Text style={styles.paragraph}>{t('proStart.fullAccessIntro')}</Text>
            <Section style={styles.infoBox}>
              <Text style={{ ...styles.paragraph, margin: '0 0 8px' }}>
                - {t('proStart.featureLongRange')}
              </Text>
              <Text style={{ ...styles.paragraph, margin: '0 0 8px' }}>
                - {t('proStart.featureGoogleCalendar')}
              </Text>
              <Text style={{ ...styles.paragraph, margin: '0' }}>- {t('proStart.featureApi')}</Text>
            </Section>
            <Text style={styles.paragraph}>{t('proStart.manageHint')}</Text>
            <Button style={styles.button} href={`${appUrl}/`}>
              {t('proStart.ctaButton')}
            </Button>
            <Text style={styles.footer}>{t('emailCommon.teamSignature')}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default ProStartEmail;
