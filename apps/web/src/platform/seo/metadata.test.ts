import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/platform/config/env', () => ({
  env: {
    GOOGLE_SITE_VERIFICATION: 'google-code',
    YANDEX_VERIFICATION: 'yandex-code',
    YAHOO_VERIFICATION: 'yahoo-code',
  },
  getSiteUrl: () => 'https://dayopt.com',
}));

import {
  generateArticleMetadata,
  generateBreadcrumbs,
  generateSEOMetadata,
  generateStructuredData,
  siteConfig,
} from './metadata';

describe('generateSEOMetadata', () => {
  it('代表的な default 出力を完全一致で維持する', () => {
    const defaultImage = `https://dayopt.com/api/og?${new URLSearchParams({
      title: siteConfig.title,
      description: siteConfig.description,
    }).toString()}`;

    expect(generateSEOMetadata()).toEqual({
      metadataBase: new URL('https://dayopt.com'),
      title: siteConfig.title,
      description: siteConfig.description,
      keywords: 'タイムボクシング, 時間管理, 計画, 実績, 振り返り, カレンダー',
      authors: [{ name: 'Dayopt Team' }],
      creator: 'Dayopt Team',
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
      alternates: {
        canonical: 'https://dayopt.com/ja',
        languages: {
          'en-US': 'https://dayopt.com',
          'ja-JP': 'https://dayopt.com/ja',
          'x-default': 'https://dayopt.com',
        },
      },
      openGraph: {
        type: 'website',
        locale: 'ja_JP',
        url: 'https://dayopt.com/ja',
        title: siteConfig.title,
        description: siteConfig.description,
        siteName: 'Dayopt',
        images: [
          {
            url: defaultImage,
            width: 1200,
            height: 630,
            alt: siteConfig.title,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: siteConfig.title,
        description: siteConfig.description,
        images: [defaultImage],
        creator: '@dayoptapp',
        site: '@dayoptapp',
      },
      verification: {
        google: 'google-code',
        yandex: 'yandex-code',
        yahoo: 'yahoo-code',
      },
    });
  });

  it('default locale の ja canonical と verification を生成する', () => {
    expect(generateSEOMetadata({ title: 'About', url: '/about' })).toMatchObject({
      title: 'About | Dayopt',
      alternates: {
        canonical: 'https://dayopt.com/ja/about',
        languages: {
          'en-US': 'https://dayopt.com/about',
          'ja-JP': 'https://dayopt.com/ja/about',
          'x-default': 'https://dayopt.com/about',
        },
      },
      openGraph: { locale: 'ja_JP', url: 'https://dayopt.com/ja/about' },
      verification: { google: 'google-code', yandex: 'yandex-code', yahoo: 'yahoo-code' },
    });
  });

  it('ページ見出しとソーシャルカードのタイトルを分けられる', () => {
    const metadata = generateSEOMetadata({
      title: 'One day at a time',
      ogTitle: 'Dayopt',
      description: 'A description',
    });
    const imageUrl = (metadata.openGraph?.images as Array<{ url: string }>)[0]?.url;

    expect(metadata.title).toBe('One day at a time | Dayopt');
    expect(metadata.openGraph?.title).toBe('Dayopt');
    expect(metadata.twitter?.title).toBe('Dayopt');
    expect(new URL(imageUrl).searchParams.get('title')).toBe('Dayopt');
  });

  it('en は prefixless canonical にし、入力済み locale prefix と末尾 slash を除く', () => {
    expect(generateSEOMetadata({ locale: 'en', url: '/ja/about/' })).toMatchObject({
      alternates: { canonical: 'https://dayopt.com/about' },
      openGraph: { locale: 'en_US', url: 'https://dayopt.com/about' },
    });
  });

  it('keywords と tags は重複を保持し、custom image は site URL を付ける', () => {
    expect(
      generateSEOMetadata({
        keywords: ['計画'],
        tags: ['計画'],
        image: '/custom.png',
      }),
    ).toMatchObject({
      keywords: 'タイムボクシング, 時間管理, 計画, 実績, 振り返り, カレンダー, 計画, 計画',
      openGraph: { images: [{ url: 'https://dayopt.com/custom.png' }] },
      twitter: { images: ['https://dayopt.com/custom.png'] },
    });
  });

  it('article metadata に日時、authors、section、tags を引き渡す', () => {
    expect(
      generateArticleMetadata({
        title: 'Article',
        description: 'Description',
        slug: 'article',
        publishedAt: '2026-01-01',
        updatedAt: '2026-01-02',
        authors: ['Author'],
        tags: ['tag'],
        category: 'Guide',
        type: 'blog',
      }),
    ).toMatchObject({
      alternates: { canonical: 'https://dayopt.com/ja/blog/article' },
      openGraph: {
        type: 'article',
        publishedTime: '2026-01-01',
        modifiedTime: '2026-01-02',
        authors: ['Author'],
        section: 'Guide',
        tags: ['tag'],
      },
    });
  });
});

describe('generateStructuredData', () => {
  it('organization と website の完全な contract を維持する', () => {
    expect(generateStructuredData('organization', {})).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Dayopt',
      url: 'https://dayopt.com',
      logo: 'https://dayopt.com/logo.png',
      description: siteConfig.description,
      sameAs: ['https://x.com/dayoptapp', 'https://github.com/dayoptapp'],
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'Customer Service',
        email: 'support@dayopt.app',
      },
    });
    expect(generateStructuredData('website', {})).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Dayopt',
      description: siteConfig.description,
      url: 'https://dayopt.com',
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: 'https://dayopt.com/search?q={search_term_string}',
        },
        'query-input': 'required name=search_term_string',
      },
    });
  });

  it('article の完全な contract を維持する', () => {
    expect(
      generateStructuredData('article', {
        title: 'Article',
        description: 'Description',
        image: '/article.png',
        publishedAt: '2026-01-01',
        updatedAt: '2026-01-02',
        author: 'Author',
        url: '/article',
        tags: ['one', 'two'],
        category: 'Guide',
        articleType: 'NewsArticle',
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Article',
      description: 'Description',
      image: 'https://dayopt.com/article.png',
      datePublished: '2026-01-01',
      dateModified: '2026-01-02',
      author: { '@type': 'Person', name: 'Author' },
      publisher: {
        '@type': 'Organization',
        name: 'Dayopt',
        logo: { '@type': 'ImageObject', url: 'https://dayopt.com/logo.png' },
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://dayopt.com/article' },
      keywords: 'one, two',
      articleSection: 'Guide',
    });
  });

  it('techArticle は前提知識が無い記事で dependencies を出さない', () => {
    const result = generateStructuredData('techArticle', {
      title: 'Guide',
      description: 'Description',
      publishedAt: '2026-01-01',
      url: '/guide',
    });

    expect(result).not.toHaveProperty('dependencies');
    // applicationCategory は SoftwareApplication の property なので TechArticle には出さない
    expect(result).not.toHaveProperty('applicationCategory');
    expect(result).toMatchObject({ proficiencyLevel: 'Beginner' });
  });

  it('techArticle の proficiencyLevel を frontmatter の難易度で上書きできる', () => {
    expect(
      generateStructuredData('techArticle', {
        title: 'Guide',
        description: 'Description',
        publishedAt: '2026-01-01',
        url: '/guide',
        proficiencyLevel: 'advanced',
      }),
    ).toMatchObject({ proficiencyLevel: 'advanced' });
  });

  it('techArticle、SoftwareApplication、breadcrumb の discriminator を維持する', () => {
    expect(
      generateStructuredData('techArticle', {
        title: 'Guide',
        description: 'Description',
        publishedAt: '2026-01-01',
        url: '/guide',
        dependencies: ['Node.js'],
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: 'Guide',
      description: 'Description',
      image: 'https://dayopt.com/api/og?title=Guide',
      datePublished: '2026-01-01',
      dateModified: '2026-01-01',
      author: { '@type': 'Organization', name: 'Dayopt' },
      publisher: {
        '@type': 'Organization',
        name: 'Dayopt',
        logo: { '@type': 'ImageObject', url: 'https://dayopt.com/logo.png' },
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://dayopt.com/guide' },
      proficiencyLevel: 'Beginner',
      dependencies: ['Node.js'],
    });
    expect(
      generateStructuredData('SoftwareApplication', {
        name: 'App',
        description: 'Description',
        applicationCategory: 'ProductivityApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: 0 },
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'App',
      description: 'Description',
      url: 'https://dayopt.com',
      applicationCategory: 'ProductivityApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: 0 },
      author: { '@type': 'Organization', name: 'Dayopt' },
    });
    expect(
      generateStructuredData('breadcrumb', { items: [{ name: 'Blog', url: '/blog' }] }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Blog',
          item: 'https://dayopt.com/blog',
        },
      ],
    });
  });

  it('未知の type は null を返す', () => {
    expect(generateStructuredData('unknown', {})).toBeNull();
  });

  it('breadcrumb の先頭に既存のホーム項目を追加する', () => {
    expect(generateBreadcrumbs([{ name: 'Blog', url: '/blog' }])).toEqual([
      { name: 'ホーム', url: '/' },
      { name: 'Blog', url: '/blog' },
    ]);
  });
});

describe('siteConfig', () => {
  it('既存の public site URL と locale 設定を維持する', () => {
    expect(siteConfig).toMatchObject({
      name: 'Dayopt',
      url: 'https://dayopt.com',
      locale: 'ja',
      alternateLocales: ['en', 'ja'],
    });
  });
});
