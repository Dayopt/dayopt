'use client';

import { formatInTimeZone } from 'date-fns-tz';
import { X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useDomSlot } from '@/lib/dom-slots/useDomSlot';
import { Button, Skeleton } from '@dayopt/components';
import { ACTIVITY_DETAIL_SLOT_KEY } from '../../lib/activity-detail-slot';
import { formatActivityDuration } from '../../lib/format-activity-duration';

import type { ActivityDetailTarget } from '@/lib/stores/useActivityDetailStore';
import type { ActivitySummaryResult } from '../../types/activity-summary';

interface ActivitySummaryPanelProps {
  target: ActivityDetailTarget;
  data: ActivitySummaryResult | undefined;
  timezone: string;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
  onOpenRecord?: ((target: { id: string; dayKey: string }) => void) | undefined;
}

export function ActivitySummaryPanel({
  target,
  data,
  timezone,
  isPending,
  isError,
  onRetry,
  onClose,
  onOpenRecord,
}: ActivitySummaryPanelProps) {
  const t = useTranslations('activities.activitySummary');
  const locale = useLocale();
  const tCommon = useTranslations('common');

  return (
    <>
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground truncate text-sm font-medium">{target.name}</h2>
          <p className="text-muted-foreground text-xs">
            {data
              ? t('period', {
                  start: formatDate(data.startDate, locale),
                  end: formatDate(data.endDate, locale),
                })
              : t('periodLoading')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          icon
          size="sm"
          onClick={onClose}
          aria-label={t('close')}
        >
          <X className="size-4" />
        </Button>
      </header>

      {isError ? (
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">{t('error')}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {tCommon('actions.retry')}
          </Button>
        </div>
      ) : isPending || data === undefined ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              label={t('recorded')}
              value={formatActivityDuration(data.recordedMinutes, locale)}
            />
            <Stat
              label={t('median')}
              value={
                data.medianBoxMinutes === null
                  ? t('noMedian')
                  : formatActivityDuration(data.medianBoxMinutes, locale)
              }
            />
          </div>
          <section className="min-h-0 flex-1">
            <h3 className="text-muted-foreground mb-2 text-xs">
              {t('records', { count: data.totalRecordCount })}
            </h3>
            {data.records.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.records.map((record) => (
                  <li key={record.id}>
                    <button
                      type="button"
                      className="hover:bg-state-hover flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-xs"
                      onClick={() =>
                        onOpenRecord?.({
                          id: record.id,
                          dayKey: formatInTimeZone(
                            new Date(record.startAt),
                            timezone,
                            'yyyy-MM-dd',
                          ),
                        })
                      }
                      disabled={!onOpenRecord}
                    >
                      <span className="text-muted-foreground min-w-28 shrink-0">
                        {formatRecordDate(record.startAt, locale, timezone)}
                      </span>
                      <span className="text-foreground min-w-0 flex-1 truncate">
                        {record.title}
                      </span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatActivityDuration(record.minutes, locale)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {data.totalRecordCount > data.records.length && (
              <p className="text-muted-foreground mt-2 text-xs">
                {t('truncated', { count: data.totalRecordCount - data.records.length })}
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function ActivitySummaryDesktopPanel({ content }: { content: ReactNode }) {
  const t = useTranslations('activities.activitySummary');
  const slot = useDomSlot(ACTIVITY_DETAIL_SLOT_KEY);
  if (!slot) return null;
  return createPortal(
    <section
      aria-label={t('ariaLabel')}
      data-activity-summary-panel="true"
      className="flex h-full flex-col gap-4 overflow-y-auto p-4"
    >
      {content}
    </section>,
    slot,
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border-subtle bg-card flex flex-col gap-1 rounded-lg border p-3 shadow-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground text-sm tabular-nums">{value}</span>
    </div>
  );
}

function formatDate(value: string, locale: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12)));
}

function formatRecordDate(value: string, locale: string, timezone: string) {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));
}
