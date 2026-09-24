import { Button, Container } from '@dayopt/components';
import { getTranslations } from 'next-intl/server';
import { Fragment } from 'react';

import { SignupCtaLink } from '@web/shell/analytics/SignupCtaLink';

import { HeroProductMocks } from './HeroProductMocks';

interface HeroSectionProps {
  locale: string;
}

export async function HeroSection({ locale }: HeroSectionProps) {
  const t = await getTranslations({ locale, namespace: 'marketing' });

  const words = t.raw('hero.headline.words') as string[];
  const highlightIndex = t.raw('hero.headline.highlightIndex') as number;

  return (
    <section className="from-background via-background to-container/30 bg-gradient-to-b py-16 sm:py-24 lg:py-32 lg:pb-40">
      <Container>
        <div className="relative mx-auto max-w-4xl text-center">
          {/* Ambient glow — 静止。呼吸アニメーションは廃止した */}
          <div className="hero-ambient-glow" />

          <h1 className="text-6xl leading-[1.1] font-medium tracking-[-0.04em]">
            {words.map((word, i) => (
              <Fragment key={word}>
                {i > 0 && locale !== 'ja' ? ' ' : null}
                <span
                  className={`inline-block ${
                    i === highlightIndex ? 'text-primary' : 'text-foreground'
                  }`}
                >
                  {word}
                </span>
              </Fragment>
            ))}
          </h1>

          {/* Subcopy */}
          <p className="text-muted-foreground mx-auto mt-6 max-w-3xl text-lg sm:text-xl">
            {t('hero.subcopy')}
          </p>

          {/* CTA */}
          <div className="mt-12 flex items-center justify-center">
            <Button variant="primary" size="lg" asChild>
              <SignupCtaLink ctaId="hero">{t('hero.ctaPrimary')}</SignupCtaLink>
            </Button>
          </div>

          {/* Annotation */}
          <p className="text-muted-foreground mt-4 text-sm">{t('hero.ctaNote')}</p>
        </div>

        {/* Visual bridge — gradient line */}
        <div className="from-background to-border/50 pointer-events-none mx-auto mt-8 h-10 w-px bg-gradient-to-b" />

        {/* Product mocks carousel */}
        <div className="mt-6 sm:mt-8">
          <HeroProductMocks
            labels={{
              plan: t('hero.mocks.plan'),
              track: t('hero.mocks.track'),
              learn: t('hero.mocks.learn'),
            }}
          />
        </div>
      </Container>
    </section>
  );
}
