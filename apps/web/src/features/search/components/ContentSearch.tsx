'use client';

import { Button, Input, Skeleton } from '@dayopt/components';
import { Link, useRouter } from '@dayopt/i18n/navigation';
import design from '@web/components/content/ContentDesign.module.css';
import { EditorialHeader } from '@web/components/content/EditorialHeader';
import { fetchSearchResults } from '@web/features/search/search-client';
import { Highlight } from '@web/lib/highlight';
import type { SearchResultItem } from '@web/types/api';
import { ArrowUpRight, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

export function ContentSearch({ submittedQuery }: { submittedQuery: string }) {
  const t = useTranslations('search.page');
  const router = useRouter();
  const locale = useLocale();
  const [query, setQuery] = useState(submittedQuery);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [filter, setFilter] = useState<'all' | 'docs' | 'blog'>('all');

  useEffect(() => {
    setQuery(submittedQuery);
    setResults([]);
    if (!submittedQuery) {
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    fetchSearchResults({
      query: submittedQuery,
      locale,
      operation: 'search_page',
      signal: controller.signal,
    })
      .then((items) => {
        if (!controller.signal.aborted) {
          setResults(items);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [submittedQuery, locale]);

  const visibleResults =
    filter === 'all' ? results : results.filter((result) => result.type === filter);
  return (
    <section className={design.page}>
      <EditorialHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        artwork
      />
      <div className="max-w-4xl">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = query.trim();
            router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search');
          }}
          role="search"
        >
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="content-search" className="mb-3 block text-sm">
              {t('input')}
            </label>
            <div className="relative">
              <Search
                className="text-muted-foreground absolute top-1/2 left-4 size-5 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                id="content-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('placeholder')}
                className="h-12 pl-12"
              />
            </div>
          </div>
          <Button type="submit" className="h-12 px-8">
            {t('submit')}
          </Button>
        </form>
        {submittedQuery && (
          <div
            role="group"
            aria-label={t('filters')}
            className="border-border mt-8 flex flex-wrap gap-2 border-b pb-6"
          >
            {(['all', 'docs', 'blog'] as const).map((type) => (
              <Button
                key={type}
                variant={filter === type ? 'primary' : 'ghost'}
                aria-pressed={filter === type}
                onClick={() => setFilter(type)}
              >
                {t(type)}{' '}
                <span className="ml-2 text-xs">
                  {type === 'all'
                    ? results.length
                    : results.filter((result) => result.type === type).length}
                </span>
              </Button>
            ))}
          </div>
        )}
        <div aria-live="polite" aria-busy={status === 'loading'}>
          {status === 'loading' ? (
            <div className="space-y-6 py-8">
              <p className="text-muted-foreground text-sm">{t('loading')}</p>
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-24 w-full" />
              ))}
            </div>
          ) : status === 'ready' && visibleResults.length > 0 ? (
            <>
              <p className="text-muted-foreground my-8 text-sm">
                {t('count', { query: submittedQuery, count: visibleResults.length })}
              </p>
              <div className="divide-border divide-y">
                {visibleResults.map((result) => (
                  <article key={result.id} className="py-8">
                    <div className="text-muted-foreground mb-4 flex flex-wrap gap-4 text-xs">
                      <span>{t(result.type)}</span>
                      <span>{result.breadcrumbs?.join(' / ')}</span>
                    </div>
                    <Link
                      href={result.url}
                      className="group flex items-start justify-between gap-6"
                    >
                      <h2 className="text-2xl leading-relaxed font-normal break-words">
                        <Highlight text={result.title} query={submittedQuery} />
                      </h2>
                      <ArrowUpRight className="mt-2 size-5 shrink-0" aria-hidden="true" />
                    </Link>
                    <p className="text-muted-foreground mt-4 text-sm leading-7">
                      <Highlight text={result.description} query={submittedQuery} />
                    </p>
                    <p className="text-muted-foreground mt-6 text-xs">
                      {t('updated', { date: result.lastModified })}
                    </p>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="py-16">
              <h2 className="mb-4 text-2xl font-normal">
                {t(
                  status === 'error' ? 'errorTitle' : submittedQuery ? 'emptyTitle' : 'startTitle',
                )}
              </h2>
              <p className="text-muted-foreground max-w-lg text-sm leading-7">
                {t(
                  status === 'error'
                    ? 'errorDescription'
                    : submittedQuery
                      ? 'emptyDescription'
                      : 'startDescription',
                )}
              </p>
              <div className="mt-8 flex flex-wrap gap-4">
                <Button variant="outline" asChild>
                  <Link href="/docs">{t('docs')}</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href="/blog">{t('blog')}</Link>
                </Button>
                {submittedQuery && (
                  <Button variant="ghost" onClick={() => router.push('/search')}>
                    {t('clear')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
