import { dayoptPricing } from '@dayopt/billing';
import { dayoptBrand, dayoptContact } from '@dayopt/config';
import { StructuredData } from '@web/components/seo/EnhancedSEO';

import { DocumentFrame } from './DocumentFrame';

/** Static metadata stays on the server; error documents share only the visual frame. */
export function Document({
  children,
  locale = 'en',
}: {
  children: React.ReactNode;
  locale?: string;
}) {
  return (
    <DocumentFrame
      locale={locale}
      head={
        <>
          <link
            rel="alternate"
            type="application/rss+xml"
            title="Dayopt Blog"
            href="/blog/feed.xml"
          />
          <link
            rel="alternate"
            type="application/rss+xml"
            title="Dayopt ブログ"
            hrefLang="ja"
            href="/ja/blog/feed.xml"
          />
          <StructuredData
            type="Organization"
            data={{
              name: dayoptBrand.name,
              alternateName: dayoptBrand.platformName,
              description: 'A calendar for your plans and records, and a clearer next day.',
              foundingDate: '2024-01-01',
              contactPoint: {
                '@type': 'ContactPoint',
                contactType: 'customer service',
                email: dayoptContact.contactEmail,
              },
            }}
          />
          <StructuredData
            type="WebSite"
            data={{
              name: dayoptBrand.platformName,
              alternateName: dayoptBrand.name,
            }}
          />
          <StructuredData
            type="SoftwareApplication"
            data={{
              name: dayoptBrand.name,
              description: 'Plan, execute, and reflect — a simple cycle to optimize your day.',
              applicationCategory: 'ProductivityApplication',
              operatingSystem: 'Web',
              offers: {
                '@type': 'Offer',
                price: dayoptPricing.pro.monthlyUsdCents / 100,
                priceCurrency: 'USD',
              },
            }}
          />
        </>
      }
    >
      {children}
    </DocumentFrame>
  );
}
