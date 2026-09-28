import { Link } from '@dayopt/i18n/navigation';
import { routing } from '@dayopt/i18n/routing';
import { createMDXComponents } from '@web/components/content/ContentMDXComponents';
import {
  BLOG_CATEGORY_KEYS,
  FilteredBlogClient,
  getAllBlogPostMetas,
  getBlogPost,
  getRelatedPosts,
  isBlogCategoryKey,
  RelatedPosts,
  ShareButton,
} from '@web/features/blog';
import { TableOfContentsCards } from '@web/features/docs';
import {
  generateSEOMetadata,
  generateStructuredData,
  siteConfig,
} from '@web/platform/seo/metadata';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { MDXRemote } from 'next-mdx-remote/rsc';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

interface BlogPostPageProps {
  params: Promise<{ locale: string; slug: string }>;
}

// Blog-specific: Callout component
function Callout({
  type = 'info',
  children,
}: {
  type?: 'info' | 'warning' | 'error' | 'success';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'bg-muted border-info text-info',
    warning: 'bg-muted border-warning text-warning',
    error: 'bg-muted border-destructive text-destructive',
    success: 'bg-muted border-success text-success',
  };

  const icons = {
    info: '\u{1F4A1}',
    warning: '\u26A0\uFE0F',
    error: '\u274C',
    success: '\u2705',
  };

  return (
    <div className={`my-6 rounded-r-lg border-l-4 p-4 ${styles[type]}`}>
      <div className="flex items-start">
        <span className="mr-4 flex-shrink-0 text-lg">{icons[type]}</span>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

const mdxComponents = createMDXComponents({ Callout });

// Generate metadata
export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { locale, slug } = await params;

  // カテゴリ一覧ページ（/blog/{category}）のメタデータ
  if (isBlogCategoryKey(slug)) {
    const tBlog = await getTranslations({ locale, namespace: 'blog' });
    const tCommon = await getTranslations({ locale, namespace: 'common' });
    return generateSEOMetadata({
      title: `${tBlog(`tabs.${slug}`)} | ${tCommon('navigation.blog')}`,
      url: `/${locale}/blog/${slug}`,
      locale,
      type: 'website',
      category: slug.toLowerCase() === 'release' ? 'release' : 'journal',
    });
  }

  const post = await getBlogPost(slug, locale);

  if (!post) {
    return generateSEOMetadata({
      title: locale === 'ja' ? '記事が見つかりません' : 'Article Not Found',
      description:
        locale === 'ja'
          ? 'お探しの記事は見つかりませんでした。'
          : 'The article you are looking for could not be found.',
      url: `/${locale}/blog/${slug}`,
      locale: locale,
      category: 'journal',
    });
  }

  const { frontMatter } = post;

  // hreflang は実際にその言語版が存在するロケールだけを宣言する（主言語のみの記事で 404 を指さない）
  const alternateLocales: string[] = [];
  for (const loc of ['en', 'ja']) {
    const exists = loc === locale ? true : (await getBlogPost(slug, loc)) !== null;
    if (exists) alternateLocales.push(loc);
  }

  return generateSEOMetadata({
    title: frontMatter.title,
    description: frontMatter.description,
    url: `/${locale}/blog/${slug}`,
    locale: locale,
    type: 'article',
    publishedTime: frontMatter.publishedAt,
    modifiedTime: frontMatter.updatedAt || frontMatter.publishedAt,
    authors: [frontMatter.author],
    category: frontMatter.category.toLowerCase() === 'release' ? 'release' : 'journal',
    section: frontMatter.category,
    alternateLocales,
  });
}

// ISR: ブログ記事は1時間ごとに再検証
export const revalidate = 3600;

// Generate static paths
export async function generateStaticParams() {
  const params = [];

  for (const locale of routing.locales) {
    // カテゴリ一覧ページ（/blog/{category}）
    for (const category of BLOG_CATEGORY_KEYS) {
      params.push({ locale, slug: category });
    }
    const posts = await getAllBlogPostMetas(locale);
    for (const post of posts) {
      params.push({ locale, slug: post.slug });
    }
  }

  return params;
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  // カテゴリ一覧ページ（/blog/{category}）— 一覧をそのカテゴリで表示
  // /blog（すべて）と同じ横幅・左右余白・上下余白に揃える（max-w-7xl px-6 lg:px-8 / py-8）
  if (isBlogCategoryKey(slug)) {
    const allPosts = await getAllBlogPostMetas(locale);
    return (
      <div className="bg-background min-h-screen">
        <section className="py-8">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <FilteredBlogClient initialPosts={allPosts} locale={locale} activeCategory={slug} />
          </div>
        </section>
      </div>
    );
  }

  const t = await getTranslations('blog');
  const tCommon = await getTranslations('common');

  const post = await getBlogPost(slug, locale);

  if (!post) {
    notFound();
  }

  // カテゴリのラベル（既知の taxonomy なら i18n ラベル、それ以外は素の値）+ リンク先
  const categoryKey = post.frontMatter.category.toLowerCase();
  const categoryIsKnown = isBlogCategoryKey(categoryKey);
  const categoryLabel = categoryIsKnown ? t(`tabs.${categoryKey}`) : post.frontMatter.category;

  // Remove duplicate h1 title from MDX content (already shown in page header)
  let processedContent = post.content;

  const titlePattern = new RegExp(
    `^# ${post.frontMatter.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\n`,
    'gm',
  );
  processedContent = processedContent.replace(titlePattern, '');

  // Remove leading empty lines
  processedContent = processedContent.replace(/^\n+/, '');

  const relatedPosts = await getRelatedPosts(slug, 3, locale);

  // cover 画像が無ければ生成 OGP 画像を hero として表示する
  const heroImage =
    post.frontMatter.coverImage ||
    `/api/og?${new URLSearchParams({
      title: post.frontMatter.title,
      type: 'blog',
      date: post.frontMatter.publishedAt,
    }).toString()}`;

  // JSON-LD は platform/seo/structured-data.ts を正本にする（記事系で定義を重複させない）
  const jsonLd = {
    ...generateStructuredData('article', {
      articleType: 'BlogPosting',
      title: post.frontMatter.title,
      description: post.frontMatter.description,
      author: post.frontMatter.author,
      publishedAt: post.frontMatter.publishedAt,
      updatedAt: post.frontMatter.updatedAt,
      image: post.frontMatter.coverImage,
      url: `/${locale}/blog/${slug}`,
      category: post.frontMatter.category,
      tags: post.frontMatter.tags,
    }),
    wordCount: post.readingTime * 200,
    timeRequired: `PT${post.readingTime}M`,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="bg-background min-h-screen">
        <article className="py-8">
          {/* Header と同じ左右の余白に揃える（max-w-7xl px-6 lg:px-8） */}
          <div className="mx-auto flex max-w-7xl gap-8 px-6 lg:px-8">
            <div className="min-w-0 flex-1">
              {/* パンくず（HOME は出さず ブログ / カテゴリ） */}
              <nav
                aria-label="breadcrumb"
                className="mb-8 flex min-w-0 items-center space-x-2 text-sm"
              >
                <Link
                  href="/blog"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {tCommon('navigation.blog')}
                </Link>
                <span className="text-border">/</span>
                {categoryIsKnown ? (
                  <Link
                    href={`/blog/${categoryKey}`}
                    className="text-foreground font-medium transition-colors hover:underline"
                  >
                    {categoryLabel}
                  </Link>
                ) : (
                  <span className="text-foreground font-medium">{categoryLabel}</span>
                )}
              </nav>

              {/* 写真 → タイトル → メタ情報 の順 */}
              <div className="border-border relative mb-6 aspect-[16/9] overflow-hidden rounded-2xl border">
                <Image
                  src={heroImage}
                  alt={post.frontMatter.title}
                  fill
                  className="object-cover"
                  priority
                  unoptimized={!post.frontMatter.coverImage}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
                />
              </div>

              <h1 className="text-foreground mb-3 text-4xl font-medium break-words">
                {post.frontMatter.title}
              </h1>

              {/* メタ情報: 日付 + カテゴリラベル */}
              <div className="mb-8 flex flex-wrap items-center gap-3 text-sm">
                <time className="text-muted-foreground" dateTime={post.frontMatter.publishedAt}>
                  {new Date(post.frontMatter.publishedAt).toLocaleDateString(locale, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </time>
                <span className="bg-muted text-muted-foreground inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium">
                  {categoryLabel}
                </span>
              </div>

              <div>
                <MDXRemote
                  source={processedContent}
                  components={mdxComponents}
                  options={{
                    mdxOptions: {
                      remarkPlugins: [remarkGfm],
                      rehypePlugins: [rehypeHighlight],
                    },
                  }}
                />
              </div>

              <div className="border-border mt-8 border-t pt-6"></div>

              <div className="mt-6 space-y-6">
                <div>
                  <h3 className="text-foreground mb-4 text-lg font-medium">{t('share.title')}</h3>
                  <ShareButton
                    title={post.frontMatter.title}
                    url={`${siteConfig.url}/${locale}/blog/${slug}`}
                  />
                </div>
              </div>
            </div>

            <aside className="hidden w-72 flex-shrink-0 xl:block">
              <div className="sticky top-14">
                <TableOfContentsCards content={post.content} />
              </div>
            </aside>
          </div>
        </article>

        <RelatedPosts posts={relatedPosts} currentSlug={slug} locale={locale} />
      </div>
    </>
  );
}
