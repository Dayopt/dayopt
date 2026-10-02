import { appTrialDays, dayoptPricing } from '@dayopt/billing';
import { Container } from '@dayopt/components';
import { getTranslations } from 'next-intl/server';

import { PricingOffer } from './landing/PricingOffer';

interface PricingSectionProps {
  locale: string;
}

export async function PricingSection({ locale }: PricingSectionProps) {
  const t = await getTranslations({ locale, namespace: 'marketing.pricing.singlePlan' });
  return (
    <section id="pricing" className="py-20">
      <Container>
        <PricingOffer
          price={dayoptPricing.pro.displayPrice}
          copy={{
            title: t('title'),
            description: t('description'),
            perMonth: t('perMonth'),
            trial: t('trial', { days: appTrialDays }),
            features: t.raw('features') as string[],
            afterTrial: t('afterTrial'),
            renewal: t('renewal'),
            details: t('details'),
            cta: t('cta'),
          }}
        />
      </Container>
    </section>
  );
}
