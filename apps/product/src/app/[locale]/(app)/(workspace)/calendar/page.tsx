import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import type { CalendarViewType } from '@/features/calendar';
import { HydrationBoundary } from '@/lib/trpc/server';
import type { Locale } from '@dayopt/i18n/routing';

import { CalendarViewClient } from '../_composition/CalendarViewClient';
import { getCalendarTranslations, parseCalendarViewParam } from '../_server/calendar-page-params';
import { prefetchCalendarData } from '../_server/calendar-prefetch';
import { CalendarSkeleton } from '../_server/CalendarSkeleton';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale?: Locale }>;
  searchParams: Promise<{ view?: string }>;
}): Promise<Metadata> {
  const { locale = 'ja' } = await params;
  const { view } = await searchParams;
  const t = await getTranslations({ locale, namespace: 'calendar' });

  const match = view?.match(/^(\d+)day$/);
  const title = match
    ? t('views.multiday', { count: parseInt(match[1]!) })
    : view === 'day'
      ? t('views.day')
      : t('views.week');

  return {
    title,
    description: t('meta.description'),
  };
}

/** データプリフェッチを分離し、Suspense でストリーミング可能にする */
async function CalendarPageContent({
  viewType,
  locale,
  date,
}: {
  viewType: CalendarViewType;
  locale: Locale;
  date: string | undefined;
}) {
  const translations = await getCalendarTranslations(locale);
  const { dehydratedState } = await prefetchCalendarData(viewType, date);

  return (
    <HydrationBoundary state={dehydratedState}>
      <CalendarViewClient translations={translations} />
    </HydrationBoundary>
  );
}

const CalendarPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale?: Locale }>;
  searchParams: Promise<{ date?: string; view?: string }>;
}) => {
  const { locale = 'ja' } = await params;
  const { date, view } = await searchParams;

  // view 省略時は week として扱う（現行 /week /[locale]/page.tsx と同じ既定挙動）。
  // 値が指定されていて解釈できない場合のみ 404（旧 [nday]/page.tsx の notFound() を移植）。
  const viewType = parseCalendarViewParam(view);
  if (view !== undefined && !viewType) {
    notFound();
  }

  return (
    <Suspense fallback={<CalendarSkeleton />}>
      <CalendarPageContent viewType={viewType ?? 'week'} locale={locale} date={date} />
    </Suspense>
  );
};

export default CalendarPage;
