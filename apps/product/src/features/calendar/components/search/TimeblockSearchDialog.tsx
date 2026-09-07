'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LoaderCircle, SearchX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import {
  ActivityIcon,
  useActivities,
  useActivitiesMap,
  useArchivedActivities,
} from '@/features/activities';
import { useDebouncedCallback } from '@/lib/hooks/useDebounce';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { api } from '@/lib/trpc';
import {
  Button,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@dayopt/components';

import {
  mergeTimeblockSearchResults,
  type TimeblockSearchResult,
} from '../../lib/timeblock-search-results';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_FETCH_LIMIT = 21;
const SEARCH_DISPLAY_LIMIT = 20;

interface TimeblockSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenResult: (result: TimeblockSearchResult) => void;
  responsive?: React.ComponentProps<typeof CommandDialog>['responsive'];
}

interface SearchActivity {
  id: string;
  name: string;
  /** 所属カテゴリーから継承した色。未分類なら null */
  color: string | null;
  /** 所属カテゴリーから継承したアイコン。未分類・未設定なら null */
  icon: string | null;
}

interface TimeblockSearchContentProps {
  query: string;
  results: readonly TimeblockSearchResult[];
  activitiesById: ReadonlyMap<string, SearchActivity>;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  locale: string;
  timezone: string;
  timeFormat: '24h' | '12h';
  onOpenResult: (result: TimeblockSearchResult) => void;
  onRetry: () => void;
}

function formatResultDateTime(
  result: TimeblockSearchResult,
  locale: string,
  timezone: string,
  timeFormat: '24h' | '12h',
): string {
  const start = new Date(result.startAt);
  const end = new Date(result.endAt);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: timeFormat === '12h',
  });
  const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const startLabel = `${dateFormatter.format(start)} ${timeFormatter.format(start)}`;
  const endLabel =
    dateKeyFormatter.format(start) === dateKeyFormatter.format(end)
      ? timeFormatter.format(end)
      : `${dateFormatter.format(end)} ${timeFormatter.format(end)}`;

  return `${startLabel}–${endLabel}`;
}

/** @public Storybook / unit testで各query状態を固定表示するpresentational boundary。 */
export function TimeblockSearchContent({
  query,
  results,
  activitiesById,
  isLoading,
  isError,
  hasMore,
  locale,
  timezone,
  timeFormat,
  onOpenResult,
  onRetry,
}: TimeblockSearchContentProps) {
  const t = useTranslations();
  const hasQuery = query.trim().length > 0;

  if (!hasQuery) {
    return (
      <div className="text-muted-foreground flex min-h-40 items-center justify-center px-6 text-center text-sm">
        {t('calendar.search.initial')}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center"
        role="alert"
      >
        <SearchX className="text-muted-foreground size-5" aria-hidden="true" />
        <p className="text-sm">{t('calendar.search.error')}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('calendar.search.retry')}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 px-6 text-sm"
        role="status"
      >
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t('calendar.search.loading')}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div
        className="text-muted-foreground flex min-h-40 items-center justify-center px-6 text-center text-sm"
        role="status"
      >
        {t('calendar.search.empty')}
      </div>
    );
  }

  return (
    <>
      <CommandGroup heading={t('calendar.search.results')}>
        {results.map((result, index) => {
          const activity = result.activityId ? activitiesById.get(result.activityId) : undefined;
          const displayName = activity?.name ?? t('calendar.filter.noActivity');
          const searchableValue = [query, result.kind, result.note, activity?.name, index]
            .filter((value) => value != null)
            .join(' ');

          return (
            <CommandItem
              key={`${result.kind}:${result.id}`}
              value={searchableValue}
              className="min-h-16 w-full gap-2 py-2"
              onSelect={() => onOpenResult(result)}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="border-border text-muted-foreground shrink-0 rounded-lg border px-2 py-1 text-xs">
                    {t(`calendar.search.kind.${result.kind}`)}
                  </span>
                </div>
                <p className="flex min-w-0 items-center gap-1 text-sm font-medium">
                  <ActivityIcon
                    icon={activity?.icon ?? null}
                    color={activity?.color ?? null}
                    size="sm"
                    neutral={!activity}
                  />
                  <span className="truncate">{displayName}</span>
                </p>
                {result.note ? (
                  <p className="text-muted-foreground line-clamp-1 text-xs">{result.note}</p>
                ) : null}
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatResultDateTime(result, locale, timezone, timeFormat)}
                </p>
              </div>
            </CommandItem>
          );
        })}
      </CommandGroup>
      {hasMore ? (
        <p className="border-border text-muted-foreground border-t px-4 py-2 text-xs" role="note">
          {t('calendar.search.overflow', { count: SEARCH_DISPLAY_LIMIT })}
        </p>
      ) : null}
    </>
  );
}

