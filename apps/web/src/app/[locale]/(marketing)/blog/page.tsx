import { routing } from '@dayopt/i18n/routing';
import design from '@web/components/content/ContentDesign.module.css';
import { FilteredBlogClient, getAllBlogPostMetas } from '@web/features/blog';
import { generateSEOMetadata } from '@web/platform/seo/metadata';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string }>;
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

// ISR: ブログ一覧は1時間ごとに再検証
export const revalidate = 3600;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'common' });

  return generateSEOMetadata({
    title: t('navigation.blog'),
    description: locale === 'ja' ? '最新の記事とチュートリアル' : 'Latest articles and tutorials',
    url: `/${locale}/blog`,
    locale: locale,
    keywords:
      locale === 'ja'
        ? ['ブログ', '記事', 'SaaS', '開発', '技術', 'Next.js', 'TypeScript']
        : ['blog', 'articles', 'SaaS', 'development', 'technology', 'Next.js', 'TypeScript'],
    type: 'website',
    category: 'journal',
  });
}

export default async function BlogPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const pageParam = Number((await searchParams).page);
  const currentPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const allPosts = await getAllBlogPostMetas(locale);

  return (
    <div className="bg-background min-h-screen">
      {/* Header と同じ横幅・左右余白に揃える（max-w-7xl px-6 lg:px-8）。上下の余白は docs と同じ py-8 */}
      <section className={design.page}>
        <div>
          <FilteredBlogClient initialPosts={allPosts} locale={locale} currentPage={currentPage} />
        </div>
      </section>
    </div>
  );
}
