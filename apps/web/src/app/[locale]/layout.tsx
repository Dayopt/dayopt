import { routing, type Locale } from '@dayopt/i18n/routing';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

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

  const messages = await getMessages();

  // LP の文言は Server Component で取得し、操作に必要な copy だけを渡す。
  // client で翻訳する contact を残し、legal と LP 本文の二重配信を避ける。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest destructuring で使わない namespace を除外する
  const { legal, ossCredits, marketing, ...sharedMessages } = messages;
  const clientMessages = {
    ...sharedMessages,
    marketing: { contact: marketing.contact },
  };

  return (
    <NextIntlClientProvider messages={clientMessages}>
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
    </NextIntlClientProvider>
  );
}
