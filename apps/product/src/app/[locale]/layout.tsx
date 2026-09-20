import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';

import { getAppUrl, getOgImageUrl } from '@/lib/app-url';
import type { Locale } from '@dayopt/i18n/routing';
import { routing } from '@dayopt/i18n/routing';

interface LocaleLayoutProps {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

// RTL言語判定
function getDirection(locale: string): 'ltr' | 'rtl' {
  const rtlLocales = ['ar', 'he', 'fa', 'ur'];
  return rtlLocales.includes(locale) ? 'rtl' : 'ltr';
}

// 型ガード: 有効なロケールかチェック
function isValidLocale(locale: string): locale is Locale {
  return routing.locales.includes(locale as Locale);
}

// 動的メタデータ生成
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const validLocale = isValidLocale(locale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: validLocale, namespace: 'app' });

  // 代替言語URLの生成
  const alternateLanguages: Record<string, string> = {};
  routing.locales.forEach((lang) => {
    const url = `${getAppUrl()}/${lang}`;
    alternateLanguages[lang as keyof typeof alternateLanguages] = url;
  });

  return {
    title: {
      template: `%s - ${t('name')}`,
      default: t('name'),
    },
    description: t('description'),
    keywords: [
      'Dayopt',
      'task management',
      'productivity',
      'calendar',
      'project management',
      ...(t.raw('keywords') as string[]),
    ],
    authors: [{ name: 'Dayopt Team' }],
    creator: 'Dayopt',
    publisher: 'Dayopt',
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
    openGraph: {
      type: 'website',
      locale: validLocale,
      alternateLocale: routing.locales.filter((l) => l !== validLocale),
      url: `${getAppUrl()}/${validLocale}`,
      siteName: t('name'),
      title: t('name'),
      description: t('description'),
      images: [
        {
          url: getOgImageUrl(),
          width: 1200,
          height: 630,
          alt: t('name'),
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      site: '@dayopt',
      creator: '@dayopt',
      title: t('name'),
      description: t('description'),
      images: [getOgImageUrl()],
    },
    alternates: {
      canonical: `${getAppUrl()}/${validLocale}`,
      languages: alternateLanguages,
    },
    other: {
      'google-site-verification': process.env.GOOGLE_SITE_VERIFICATION || '',
    },
  };
}

// JSON-LD構造化データ（SEO改善）
function generateJsonLd(locale: string, appName: string, appDescription: string) {
  const baseUrl = getAppUrl();

  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: appName,
    description: appDescription,
    url: `${baseUrl}/${locale}`,
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'Web',
    inLanguage: locale,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'JPY',
    },
    screenshot: {
      '@type': 'ImageObject',
      url: getOgImageUrl(),
      width: 1200,
      height: 630,
    },
    author: {
      '@type': 'Organization',
      name: 'Dayopt',
    },
  };
}

// 静的生成用の言語パラメータ
export async function generateStaticParams() {
  return routing.locales.map((locale) => ({
    locale,
  }));
}

// 言語特化レイアウト（HTMLタグなし - ルートレイアウトで定義済み）
export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // 不正な言語の場合、デフォルト言語にフォールバック
  const validLocale = isValidLocale(locale) ? locale : routing.defaultLocale;
  const direction = getDirection(validLocale);

  // サーバーサイドで翻訳を取得（JSON-LD用）
  const t = await getTranslations({ locale: validLocale, namespace: 'app' });

  // JSON-LD構造化データ
  const jsonLd = generateJsonLd(validLocale, t('name'), t('description'));

  return (
    <div data-locale={validLocale} data-direction={direction}>
      {/* SEO: JSON-LD構造化データ */}
      <script
        id="json-ld"
        nonce={nonce}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </div>
  );
}
