'use client';

import { Badge, Button, Container, Heading, Input, Text } from '@dayopt/components';
import { useRouter } from '@dayopt/i18n/navigation';
import { Highlight } from '@web/lib/highlight';
import type { SearchResultItem } from '@web/types/api';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { fetchSearchResults } from '@web/features/search/search-client';

function SearchResults() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('search');
  const [interactive, setInteractive] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'docs' | 'blog'>('all');

  useEffect(() => setInteractive(true), []);

  useEffect(() => {
    const q = searchParams.get('q') || '';
    setQuery(q);

    if (q) {
      setIsLoading(true);
      // 実際の検索API呼び出し
      fetchSearchResults({ query: q, locale, operation: 'search_page' })
        .then((searchResults) => {
          setResults(searchResults);
          setIsLoading(false);
        })
        .catch((_error) => {
          setResults([]);
          setIsLoading(false);
        });
    } else {
      setResults([]);
    }
  }, [searchParams, locale]);

  const handleSearch = (newQuery: string) => {
    const trimmedQuery = newQuery.trim();
    if (trimmedQuery) {
      router.push(`/search?q=${encodeURIComponent(trimmedQuery)}`);
    }
  };

  const filteredResults =
    selectedFilter === 'all' ? results : results.filter((result) => result.type === selectedFilter);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'docs':
        return (
          <svg className="text-info size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        );
      case 'blog':
        return (
          <svg
            className="text-success size-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
            />
          </svg>
        );
      default:
        return null;
    }
  };

  const getTypeBadgeVariant = (type: string): 'info' | 'success' | 'secondary' => {
    switch (type) {
      case 'docs':
        return 'info';
      case 'blog':
        return 'success';
      default:
        return 'secondary';
    }
  };

  return (
    <Container className="py-8">
      <div className="mx-auto max-w-4xl">
        {/* 検索ヘッダー */}
        <div className="mb-8">
          <Heading as="h1" size="3xl" className="mb-6">
            {t('page.title')}
          </Heading>

          {/* 検索ボックス */}
          <div className="mb-6 flex items-center gap-4">
            <div className="relative flex-1">
              <svg
                className="text-muted-foreground absolute top-1/2 left-3 size-5 -translate-y-1/2 transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <Input
                type="text"
                disabled={!interactive}
                placeholder={t('page.inputPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch(query)}
                className="py-4 pr-4 pl-12 text-base"
              />
            </div>
            <Button
              disabled={!interactive}
              onClick={() => handleSearch(query)}
              className="px-6 py-4"
            >
              {t('page.submit')}
            </Button>
          </div>

          {/* フィルター */}
          {query && (
            <div className="mb-6 flex items-center gap-4">
              <Text className="text-muted-foreground mr-2 text-sm">{t('page.filterLabel')}</Text>
              <div className="flex gap-2">
                {[
                  { key: 'all', label: t('page.all'), count: results.length },
                  {
                    key: 'docs',
                    label: t('docs'),
                    count: results.filter((r) => r.type === 'docs').length,
                  },
                  {
                    key: 'blog',
                    label: t('blog'),
                    count: results.filter((r) => r.type === 'blog').length,
                  },
                ].map((filter) => (
                  <button
                    key={filter.key}
                    onClick={() => setSelectedFilter(filter.key as typeof selectedFilter)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      selectedFilter === filter.key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-state-hover hover:text-foreground'
                    }`}
                  >
                    {filter.label} ({filter.count})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 検索結果表示エリア */}
        {query ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <Text className="text-muted-foreground">
                {t('page.resultCount', { query, count: filteredResults.length })}
              </Text>
              {isLoading && (
                <div className="flex items-center gap-2">
                  <div className="border-primary size-4 animate-spin rounded-full border-b-2 motion-reduce:animate-none"></div>
                  <Text className="text-muted-foreground text-sm">{t('page.loading')}</Text>
                </div>
              )}
            </div>

            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="border-border-subtle bg-card rounded-lg border p-6 shadow-sm"
                  >
                    <div className="animate-shimmer mb-4 h-4 w-3/4 rounded-lg"></div>
                    <div className="animate-shimmer mb-2 h-3 w-full rounded-lg"></div>
                    <div className="animate-shimmer h-3 w-2/3 rounded-lg"></div>
                  </div>
                ))}
              </div>
            ) : filteredResults.length > 0 ? (
              <div className="space-y-4">
                {filteredResults.map((result) => (
                  <div
                    key={result.id}
                    className="border-border-subtle bg-card hover:shadow-card rounded-lg border p-6 shadow-sm transition-shadow"
                  >
                    <div className="mb-4 flex items-start gap-4">
                      {getTypeIcon(result.type)}
                      <div className="min-w-0 flex-1">
                        <Link
                          href={result.url}
                          className="text-primary hover:text-primary-hover block truncate text-lg font-medium hover:underline"
                        >
                          <Highlight text={result.title} query={query} />
                        </Link>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge
                            variant={getTypeBadgeVariant(result.type)}
                            className="px-2 py-1 text-xs"
                          >
                            {t(result.type === 'docs' ? 'docs' : 'blog')}
                          </Badge>
                          <span className="text-muted-foreground text-xs">
                            {result.breadcrumbs?.join(' › ')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <p className="text-muted-foreground mb-4 line-clamp-2 text-sm">
                      <Highlight text={result.description} query={query} />
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground text-xs">
                        {t('page.updated', { date: result.lastModified })}
                      </span>
                      <Link
                        href={result.url}
                        className="text-primary hover:text-primary-hover text-xs font-medium"
                      >
                        {t('page.details')}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-16 text-center">
                <svg
                  className="text-muted-foreground mx-auto mb-4 size-16"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <Heading as="h3" size="lg" className="mb-2">
                  {t('page.emptyTitle')}
                </Heading>
                <Text variant="muted" className="mb-4">
                  {t('page.emptyDescription')}
                </Text>
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    router.push('/search');
                  }}
                >
                  {t('page.clear')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="py-16 text-center">
            <svg
              className="text-muted-foreground mx-auto mb-4 size-16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <Heading as="h3" size="lg" className="mb-2">
              {t('page.startTitle')}
            </Heading>
            <Text variant="muted" className="mb-6">
              {t('page.startDescription')}
            </Text>
            <div className="flex justify-center gap-2">
              <Badge variant="outline" className="px-4 py-1 text-sm">
                {t('docs')}
              </Badge>
              <Badge variant="outline" className="px-4 py-1 text-sm">
                {t('blog')}
              </Badge>
            </div>
          </div>
        )}
      </div>
    </Container>
  );
}

export default function SearchPage() {
  return (
    <div className="bg-background min-h-screen">
      <Suspense
        fallback={
          <Container className="py-8">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-center justify-center py-12">
                <div className="border-primary size-8 animate-spin rounded-full border-b-2 motion-reduce:animate-none"></div>
              </div>
            </div>
          </Container>
        }
      >
        <SearchResults />
      </Suspense>
    </div>
  );
}
