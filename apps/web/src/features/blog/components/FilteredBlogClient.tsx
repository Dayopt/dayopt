'use client';

import { EditorialHeader } from '@web/components/content/EditorialHeader';
import styles from './BlogDesign.module.css';

import { cn } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { EmptyState } from '@web/components/ui/feedback/empty-state';
import { SearchInput } from '@web/components/ui/inputs/search-input';
import { ContentPagination } from '@web/components/ui/navigation/content-pagination';
import { Rss, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { BlogPostMeta } from '../lib/blog';
import { BLOG_CATEGORIES, type BlogCategory, blogCategoryHref } from '../lib/categories';
import { PostCard } from './PostCard';

const POSTS_PER_PAGE = 12;

interface FilteredBlogClientProps {
  initialPosts: BlogPostMeta[];
  locale: string;
  currentPage?: number;
  /** 現在のタブ（URL 由来）。/blog は 'all'、/blog/{category} はその category。 */
  activeCategory?: BlogCategory;
}

export function FilteredBlogClient({
  initialPosts,
  locale,
  activeCategory = 'all',
  currentPage: requestedPage = 1,
}: FilteredBlogClientProps) {
  const t = useTranslations('blog');
  const [searchQuery, setSearchQuery] = useState('');

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
  const currentPage = searchQuery ? 1 : Math.min(requestedPage, Math.max(1, totalPages));
  const startIndex = (currentPage - 1) * POSTS_PER_PAGE;
  const currentPosts = filteredPosts.slice(startIndex, startIndex + POSTS_PER_PAGE);

  return (
    <div>
      {/* 記事の入口 */}
      <EditorialHeader
        eyebrow={t('header.eyebrow')}
        title={t('header.title')}
        description={t('header.description')}
        artwork
      />

      {/* タブ（カテゴリ＝URL）+ RSS + 検索 */}
      <div className={styles.toolbar}>
        <nav className="flex flex-wrap items-center gap-0" aria-label={t('filters.title')}>
          {BLOG_CATEGORIES.map((category) => {
            const isActive = category === activeCategory;
            return (
              <Link
                key={category}
                href={blogCategoryHref(category)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  styles.category,
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
            className={styles.rss}
            aria-label={t('header.rss')}
          >
            <Rss className="size-5" />
          </a>
          <div className="min-w-0 flex-1 sm:w-72">
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
            <div className={styles.postGrid}>
              {currentPosts.map((post, index) => (
                <PostCard
                  key={post.slug}
                  post={post}
                  priority={currentPage === 1 && index < 3}
                  layout={
                    index === 0 && currentPage === 1 && !searchQuery ? 'featured' : 'vertical'
                  }
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
