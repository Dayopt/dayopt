/**
 * Trial Start Email Template
 * 7日間Pro無料トライアル開始時に送信
 *
 * トリガー: checkout.session.completed (status=trialing)
 */

import { Body, Button, Container, Head, Html, Section, Text } from 'react-email';

import { dayoptUrls } from '@dayopt/config';

import { createEmailTranslator, type EmailLocale } from './i18n';
import * as styles from './styles';

export interface TrialStartEmailProps {
  userName: string;
  trialEndDate: string;
  locale?: EmailLocale;
  appUrl?: string;
}

export function TrialStartEmail({
  userName,
  trialEndDate,
  locale = 'en',
  appUrl = dayoptUrls.product,
}: TrialStartEmailProps) {
  const t = createEmailTranslator(locale);
  return (
    <Html>
      <Head />
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Section style={styles.section}>
            <Text style={styles.heading}>{t('trialStart.heading')}</Text>
            <Text style={styles.paragraph}>
              {userName
                ? t('emailCommon.greeting', { userName })
                : t('emailCommon.greetingFallback')}
            </Text>
            <Text style={styles.paragraph}>{t('trialStart.body')}</Text>
            <Section style={styles.infoBox}>
              <Text style={styles.infoBoxLabel}>{t('trialStart.labelTrialEnds')}</Text>
              <Text style={styles.infoBoxValue}>{trialEndDate}</Text>
            </Section>
            <Text style={styles.paragraph}>{t('trialStart.proFeaturesIntro')}</Text>
            <Section style={styles.infoBox}>
              <Text style={{ ...styles.paragraph, margin: '0 0 8px' }}>
                - {t('trialStart.featureLongRange')}
              </Text>
              <Text style={{ ...styles.paragraph, margin: '0 0 8px' }}>
                - {t('trialStart.featureGoogleCalendar')}
              </Text>
              <Text style={{ ...styles.paragraph, margin: '0' }}>
                - {t('trialStart.featureApi')}
              </Text>
            </Section>
            <Text style={styles.paragraph}>{t('trialStart.noActionNote')}</Text>
            <Button style={styles.button} href={`${appUrl}/`}>
              {t('trialStart.ctaButton')}
            </Button>
            <Text style={styles.footer}>{t('emailCommon.teamSignature')}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default TrialStartEmail;