/** 全期間のPlan / Recordを検索するCalendar-owned dialog。 */
export function TimeblockSearchDialog({
  open,
  onOpenChange,
  onOpenResult,
  responsive = 'auto',
}: TimeblockSearchDialogProps) {
  const t = useTranslations();
  const locale = useLocale();
  const timezone = useUserPreferences((preferences) => preferences.timezone);
  const timeFormat = useUserPreferences((preferences) => preferences.timeFormat);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [setQueryAfterDelay, cancelDebounce] = useDebouncedCallback(
    setDebouncedQuery,
    SEARCH_DEBOUNCE_MS,
  );
  const wasOpenRef = useRef(open);
  const hasDebouncedQuery = debouncedQuery.length > 0;

  const searchInput = useMemo(
    () => ({
      search: debouncedQuery,
      sortBy: 'start_at' as const,
      sortOrder: 'desc' as const,
      limit: SEARCH_FETCH_LIMIT,
    }),
    [debouncedQuery],
  );

  const plansQuery = api.plans.list.useQuery(searchInput, {
    enabled: hasDebouncedQuery,
    // 閉じる・検索語変更でquery key（検索語）をmemory cacheにも残さない。
    gcTime: 0,
    meta: { persist: false },
  });
  const recordsQuery = api.records.list.useQuery(searchInput, {
    enabled: hasDebouncedQuery,
    gcTime: 0,
    meta: { persist: false },
  });
  const activitiesQuery = useActivities();
  // 検索結果にアーカイブ済みアクティビティのブロックも表示されるため、archived も解決する
  // （#1576: 含めないと検索結果の名前がすべて「アクティビティなし」に落ちる）。
  // 名前・継承色の解決自体は useActivitiesMap（現役 + アーカイブ済みを含む）に委ねる。
  const archivedActivitiesQuery = useArchivedActivities();
  const { activitiesMap: activitiesById } = useActivitiesMap();
  const merged = useMemo(
    () =>
      mergeTimeblockSearchResults(
        plansQuery.data ?? [],
        recordsQuery.data ?? [],
        SEARCH_DISPLAY_LIMIT,
      ),
    [plansQuery.data, recordsQuery.data],
  );
  const isDebouncing = query.trim().length > 0 && query.trim() !== debouncedQuery;
  const isLoading =
    isDebouncing ||
    (hasDebouncedQuery &&
      (plansQuery.isLoading ||
        recordsQuery.isLoading ||
        activitiesQuery.isLoading ||
        archivedActivitiesQuery.isLoading ||
        plansQuery.isFetching ||
        recordsQuery.isFetching ||
        activitiesQuery.isFetching ||
        archivedActivitiesQuery.isFetching));
  const isError =
    !isDebouncing &&
    hasDebouncedQuery &&
    (plansQuery.isError ||
      recordsQuery.isError ||
      activitiesQuery.isError ||
      archivedActivitiesQuery.isError);

  const resetSearch = useCallback(() => {
    cancelDebounce();
    setQuery('');
    setDebouncedQuery('');
  }, [cancelDebounce]);

  const resetAndClose = useCallback(() => {
    resetSearch();
    onOpenChange(false);
  }, [onOpenChange, resetSearch]);

  // shellの排他制御など、controlled prop側から閉じられた場合も検索語を破棄する。
  useEffect(() => {
    if (wasOpenRef.current && !open) resetSearch();
    wasOpenRef.current = open;
  }, [open, resetSearch]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      resetAndClose();
    },
    [onOpenChange, resetAndClose],
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const trimmedQuery = nextQuery.trim();
      if (trimmedQuery.length === 0) {
        cancelDebounce();
        setDebouncedQuery('');
        return;
      }
      setQueryAfterDelay(trimmedQuery);
    },
    [cancelDebounce, setQueryAfterDelay],
  );

  const handleOpenResult = useCallback(
    (result: TimeblockSearchResult) => {
      resetAndClose();
      onOpenResult(result);
    },
    [onOpenResult, resetAndClose],
  );

  const retry = useCallback(() => {
    void Promise.all([
      plansQuery.refetch(),
      recordsQuery.refetch(),
      activitiesQuery.refetch(),
      archivedActivitiesQuery.refetch(),
    ]);
  }, [plansQuery, recordsQuery, activitiesQuery, archivedActivitiesQuery]);

  const searchContent = (
    <TimeblockSearchContent
      query={query}
      results={merged.results}
      activitiesById={activitiesById}
      isLoading={isLoading}
      isError={isError}
      hasMore={merged.hasMore}
      locale={locale}
      timezone={timezone}
      timeFormat={timeFormat}
      onOpenResult={handleOpenResult}
      onRetry={retry}
    />
  );
  const hasResultList =
    query.trim().length > 0 && !isLoading && !isError && merged.results.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      responsive={responsive}
      modal={false}
      title={t('calendar.search.title')}
      description={t('calendar.search.description')}
      mobilePresentation="full-height"
      className="sm:max-w-xl [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:right-2"
    >
      <div className="border-border flex shrink-0 items-center gap-1 border-b p-2 md:contents md:border-0 md:p-0">
        <CommandInput
          value={query}
          onValueChange={handleQueryChange}
          placeholder={t('calendar.search.placeholder')}
          aria-label={t('calendar.search.inputLabel')}
          className="h-11 py-0 text-base md:h-12 md:py-4 md:text-sm"
          containerClassName="!h-11 min-w-0 flex-1 rounded-lg border-0 bg-muted px-4 md:!h-12 md:w-full md:flex-none md:rounded-none md:border-b md:bg-transparent"
          maxLength={200}
          autoFocus
          data-sentry-mask
        />
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="shrink-0 px-2 md:hidden"
          onClick={resetAndClose}
        >
          {t('common.actions.cancel')}
        </Button>
      </div>
      {hasResultList ? (
        <CommandList
          className="max-h-none min-h-0 flex-1 md:max-h-80 md:flex-none"
          aria-busy={false}
          data-sentry-block
        >
          {searchContent}
        </CommandList>
      ) : (
        <div
          // mobile: 空状態メッセージが利用可能な高さいっぱいで中央寄せされるよう
          // このラッパー自身を flex-col コンテナにする。justify-center が主軸
          // （縦）を中央寄せし、align-items の既定値 stretch が交差軸（横）で
          // 子要素を従来どおり全幅にする（子の text-center と組み合わさる）。
          // desktop は md:block で従来の block layout（上寄せ、max-h-80 で
          // 高さ固定）に戻す（#2296）
          className="flex max-h-none min-h-0 flex-1 flex-col justify-center overflow-x-hidden overflow-y-auto md:block md:max-h-80 md:flex-none"
          aria-busy={isLoading}
          data-sentry-block
        >
          {searchContent}
        </div>
      )}
    </CommandDialog>
  );
}
