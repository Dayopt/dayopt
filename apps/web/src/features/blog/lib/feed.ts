import { getTranslations } from 'next-intl/server';

import { siteConfig } from '@web/platform/seo/metadata';

import { getAllBlogPostMetas } from './blog';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * ロケール別の RSS フィード XML を生成する。
 *
 * URL は localePrefix: 'as-needed' に合わせ、default locale だけ prefix なしにする。
 */
export async function generateBlogFeed(locale: string): Promise<string> {
  const posts = await getAllBlogPostMetas(locale);
  const t = await getTranslations({ locale, namespace: 'marketing.landing.hero' });
  const baseUrl = siteConfig.url;
  const localePath = locale === 'en' ? '' : `/${locale}`;
  const blogUrl = `${baseUrl}${localePath}/blog`;

  const items = posts
    .sort(
      (a, b) =>
        new Date(b.frontMatter.publishedAt).getTime() -
        new Date(a.frontMatter.publishedAt).getTime(),
    )
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.frontMatter.title)}</title>
      <link>${blogUrl}/${post.slug}</link>
      <guid isPermaLink="true">${blogUrl}/${post.slug}</guid>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${new Date(post.frontMatter.publishedAt).toUTCString()}</pubDate>
      <author>${escapeXml(post.frontMatter.author)}</author>
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteConfig.name)} Blog</title>
    <link>${blogUrl}</link>
    <description>${escapeXml(`${t('body1')} ${t('body2')}`)}</description>
    <language>${locale}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${blogUrl}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/** RSS レスポンスの共通ヘッダー */
export const FEED_RESPONSE_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=3600, s-maxage=3600',
} as const;
