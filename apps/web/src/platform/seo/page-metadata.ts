import { env } from '@web/platform/config/env';
import type { Metadata } from 'next';

import { siteConfig } from './site-config';

export interface SEOData {
  title?: string;
  /** Social cards use the brand name when the page headline is editorial copy. */
  ogTitle?: string;
  description?: string;
  keywords?: string[];
  image?: string;
  url?: string;
  type?: 'website' | 'article';
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
  section?: string;
  tags?: string[];
  locale?: string;
  alternateLocales?: string[];
  noindex?: boolean;
  hreflang?: Record<string, string>;
}

function stripLocaleFromUrl(url: string): string {
  return url.replace(/^\/(en|ja)(\/|$)/, '/');
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/$/, '');
}

function formatLocaleForOpenGraph(locale: string): string {
  switch (locale) {
    case 'ja':
      return 'ja_JP';
    case 'en':
      return 'en_US';
    default:
      return locale.includes('_') ? locale : `${locale}_${locale.toUpperCase()}`;
  }
}

export function generateSEOMetadata(data: SEOData = {}): Metadata {
  const {
    title,
    ogTitle,
    description = siteConfig.description,
    keywords = [],
    image,
    url,
    type = 'website',
    publishedTime,
    modifiedTime,
    authors,
    section,
    tags = [],
    locale = siteConfig.locale,
    alternateLocales,
    noindex = false,
  } = data;

  const pageTitle = title ? `${title} | ${siteConfig.name}` : siteConfig.title;
  const socialTitle = ogTitle || pageTitle;
  const normalizedPath = normalizePath(stripLocaleFromUrl(url || ''));
  const canonicalUrl =
    locale === 'en'
      ? `${siteConfig.url}${normalizedPath}`
      : `${siteConfig.url}/${locale}${normalizedPath}`;

  const ogSearchParams = new URLSearchParams({
    title: ogTitle || title || siteConfig.title,
    description,
  });
  const pageImage = image
    ? `${siteConfig.url}${image}`
    : `${siteConfig.url}/api/og?${ogSearchParams.toString()}`;

  const allKeywords = [...siteConfig.keywords, ...keywords, ...tags].filter(Boolean);

  // hreflang は実在するロケール版だけを宣言する。片方のロケールにしかないコンテンツで
  // 存在しない URL を alternate として広告すると 404 を指すため（alternateLocales 未指定時は全ロケール）
  const hreflangLocales = alternateLocales ?? ['en', 'ja'];
  const localeUrl = (loc: string) =>
    loc === 'en'
      ? `${siteConfig.url}${normalizedPath}`
      : `${siteConfig.url}/${loc}${normalizedPath}`;
  const languages: Record<string, string> = {};
  if (hreflangLocales.includes('en')) languages['en-US'] = localeUrl('en');
  if (hreflangLocales.includes('ja')) languages['ja-JP'] = localeUrl('ja');
  // x-default は en 版があれば en、なければ存在する唯一の版を指す
  languages['x-default'] = hreflangLocales.includes('en') ? localeUrl('en') : canonicalUrl;

  return {
    metadataBase: new URL(siteConfig.url),
    title: pageTitle,
    description,
    keywords: allKeywords.join(', '),
    authors: authors?.map((name) => ({ name })) || [{ name: siteConfig.creator }],
    creator: siteConfig.creator,
    publisher: siteConfig.name,
    robots: {
      index: !noindex,
      follow: !noindex,
      googleBot: {
        index: !noindex,
        follow: !noindex,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
    alternates: {
      canonical: canonicalUrl,
      languages,
    },
    openGraph: {
      type: type as 'website' | 'article',
      locale: formatLocaleForOpenGraph(locale),
      url: canonicalUrl,
      title: socialTitle,
      description,
      siteName: siteConfig.name,
      images: [
        {
          url: pageImage,
          width: 1200,
          height: 630,
          alt: ogTitle || title || siteConfig.title,
        },
      ],
      ...(type === 'article' && {
        publishedTime,
        modifiedTime,
        authors: authors || [siteConfig.creator],
        section,
        tags,
      }),
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: [pageImage],
      creator: siteConfig.twitterHandle,
      site: siteConfig.twitterHandle,
    },
    verification: {
      google: env.GOOGLE_SITE_VERIFICATION,
      yandex: env.YANDEX_VERIFICATION,
      yahoo: env.YAHOO_VERIFICATION,
    },
  };
}

export function generateArticleMetadata(data: {
  title: string;
  description: string;
  slug: string;
  publishedAt: string;
  updatedAt?: string;
  authors?: string[];
  tags?: string[];
  category?: string;
  type: 'blog' | 'docs';
}): Metadata {
  const { type, slug, publishedAt, updatedAt, authors, tags, category } = data;

  return generateSEOMetadata({
    ...data,
    url: `/${type}/${slug}`,
    type: 'article',
    publishedTime: publishedAt,
    modifiedTime: updatedAt || publishedAt,
    authors,
    section: category || type,
    tags,
    keywords: tags,
  });
}
