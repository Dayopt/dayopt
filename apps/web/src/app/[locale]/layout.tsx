import { routing, type Locale } from '@dayopt/i18n/routing';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Document } from '@web/shell/layout/Document';
import { BrowserTelemetry } from '@web/shell/privacy/BrowserTelemetry';
import { CookieConsentBanner } from '@web/shell/privacy/CookieConsentBanner';
import { japaneseBodyFonts } from '@web/styles/fonts/preloads';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Ensure that the incoming `locale` is valid
  if (!routing.locales.includes(locale as Locale)) {
    notFound();
  }

  // Enable static rendering
  setRequestLocale(locale);
  await getMessages();

  return (
    <Document locale={locale}>
      {locale === 'ja' &&
        japaneseBodyFonts.map((href) => (
          <link
            key={href}
            rel="preload"
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
            href={href}
          />
        ))}
      {children}
      <BrowserTelemetry />
      <CookieConsentBanner />
    </Document>
  );
}
