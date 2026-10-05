'use client';

import { Badge, Button, Dialog, DialogContent, Input } from '@dayopt/components';
import { Highlight } from '@web/lib/highlight';
import type { SearchResponse } from '@web/types/api';
import { Clock, Edit, FileText, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { fetchSearchResults } from '../search-client';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export function SearchDialog({ open, onOpenChange, locale, returnFocusRef }: SearchDialogProps) {
  const t = useTranslations('search');
  const [query, setQuery] = useState('');
  const [previewResults, setPreviewResults] = useState<SearchResponse['results']>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // localStorage から最近の検索を読み込む
  useEffect(() => {
    try {
      const stored = localStorage.getItem('recent-searches');
      if (stored) {
        const searches: string[] = JSON.parse(stored);
        setRecentSearches(searches.slice(0, 5)); // 最大5件
      }
    } catch (error) {
      console.error('[SearchDialog] Failed to load recent searches:', error);
      setRecentSearches([]);
    }
  }, []);

  // 検索を履歴に追加
  const addToRecentSearches = (searchQuery: string) => {
    if (!searchQuery.trim()) return;

    try {
      // 重複を削除して最新を先頭に追加
      const updated = [searchQuery, ...recentSearches.filter((s) => s !== searchQuery)].slice(0, 5);
      localStorage.setItem('recent-searches', JSON.stringify(updated));
      setRecentSearches(updated);
    } catch (error) {
      console.error('[SearchDialog] Failed to save recent search:', error);
    }
  };

  // 検索プレビューを取得
  useEffect(() => {
    if (query.length <= 2) {
      setPreviewResults([]);
      return;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      fetchSearchResults({
        query,
        locale,
        operation: 'search_dialog_preview',
        signal: abortController.signal,
      })
        .then((results) => {
          setPreviewResults(results.slice(0, 3));
        })
        .catch((error) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          setPreviewResults([]);
        });
    }, 300); // 300ms debounce

    return () => {
      clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [query, locale]);

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    } else {
      setQuery('');
    }
  }, [open]);

  const handleSearch = (searchQuery: string) => {
    if (!searchQuery.trim()) return;

    // 検索履歴に追加
    addToRecentSearches(searchQuery);

    onOpenChange(false);
    router.push(`/${locale}/search?q=${encodeURIComponent(searchQuery)}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onOpenChange(false);
      return;
    }

    if (e.key === 'Enter' && query.trim()) {
      handleSearch(query);
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'docs':
        return <FileText className="text-info size-4" />;
      case 'blog':
        return <Edit className="text-success size-4" />;
      default:
        return <FileText className="text-muted-foreground size-4" />;
    }
  };

  const typeLabel = (type: string) => (type === 'docs' ? t('docs') : t('blog'));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
        className="bg-popover border-border shadow-card max-w-2xl gap-0 overflow-hidden p-0 [&>button]:hidden"
      >
        {/* 検索ヘッダー */}
        <div className="border-border flex items-center gap-4 border-b p-4">
          <Search className="text-muted-foreground size-5 flex-shrink-0" />
          <Input
            ref={inputRef}
            placeholder={t('placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-base shadow-none focus:outline-none focus-visible:ring-0"
          />
          <Button
            onClick={() => onOpenChange(false)}
            variant="ghost"
            icon
            aria-label={t('close')}
            className="size-5 flex-shrink-0"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {/* 検索内容 */}
        <div className="max-h-96 overflow-y-auto">
          {!query ? (
            <div className="space-y-6 p-4">
              {/* 最近の検索 */}
              {recentSearches.length > 0 && (
                <div>
                  <h3 className="text-muted-foreground mb-4 text-xs font-medium tracking-wide uppercase">
                    {t('recentSearches')}
                  </h3>
                  <div className="space-y-1">
                    {recentSearches.map((search, index) => (
                      <Button
                        key={index}
                        onClick={() => setQuery(search)}
                        variant="ghost"
                        className="flex h-auto w-full items-center justify-start gap-4 p-2"
                      >
                        <Clock className="text-muted-foreground size-4" />
                        <span className="text-sm">{search}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  {t('searchResultsFor')} &ldquo;
                  <span className="font-medium">{query}</span>&rdquo;
                </p>
                <Badge variant="outline" className="text-xs">
                  {t('pressEnterToSearch')}
                </Badge>
              </div>

              {/* 全文検索 */}
              <Button
                onClick={() => handleSearch(query)}
                variant="ghost"
                className="bg-state-active border-primary hover:bg-state-hover flex h-auto w-full items-center justify-start gap-4 border p-4"
              >
                {/* state-active の上の accent は text-state-active-foreground。
                    text-primary は dark で背景と 1.5:1 まで落ちて消える（Colors.mdx） */}
                <Search className="text-state-active-foreground size-4" />
                <div className="text-left">
                  <div className="text-foreground text-sm font-medium">
                    {t('searchFor')} &ldquo;
                    <Highlight text={query} query={query} />
                    &rdquo;
                  </div>
                  <div className="text-muted-foreground text-xs">{t('findResultsAcross')}</div>
                </div>
              </Button>

              {/* プレビュー検索結果 */}
              {previewResults.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-2 text-xs">{t('previewResults')}</p>
                  <div className="space-y-2">
                    {previewResults.map((result, index) => (
                      <Button
                        key={index}
                        onClick={() => {
                          onOpenChange(false);
                          router.push(result.url);
                        }}
                        variant="ghost"
                        className="border-border flex h-auto w-full items-start justify-start gap-4 border p-4"
                      >
                        <div className="mt-1">{getTypeIcon(result.type)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center gap-2">
                            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                              {result.breadcrumbs?.[0] || typeLabel(result.type)}
                            </span>
                            <span className="text-muted-foreground text-xs">•</span>
                            <span className="text-muted-foreground text-xs">
                              {result.breadcrumbs?.[1] || result.category || 'General'}
                            </span>
                          </div>
                          <div className="text-foreground truncate text-sm font-medium">
                            <Highlight text={result.title} query={query} />
                          </div>
                          <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                            <Highlight text={result.description} query={query} />
                          </div>
                        </div>
                        <Badge variant="outline" className="self-start px-2 py-1 text-xs">
                          {typeLabel(result.type)}
                        </Badge>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="bg-container text-muted-foreground border-border border-t p-4 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1">
                <kbd className="bg-muted border-border text-foreground rounded-lg border px-2 py-1 font-mono text-xs">
                  Enter
                </kbd>
                <span>{t('toSelect')}</span>
              </div>
              <div className="flex items-center gap-1">
                <kbd className="bg-muted border-border text-foreground rounded-lg border px-2 py-1 font-mono text-xs">
                  Esc
                </kbd>
                <span>{t('toClose')}</span>
              </div>
            </div>
            <span className="text-muted-foreground">{t('poweredBy')}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
