'use client';

import { cn } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { EmptyState } from '@web/components/ui/feedback/empty-state';
import { SearchInput } from '@web/components/ui/inputs/search-input';
import { ContentPagination } from '@web/components/ui/navigation/content-pagination';
import { Rss, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { BlogPostMeta } from '../lib/blog';
import { BLOG_CATEGORIES, type BlogCategory, blogCategoryHref } from '../lib/categories';
import { PostCard } from './PostCard';

const POSTS_PER_PAGE = 12;

interface FilteredBlogClientProps {
  initialPosts: BlogPostMeta[];
  locale: string;
  /** 現在のタブ（URL 由来）。/blog は 'all'、/blog/{category} はその category。 */
  activeCategory?: BlogCategory;
}

export function FilteredBlogClient({
  initialPosts,
  locale,
  activeCategory = 'all',
}: FilteredBlogClientProps) {
  const t = useTranslations('blog');
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');

  const requestedPage = Number(searchParams?.get('page')) || 1;

  // カテゴリ（タブ＝URL）+ 検索で絞り込み、日付降順
  const filteredPosts = useMemo(() => {
    let filtered = [...initialPosts];

    if (activeCategory !== 'all') {
      filtered = filtered.filter(
        (post) => post.frontMatter.category.toLowerCase() === activeCategory,
      );
    }

    if (searchQuery) {
      const term = searchQuery.toLowerCase();
      filtered = filtered.filter((post) => {
        const { title, description, category } = post.frontMatter;
        return (
          title.toLowerCase().includes(term) ||
          description?.toLowerCase().includes(term) ||
          category.toLowerCase().includes(term) ||
          post.excerpt.toLowerCase().includes(term)
        );
      });
    }

    filtered.sort(
      (a, b) =>
        new Date(b.frontMatter.publishedAt).getTime() -
        new Date(a.frontMatter.publishedAt).getTime(),
    );

    return filtered;
  }, [initialPosts, activeCategory, searchQuery]);

  const totalPages = Math.ceil(filteredPosts.length / POSTS_PER_PAGE);
  const currentPage = Math.min(Math.max(1, Math.floor(requestedPage)), Math.max(1, totalPages));
  const startIndex = (currentPage - 1) * POSTS_PER_PAGE;
  const currentPosts = filteredPosts.slice(startIndex, startIndex + POSTS_PER_PAGE);

  return (
    <div>
      {/* タイトルは header ナビの「ブログ」ハイライトで示すため非表示（a11y/SEO 用に sr-only で残す） */}
      <h1 className="sr-only">{t('header.title')}</h1>

      {/* タブ（カテゴリ＝URL）+ RSS + 検索 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex flex-wrap items-center gap-0" aria-label={t('header.title')}>
          {BLOG_CATEGORIES.map((category) => {
            const isActive = category === activeCategory;
            return (
              <Link
                key={category}
                href={blogCategoryHref(category)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative inline-flex items-center justify-center rounded-lg px-2 py-1 text-sm whitespace-nowrap transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors',
                  isActive
                    ? 'text-foreground after:bg-foreground font-medium'
                    : 'text-muted-foreground hover:bg-state-hover hover:text-foreground',
                )}
              >
                {t(`tabs.${category}`)}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          {/* RSS は検索の左に配置（位置は要検討の暫定） */}
          <a
            href={`${locale === 'ja' ? '/ja' : ''}/blog/feed.xml`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
            aria-label="RSS Feed"
          >
            <Rss className="size-5" />
          </a>
          <div className="sm:w-72">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t('filters.searchPlaceholder')}
              clearLabel={t('filters.clearSearch')}
            />
          </div>
        </div>
      </div>

      {/* カードグリッド */}
      <div className="mt-8">
        {currentPosts.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {currentPosts.map((post, index) => (
                <PostCard
                  key={post.slug}
                  post={post}
                  priority={currentPage === 1 && index < 3}
                  layout="vertical"
                  locale={locale}
                />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-12">
                <ContentPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  basePath={
                    activeCategory === 'all'
                      ? locale === 'ja'
                        ? '/ja/blog'
                        : '/blog'
                      : `${locale === 'ja' ? '/ja' : ''}${blogCategoryHref(activeCategory)}`
                  }
                />
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={Search}
            title={t('list.noArticles')}
            description={t('list.noArticlesHint')}
          />
        )}
      </div>
    </div>
  );
}
