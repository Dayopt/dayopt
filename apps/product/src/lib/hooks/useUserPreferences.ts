'use client';

import type { inferRouterOutputs } from '@trpc/server';
import { useLocale } from 'next-intl';
import { useCallback } from 'react';

import { CACHE_5_MINUTES } from '@/lib/date';
import { api, type AppRouter } from '@/lib/trpc';

export type DateFormatType = 'yyyy/MM/dd' | 'MM/dd/yyyy' | 'dd/MM/yyyy' | 'yyyy-MM-dd';

export interface UserPreference {
  timezone: string;
  timeFormat: '24h' | '12h';
  dateFormat: DateFormatType;
  weekStartsOn: 0 | 1 | 6;
  showWeekNumbers: boolean;
  defaultDuration: number;
}

type UserSettingsData = inferRouterOutputs<AppRouter>['userSettings']['get'];

function getBrowserTimezone(): string {
  return typeof window === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * 日付表記は画面の言語（next-intl の locale）に揃える。user_settings の
 * preferredLocale はメール等の配信言語で、設定の「言語」select は URL locale だけを
 * 切り替えるため両者はずれうる。ja の画面に MM/dd/yyyy が出ていた（2026-09-14）。
 */
function resolveDateFormat(locale: string): UserPreference['dateFormat'] {
  return locale === 'ja' ? 'yyyy/MM/dd' : 'MM/dd/yyyy';
}

export function toUserPreferences(
  settings: UserSettingsData | undefined,
  locale: string,
): UserPreference {
  if (!settings) {
    return {
      timezone: getBrowserTimezone(),
      timeFormat: '24h',
      dateFormat: 'yyyy-MM-dd',
      weekStartsOn: 1,
      showWeekNumbers: false,
      defaultDuration: 60,
    };
  }

  return {
    timezone: settings.timezone,
    timeFormat: settings.timeFormat,
    dateFormat: resolveDateFormat(locale),
    weekStartsOn: settings.weekStartsOn,
    showWeekNumbers: settings.showWeekNumbers,
    defaultDuration: settings.defaultDuration,
  };
}

/** user_settings query cacheをapp-wideな表示設定へ写像する。 */
export function useUserPreferences<T = UserPreference>(
  selector?: (preferences: UserPreference) => T,
): T {
  const locale = useLocale();
  const selectPreferences = useCallback(
    (settings: UserSettingsData) => {
      const preferences = toUserPreferences(settings, locale);
      return selector ? selector(preferences) : (preferences as T);
    },
    [selector, locale],
  );
  const { data } = api.userSettings.get.useQuery(undefined, {
    staleTime: CACHE_5_MINUTES,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    select: selectPreferences,
  });
  if (data !== undefined) return data as T;

  const fallback = toUserPreferences(undefined, locale);
  return selector ? selector(fallback) : (fallback as T);
}
