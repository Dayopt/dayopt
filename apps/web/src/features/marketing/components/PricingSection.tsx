import { appTrialDays, dayoptPricing } from '@dayopt/billing';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Container,
} from '@dayopt/components';
import { dayoptProductUrls } from '@dayopt/config';
import { getTranslations } from 'next-intl/server';

interface PricingSectionProps {
  locale: string;
}

export async function PricingSection({ locale }: PricingSectionProps) {
  const t = await getTranslations({ locale, namespace: 'marketing.pricing.singlePlan' });
  return (
    <section id="pricing" className="py-20">
      <Container>
        <Card className="mx-auto max-w-xl">
          <CardHeader className="text-center">
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-4xl font-medium">
              {dayoptPricing.pro.displayPrice}
              <span className="text-sm">{t('perMonth')}</span>
            </p>
            <p>{t('trial', { days: appTrialDays })}</p>
            <p className="text-muted-foreground">{t('included')}</p>
            <p className="text-muted-foreground text-sm">{t('afterTrial')}</p>
          </CardContent>
          <CardFooter>
            <Button className="w-full" size="lg" asChild>
              <a href={dayoptProductUrls.signup}>{t('cta')}</a>
            </Button>
          </CardFooter>
        </Card>
      </Container>
    </section>
  );
}
