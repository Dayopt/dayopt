import { Button } from '@dayopt/components';
import { SignupCtaLink } from '@web/shell/analytics/SignupCtaLink';

import styles from './LandingPage.module.css';

export interface PricingOfferCopy {
  title: string;
  description: string;
  perMonth: string;
  trial: string;
  features: string[];
  afterTrial: string;
  renewal: string;
  details: string;
  cta: string;
}

/** A single offer, with its trial, renewal and retained data explained together. */
export function PricingOffer({ price, copy }: { price: string; copy: PricingOfferCopy }) {
  return (
    <div className={styles.pricingOffer}>
      <div className={styles.offerSummary}>
        <h3>{copy.title}</h3>
        <p className={styles.offerDescription}>{copy.description}</p>
        <p className={styles.offerAmount}>
          {price} <span>{copy.perMonth}</span>
        </p>
        <p className={styles.offerTrial}>{copy.trial}</p>
        <Button variant="primary" size="lg" asChild>
          <SignupCtaLink ctaId="pricing_pro">
            {copy.cta} <span aria-hidden="true">↗</span>
          </SignupCtaLink>
        </Button>
      </div>
      <div className={styles.offerDetails}>
        <ul>
          {copy.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        <p>{copy.afterTrial}</p>
        <p>{copy.renewal}</p>
        <a href="#faq" className={styles.textLink}>
          {copy.details} <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}
