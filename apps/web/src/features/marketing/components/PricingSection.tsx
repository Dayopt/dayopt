import { dayoptPlans, dayoptPricing } from '@dayopt/billing';
import {
  Badge,
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
import { Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHeader } from './SectionHeader';

interface PricingSectionProps {
  locale: string;
}

export async function PricingSection({ locale }: PricingSectionProps) {
  const t = await getTranslations({ locale, namespace: 'marketing' });

  const freePlan = dayoptPlans.free;
  const proPlan = dayoptPlans.pro;
  const freeFeatures = t.raw('pricing.plans.free.features') as string[];
  const proHighlights = t.raw('pricing.plans.pro.highlights') as string[];

  return (
    <section id="pricing" className="pt-20 pb-24 sm:pt-36 sm:pb-32">
      <Container>
        <SectionHeader
          icon={
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
          label={t('pricing.title')}
          headline={
            <>
              {t('pricing.subtitle.line1')}
              <br />
              {t('pricing.subtitle.line2')}
            </>
          }
          subtitle={t('pricing.trialNote')}
        />

        {/* 2-Card Grid */}
        <div className="mx-auto grid max-w-4xl items-start gap-8 md:grid-cols-2">
          {/* Free Card */}
          <Card className="border-border flex flex-col rounded-2xl shadow-none">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">{t(`pricing.plans.${freePlan.id}.name`)}</CardTitle>
              <CardDescription className="mt-2">
                {t('pricing.plans.free.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <div className="mb-8 text-center">
                <span className="text-foreground text-4xl font-medium tabular-nums">
                  {dayoptPricing[freePlan.id].displayPrice}
                </span>
              </div>
              <ul className="space-y-4">
                {freeFeatures.map((feature, index) => (
                  <li key={index} className="flex items-start gap-4">
                    <Check className="text-primary mt-1 size-5 shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button className="w-full" variant="outline" size="lg" asChild>
                <a href={dayoptProductUrls.signup}>{t('pricing.plans.free.cta')}</a>
              </Button>
            </CardFooter>
          </Card>

          {/* Pro Card (Highlighted) */}
          <Card className="border-primary ring-primary/20 bg-card relative flex flex-col rounded-2xl shadow-sm ring-2 md:scale-105">
            <Badge className="bg-primary text-primary-foreground absolute -top-3 left-1/2 -translate-x-1/2">
              {t('pricing.plans.pro.badge')}
            </Badge>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">{t(`pricing.plans.${proPlan.id}.name`)}</CardTitle>
              <CardDescription className="mt-2">
                {t('pricing.plans.pro.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <div className="mb-2 text-center">
                <span className="text-foreground text-4xl font-medium tabular-nums">
                  {dayoptPricing[proPlan.id].displayPrice}
                </span>
                <span className="text-muted-foreground">{t('pricing.plans.pro.period')}</span>
              </div>
              <p className="text-muted-foreground mb-8 text-center text-sm">
                {t('pricing.plans.pro.priceDaily')}
              </p>
              <ul className="space-y-4">
                {proHighlights.map((highlight, index) => (
                  <li key={index} className="flex items-start gap-4">
                    <Check className="text-primary mt-1 size-5 shrink-0" />
                    <span className="text-muted-foreground">{highlight}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button className="w-full" variant="primary" size="lg" asChild>
                <a href={dayoptProductUrls.signup}>{t('pricing.plans.pro.cta')}</a>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </Container>
    </section>
  );
}
