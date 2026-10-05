import { Button, Heading, Text } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { StructuredData } from '@web/components/seo/StructuredData';
import { DocArticle } from '@web/features/docs';
import { getAllContent } from '@web/lib/mdx';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import { ContentData } from '@web/types/content';
import { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

// catch-all route。ほとんどの docs は 1 セグメント（/docs/plans）だが、
// FAQ だけ 2 セグメント（/docs/faq/pricing）になる。理由は lib/mdx.ts の
// NESTED_URL_CATEGORIES を参照。
interface PageParams {
  locale: string;
  slug: string[];
}

interface DocPageProps {
  params: Promise<PageParams>;
}

/** URL セグメントを ContentData.slug と同じ表現（`faq/pricing` 等）へ戻す */
function toContentSlug(segments: string[]): string {
  return segments.join('/');
}

// ISR: ドキュメント記事は1日ごとに再検証
export const revalidate = 86400;

// 公開 docs は content/docs 配下の mdx で全量がビルド時に確定する。dynamicParams を
// 許すと未知の slug が on-demand レンダリングされ、not-found を **HTTP 200** で返す
// （2026-07-27 に本番で /docs/nonexistent が 200 なのを確認。soft 404 として
// インデックスされうる）。false にして未知の slug は routing 層で 404 にする。
export const dynamicParams = false;

// Generate static parameters (SEO optimization)
export async function generateStaticParams(): Promise<PageParams[]> {
  try {
    const locales = ['en', 'ja'];
    const params: PageParams[] = [];

    for (const locale of locales) {
      const allContent = await getAllContent(locale);
      for (const content of allContent) {
        // getting-started の overview は /docs 自体に統一するため静的生成しない
        if (
          content.frontMatter.category === 'getting-started' &&
          content.slug === 'getting-started'
        ) {
          continue;
        }
        params.push({ locale, slug: content.slug.split('/') });
      }
    }

    return params;
  } catch (error) {
    // 静かに [] を返すと全 docs が動的レンダリングへ降格するため、原因を必ず出力する
    console.error('[Docs] generateStaticParams failed:', error);
    return [];
  }
}

// Generate metadata
export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  try {
    const { locale, slug: slugSegments } = await params;
    const slug = toContentSlug(slugSegments);
    const allContent = await getAllContent(locale);
    const matched = allContent.find((content) => content.slug === slug);

    if (!matched) {
      return {
        title: 'Page Not Found - Dayopt Documentation',
        description: 'The requested documentation page could not be found.',
      };
    }

    const { frontMatter } = matched;

    // hreflang は実際にその言語版が存在するロケールだけを宣言する（片方のみの docs で 404 を指さない）
    const alternateLocales: string[] = [];
    for (const loc of ['en', 'ja']) {
      const content = loc === locale ? allContent : await getAllContent(loc);
      if (content.some((c) => c.slug === slug)) alternateLocales.push(loc);
    }

    // canonical / hreflang を含む共通メタデータ生成（blog 記事と同じ経路）
    return generateSEOMetadata({
      title: `${frontMatter.title} - Dayopt Documentation`,
      description: frontMatter.description,
      url: `/${locale}/docs/${slug}`,
      locale,
      type: 'article',
      category: 'docs',
      publishedTime: frontMatter.publishedAt,
      modifiedTime: frontMatter.updatedAt || frontMatter.publishedAt,
      authors: frontMatter.author ? [frontMatter.author] : undefined,
      section: frontMatter.category,
      alternateLocales,
    });
  } catch {
    return {
      title: 'Documentation - Dayopt',
      description: 'Dayopt documentation and guides',
    };
  }
}

// Get adjacent pages
function getAdjacentPages(
  allContent: ContentData[],
  slug: string,
): {
  previousPage?: ContentData;
  nextPage?: ContentData;
} {
  const currentIndex = allContent.findIndex((content) => content.slug === slug);

  if (currentIndex === -1) {
    return {};
  }

  return {
    previousPage: currentIndex > 0 ? allContent[currentIndex - 1] : undefined,
    nextPage: currentIndex < allContent.length - 1 ? allContent[currentIndex + 1] : undefined,
  };
}

// Main page component
export default async function DocPage({ params }: DocPageProps) {
  const { locale, slug: slugSegments } = await params;
  const slug = toContentSlug(slugSegments);
  // 静的レンダリングを有効にする（これがないと動的レンダリングにフォールバックする）
  setRequestLocale(locale);
  const tDocs = await getTranslations('docs');

  let allContent: ContentData[];
  try {
    allContent = await getAllContent(locale);
  } catch {
    // Error page
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <Heading as="h1" size="3xl" className="mb-4">
            {tDocs('error.title')}
          </Heading>
          <Text variant="muted" className="mb-6">
            {tDocs('error.description')}
          </Text>
          <Button asChild>
            <Link href="/docs">{tDocs('error.backToDocs')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const matched = allContent.find((content) => content.slug === slug);

  if (!matched) {
    notFound();
  }

  // /docs/getting-started → /docs は next.config.mjs の redirects で処理する。
  // dynamicParams: false によりこの slug は routing 層で弾かれ、ここまで到達しない。

  const { previousPage, nextPage } = getAdjacentPages(allContent, slug);

  return (
    <>
      {/* 検索エンジン・AI クローラ向けの構造化データ（正本は platform/seo/structured-data.ts）。
          docs は操作手順の記事なので、汎用 Article ではなく TechArticle で出す。 */}
      <StructuredData
        type="techArticle"
        data={{
          title: matched.frontMatter.title,
          description: matched.frontMatter.description,
          publishedAt: matched.frontMatter.publishedAt,
          updatedAt: matched.frontMatter.updatedAt,
          url: `/${locale}/docs/${slug}`,
          proficiencyLevel: matched.frontMatter.ai?.difficulty,
          dependencies: matched.frontMatter.ai?.prerequisites,
        }}
      />
      <DocArticle
        category={matched.frontMatter.category}
        mdxContent={matched.content}
        previousPage={previousPage}
        nextPage={nextPage}
      />
    </>
  );
}
