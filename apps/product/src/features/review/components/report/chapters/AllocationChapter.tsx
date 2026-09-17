'use client';

import { useState } from 'react';

import { ArrowDown, ArrowUp, Clock, Hash, Timer } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { getCategoryColorClasses } from '@/features/activities';
import { cn } from '@dayopt/components';

import { formatReportSpan, formatReportSpanDelta } from '../../../domain/report/format-duration';
import { sortActivityUsageRows } from '../../../domain/report/report-view-model';

import type {
  ReportActivityUsageRow,
  ReportAllocationSlice,
  ReportDurationBin,
  ReportInkColumn,
  ReportUsageSortKey,
  ReportUsageSummary,
} from '../../../domain/report/report-view-model';
import type { ReportGranularity } from '../../../lib/report-period';
import type { ReportDetailTarget } from '../../../stores/useReportDetailStore';

interface AllocationChapterProps {
  granularity: ReportGranularity;
  /** 記録時間 / 件数 / 1 件の中央値と、その前期間の値。 */
  summary: ReportUsageSummary;
  /** 余白（書かれていない時間）。記録時間のカードに小さく添えるだけで、配分には混ぜない。 */
  marginMinutes: number;
  /** 日別（週）／週別（月）／月別（年）の列。高さは `totalMinutes`。 */
  columns: readonly ReportInkColumn[];
  /** 配分の内訳。`mode` が `none`（アクティビティが 1 つだけ）なら配分のブロックを省く。 */
  allocation: { mode: 'category' | 'activity' | 'none'; slices: readonly ReportAllocationSlice[] };
  /** 0〜23 時の記録（分）。 */
  hourTotals: readonly number[];
  /** 1 件の長さの分布。 */
  durationBins: readonly ReportDurationBin[];
  /** アクティビティ一覧。並びはブロックの中で切り替える。 */
  usageRows: readonly ReportActivityUsageRow[];
  /** 一覧の行を押した時に詳細パネルを開く。 */
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
}

/** 日ごとの棒の描画高（px）。 */
const DAILY_CHART_HEIGHT = 160;
/** 時間帯・1 件の長さの分布の描画高（px）。 */
const DISTRIBUTION_CHART_HEIGHT = 96;
/** 1 件の長さの分布で目盛りを出すビンの下限（分）。 */
const DURATION_TICKS = new Set([0, 15, 60, 120]);

/**
 * 時間の使い方の面。
 *
 * 上段に数字のカード 3 枚（記録時間 / 件数 / 1 件の中央値）。下段は広い幅で 2 列:
 * 左に「日ごとの記録時間」と「アクティビティ一覧」、右に「配分」と 2 つの分布
 * （時間帯 / 1 件の長さ）。狭い幅では 1 列に積む。
 *
 * **評価しない**（仕様 §0-2）。前期間との差は矢印と符号で示すだけで、増減に良し悪しの色を
 * 付けない。件数は「完了した数」ではなく、時間帯の偏りは「集中できる時間」ではない。
 */
export function AllocationChapter({
  granularity,
  summary,
  marginMinutes,
  columns,
  allocation,
  hourTotals,
  durationBins,
  usageRows,
  onSelectActivity,
}: AllocationChapterProps) {
  const t = useTranslations('report.allocation');

  return (
    <section
      aria-label={t('kick')}
      data-report-chapter="allocation"
      className="@container flex flex-col gap-4"
    >
      <h2 className="sr-only">{t('kick')}</h2>

      <SummaryCards granularity={granularity} marginMinutes={marginMinutes} summary={summary} />

      <div className="grid gap-4 @5xl:grid-cols-5">
        <div className="flex min-w-0 flex-col gap-4 @5xl:col-span-3">
          <DailyChart columns={columns} granularity={granularity} />
          <UsageTable onSelectActivity={onSelectActivity} rows={usageRows} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 @5xl:col-span-2">
          {allocation.mode !== 'none' && (
            <AllocationBars
              mode={allocation.mode}
              slices={allocation.slices}
              totalMinutes={summary.current.recordedMinutes}
            />
          )}
          <div className="grid gap-4 @md:grid-cols-2">
            <HourChart totals={hourTotals} />
            <DurationChart bins={durationBins} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** ブロックの器。カードと同じ面・枠・角丸。 */
function Panel({
  title,
  children,
  className,
  headingId,
}: {
  title: string;
  children: React.ReactNode;
  className?: string | undefined;
  headingId?: string | undefined;
}) {
  return (
    <div
      className={cn(
        'bg-card border-border-subtle flex min-w-0 flex-col gap-3 rounded-2xl border p-4 shadow-sm',
        className,
      )}
    >
      <h3 id={headingId} className="text-foreground text-sm font-medium">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ============================================================
// ① 数字のカード
// ============================================================

function SummaryCards({
  granularity,
  marginMinutes,
  summary,
}: {
  granularity: ReportGranularity;
  marginMinutes: number;
  summary: ReportUsageSummary;
}) {
  const t = useTranslations('report.allocation.cards');
  const locale = useLocale();
  const { current, previous } = summary;
  const deltaLabel = t(`deltaLabel.${granularity}`);

  return (
    <div className="grid gap-4 @2xl:grid-cols-3">
      <SummaryCard
        icon={<Clock className="size-4" />}
        label={t('recorded')}
        value={formatReportSpan(current.recordedMinutes, locale)}
        valueTestId="recorded"
        delta={
          previous === null
            ? null
            : {
                label: deltaLabel,
                diff: current.recordedMinutes - previous.recordedMinutes,
                text: formatReportSpanDelta(
                  current.recordedMinutes - previous.recordedMinutes,
                  locale,
                ),
                base: previous.recordedMinutes,
              }
        }
        note={t('margin', { margin: formatReportSpan(Math.max(0, marginMinutes), locale) })}
      />
      <SummaryCard
        icon={<Hash className="size-4" />}
        label={t('count')}
        value={t('countValue', { count: current.recordCount })}
        valueTestId="count"
        delta={
          previous === null
            ? null
            : {
                label: deltaLabel,
                diff: current.recordCount - previous.recordCount,
                text: t('countDelta', {
                  diff: formatSigned(current.recordCount - previous.recordCount),
                }),
                base: previous.recordCount,
              }
        }
      />
      <SummaryCard
        icon={<Timer className="size-4" />}
        label={t('median')}
        value={
          current.medianMinutes === null
            ? t('unavailable')
            : formatReportSpan(current.medianMinutes, locale)
        }
        valueTestId="median"
        delta={
          previous === null || previous.medianMinutes === null || current.medianMinutes === null
            ? null
            : {
                label: deltaLabel,
                diff: current.medianMinutes - previous.medianMinutes,
                text: formatReportSpanDelta(current.medianMinutes - previous.medianMinutes, locale),
                base: previous.medianMinutes,
              }
        }
      />
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  valueTestId,
  delta,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueTestId: string;
  delta: { label: string; diff: number; text: string; base: number } | null;
  note?: string | undefined;
}) {
  const t = useTranslations('report.allocation.cards');
  // 割合は前期間の値が 0 だと作れない（無限大を出さない）。差そのものは出す
  const percent = delta && delta.base > 0 ? Math.round((delta.diff / delta.base) * 100) : null;

  return (
    <div className="bg-card border-border-subtle flex min-w-0 items-start gap-3 rounded-2xl border p-4 shadow-sm">
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p
          data-report-summary={valueTestId}
          className="text-foreground text-2xl font-medium tabular-nums"
        >
          {value}
        </p>
        {delta === null ? (
          <p className="text-muted-foreground text-xs">{t('noPrevious')}</p>
        ) : (
          // 増減は矢印と符号だけで示し、色で良し悪しを付けない（仕様 §0-2）
          <p
            data-report-summary-delta={valueTestId}
            className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums"
          >
            <span>{delta.label}</span>
            <span>{delta.text}</span>
            {percent !== null && <span>{t('percent', { percent: formatSigned(percent) })}</span>}
            {delta.diff > 0 && <ArrowUp aria-hidden className="size-3" />}
            {delta.diff < 0 && <ArrowDown aria-hidden className="size-3" />}
          </p>
        )}
        {note && <p className="text-muted-foreground text-xs tabular-nums">{note}</p>}
      </div>
    </div>
  );
}

// ============================================================
// ② 日ごとの記録時間
// ============================================================

function DailyChart({
  columns,
  granularity,
}: {
  columns: readonly ReportInkColumn[];
  granularity: ReportGranularity;
}) {
  const t = useTranslations('report.allocation.daily');
  const locale = useLocale();
  const weekdays = t.raw('weekdays') as string[];
  const max = Math.max(0, ...columns.map((column) => column.totalMinutes));
  const { top, ticks } = resolveHourAxis(max);

  return (
    <Panel title={t(`heading.${granularity}`)}>
      {max === 0 ? (
        <p className="text-muted-foreground text-xs">{t(`empty.${granularity}`)}</p>
      ) : (
        <div className="flex gap-2">
          {/* 縦軸（時間）。目盛りは上から */}
          <div
            aria-hidden
            className="text-muted-foreground flex shrink-0 flex-col justify-between text-right text-xs tabular-nums"
            style={{ height: DAILY_CHART_HEIGHT }}
          >
            {[...ticks].reverse().map((tick) => (
              <span key={tick} className="leading-none">
                {t('axisHours', { hours: tick / 60 })}
              </span>
            ))}
          </div>

          <ul data-report-chart="daily" className="flex min-w-0 flex-1 items-end gap-2">
            {columns.map((column, index) => {
              const label = columnLabel({ column, granularity, index, weekdays, t });
              // 狭い幅では日付を落として曜日だけにする（7 列に「9/14（月）」は収まらない）
              const shortLabel =
                granularity === 'week'
                  ? (weekdays[(new Date(`${column.key}T00:00:00`).getDay() + 6) % 7] ?? label)
                  : label;
              return (
                <li key={column.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span
                    className="border-border-subtle relative flex w-full items-end border-b"
                    style={{ height: DAILY_CHART_HEIGHT }}
                    aria-label={t('barAriaLabel', {
                      label,
                      recorded: formatReportSpan(column.totalMinutes, locale),
                    })}
                    role="img"
                  >
                    <span
                      data-report-daily-bar
                      className="mx-auto w-full max-w-10 rounded-t-lg"
                      style={{
                        height: `${(column.totalMinutes / top) * 100}%`,
                        backgroundColor: 'var(--chart-1)',
                      }}
                    />
                  </span>
                  <span
                    aria-hidden
                    className="text-muted-foreground max-w-full truncate text-xs @xl:hidden"
                  >
                    {shortLabel}
                  </span>
                  <span
                    aria-hidden
                    className="text-muted-foreground hidden max-w-full truncate text-xs @xl:inline"
                  >
                    {label}
                  </span>
                  {/* 列ごとの合計は幅があるときだけ。狭い幅では棒の読み上げ名と縦軸で読む */}
                  <span
                    aria-hidden
                    className="text-foreground hidden max-w-full truncate text-xs tabular-nums @2xl:inline"
                  >
                    {column.totalMinutes > 0 ? formatReportSpan(column.totalMinutes, locale) : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/**
 * 時間の縦軸。上端を「きりのいい時間」に丸め、目盛りを 0 を含めて最大 5 本にする。
 * 期間の粒度で列の合計が 1 時間から数百時間まで変わるので、刻みを候補から選ぶ。
 */
function resolveHourAxis(maxMinutes: number): { top: number; ticks: number[] } {
  const stepsInHours = [1, 2, 4, 6, 8, 12, 24, 48, 72, 120, 168, 240, 480, 720];
  const stepMinutes =
    (stepsInHours.find((hours) => Math.ceil(maxMinutes / (hours * 60)) <= 4) ?? 720) * 60;
  const top = Math.max(stepMinutes, Math.ceil(maxMinutes / stepMinutes) * stepMinutes);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += stepMinutes) ticks.push(value);
  return { top, ticks };
}

function columnLabel({
  column,
  granularity,
  index,
  weekdays,
  t,
}: {
  column: ReportInkColumn;
  granularity: ReportGranularity;
  index: number;
  weekdays: string[];
  t: ReturnType<typeof useTranslations<'report.allocation.daily'>>;
}): string {
  if (granularity === 'week') {
    // 列は週の開始曜日に従って並ぶので、曜日名は列の日付から引く（配列の index ではない）
    const date = new Date(`${column.key}T00:00:00`);
    const weekday = weekdays[(date.getDay() + 6) % 7] ?? '';
    return t('dayLabel', { month: date.getMonth() + 1, day: date.getDate(), weekday });
  }
  if (granularity === 'month') {
    return t('weekColumn', { index: index + 1 });
  }
  return t('monthColumn', { month: Number(column.key.slice(5)) });
}

// ============================================================
// ③ 配分
// ============================================================

/**
 * 配分の横棒。1 行 = 1 区画で、名前・棒・時間・割合を同じ行に置く。
 * 棒の長さは記録の合計に対する割合そのもの（全部足すと 100%）。円グラフにはしない。
 */
function AllocationBars({
  mode,
  slices,
  totalMinutes,
}: {
  mode: 'category' | 'activity';
  slices: readonly ReportAllocationSlice[];
  totalMinutes: number;
}) {
  const t = useTranslations('report.allocation.breakdown');
  const locale = useLocale();
  const heading = t(`heading.${mode}`);

  return (
    <Panel title={heading}>
      <ul data-report-bars="allocation" aria-label={heading} className="flex flex-col gap-2">
        {slices.map((slice) => (
          <li key={slice.key} className="flex min-w-0 items-center gap-2 text-sm">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: sliceColor(slice.color) }}
            />
            <span className="text-foreground w-24 shrink-0 truncate">
              {slice.label ?? t('uncategorized')}
            </span>
            <span aria-hidden className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded-full">
              <span
                data-report-bar
                className="block h-full rounded-full"
                style={{
                  width: `${(slice.minutes / Math.max(1, totalMinutes)) * 100}%`,
                  backgroundColor: sliceColor(slice.color),
                }}
              />
            </span>
            <span className="text-foreground w-20 shrink-0 text-right tabular-nums">
              {formatReportSpan(slice.minutes, locale)}
            </span>
            <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
              {slice.percent}%
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ============================================================
// ④ アクティビティ一覧
// ============================================================

/**
 * アクティビティ一覧。数字を並べるだけでなく、詳しく見る対象を見つける入口。
 * 行を押すと詳細パネル（時間帯・1 件の長さの分布・明細）が開く。
 */
function UsageTable({
  onSelectActivity,
  rows,
}: {
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
  rows: readonly ReportActivityUsageRow[];
}) {
  const t = useTranslations('report.allocation.table');
  // 並びはブロックの中で完結する状態。期間やタブをまたいで憶えない（既定は規模で読む）
  const [sortKey, setSortKey] = useState<ReportUsageSortKey>('recorded');
  const sorted = sortActivityUsageRows(rows, sortKey);
  const maxRecorded = Math.max(1, ...rows.map((row) => row.recordedMinutes));

  return (
    <Panel title={t('heading')}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <div data-report-table="usage" className="flex flex-col">
          {/* 列見出し。並べ替えできる列だけがボタン */}
          <div className="text-muted-foreground border-border-subtle flex items-center gap-x-3 border-b px-2 pb-2 text-xs">
            <span className="min-w-0 flex-1">{t('columns.activity')}</span>
            <SortHeader
              active={sortKey === 'recorded'}
              className="w-24"
              label={t('columns.recorded')}
              onSelect={() => setSortKey('recorded')}
              sortLabel={t('sort.recorded')}
            />
            <span aria-hidden className="hidden w-24 shrink-0 @xl:block" />
            {/* 件数と中央値は狭い幅では落とす（名前・記録時間・差の 3 列を優先する） */}
            <span className="hidden w-10 shrink-0 text-right @lg:block">{t('columns.count')}</span>
            <span className="hidden w-16 shrink-0 text-right @lg:block">{t('columns.median')}</span>
            <SortHeader
              active={sortKey === 'delta'}
              className="w-24"
              label={t('columns.delta')}
              onSelect={() => setSortKey('delta')}
              sortLabel={t('sort.delta')}
            />
          </div>

          <ul className="flex flex-col">
            {sorted.map((row) => (
              <UsageRow
                key={row.activityId ?? '__unassigned'}
                maxRecorded={maxRecorded}
                onSelectActivity={onSelectActivity}
                row={row}
              />
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SortHeader({
  active,
  className,
  label,
  onSelect,
  sortLabel,
}: {
  active: boolean;
  className: string;
  label: string;
  onSelect: () => void;
  sortLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={sortLabel}
      onClick={onSelect}
      className={cn(
        'hover:text-foreground focus-visible:ring-ring flex shrink-0 items-center justify-end gap-1 rounded-lg text-right focus-visible:ring-2 focus-visible:outline-hidden',
        active && 'text-foreground',
        className,
      )}
    >
      {label}
      {active && <ArrowDown aria-hidden className="size-3" />}
    </button>
  );
}

function UsageRow({
  maxRecorded,
  onSelectActivity,
  row,
}: {
  maxRecorded: number;
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
  row: ReportActivityUsageRow;
}) {
  const t = useTranslations('report.allocation.table');
  const locale = useLocale();
  const name = row.name ?? t('unnamed');
  const recorded = formatReportSpan(row.recordedMinutes, locale);

  return (
    <li>
      <button
        type="button"
        // 詳細パネルを開く（本体は Composition Bridge が描く。#2581）
        onClick={() =>
          onSelectActivity?.({
            activityId: row.activityId,
            name: row.name,
            categoryName: row.categoryName,
            color: row.color,
          })
        }
        aria-label={t('rowAriaLabel', { name, recorded })}
        className="hover:bg-state-hover focus-visible:ring-ring flex min-h-11 w-full items-center gap-x-3 rounded-lg px-2 py-2 text-left focus-visible:ring-2 focus-visible:outline-hidden"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: sliceColor(row.color) }}
          />
          <span className={cn('min-w-0 truncate text-sm', row.archived && 'opacity-50')}>
            {name}
          </span>
        </span>
        <span className="text-foreground w-24 shrink-0 text-right text-sm tabular-nums">
          {recorded}
        </span>
        <span aria-hidden className="hidden h-2 w-24 shrink-0 @xl:block">
          <span
            className="block h-full rounded-full"
            style={{
              width: `${(row.recordedMinutes / maxRecorded) * 100}%`,
              backgroundColor: sliceColor(row.color),
            }}
          />
        </span>
        <span className="text-muted-foreground hidden w-10 shrink-0 text-right text-xs tabular-nums @lg:block">
          {row.recordBoxes}
        </span>
        {/* 数えられる記録が無い行は数字を作らない（0 分ではなくダッシュ） */}
        <span className="text-muted-foreground hidden w-16 shrink-0 text-right text-xs tabular-nums @lg:block">
          {row.medianRecordMinutes === null
            ? t('unavailable')
            : formatReportSpan(row.medianRecordMinutes, locale)}
        </span>
        <span className="text-muted-foreground flex w-24 shrink-0 items-center justify-end gap-1 text-xs tabular-nums">
          {row.deltaMinutes === null ? (
            t('unavailable')
          ) : (
            <>
              {row.deltaMinutes > 0 && <ArrowUp aria-hidden className="size-3" />}
              {row.deltaMinutes < 0 && <ArrowDown aria-hidden className="size-3" />}
              {formatReportSpanDelta(row.deltaMinutes, locale)}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

// ============================================================
// ⑤ 時間帯の分布 / ⑥ 1 件の長さの分布
// ============================================================

/**
 * 時間帯の分布（0〜23 時）。多い時間帯は「集中できる時間」ではなく、記録が置かれた時間帯
 * というだけ（予定の都合かもしれない）。評価の言葉を添えない。
 */
function HourChart({ totals }: { totals: readonly number[] }) {
  const t = useTranslations('report.allocation.hours');
  const locale = useLocale();
  const max = Math.max(0, ...totals);

  return (
    <Panel title={t('heading')}>
      {max === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <ul
            data-report-chart="hours"
            className="border-border-subtle flex items-end gap-px border-b"
            style={{ height: DISTRIBUTION_CHART_HEIGHT }}
          >
            {totals.map((minutes, hour) => (
              <li key={hour} className="flex h-full min-w-0 flex-1">
                {/* role は li に付けない（list の子は listitem のまま。axe の aria-allowed-role） */}
                <span
                  role="img"
                  aria-label={t('barAriaLabel', {
                    hour,
                    recorded: formatReportSpan(minutes, locale),
                  })}
                  className="flex h-full w-full items-end"
                >
                  <span
                    className="block w-full rounded-t-lg"
                    style={{
                      height: `${(minutes / max) * 100}%`,
                      backgroundColor: 'var(--chart-1)',
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
          <div aria-hidden className="text-muted-foreground grid grid-cols-4 text-xs tabular-nums">
            {[0, 6, 12, 18].map((hour) => (
              <span key={hour}>{t('axis', { hour })}</span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * 1 件の長さの分布。中央値だけでは「毎回 30 分くらい」か「短いものと長いものの混在」かが
 * 見えないので、件数の分布で示す。これは 1 件の記録の長さで、作業の完了に要る時間ではない。
 */
function DurationChart({ bins }: { bins: readonly ReportDurationBin[] }) {
  const t = useTranslations('report.allocation.durations');
  const max = Math.max(0, ...bins.map((bin) => bin.count));

  return (
    <Panel title={t('heading')}>
      {max === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <ul
            data-report-chart="durations"
            className="border-border-subtle flex items-end gap-1 border-b"
            style={{ height: DISTRIBUTION_CHART_HEIGHT }}
          >
            {bins.map((bin) => {
              const label = binLabel(bin, t);
              return (
                <li key={bin.fromMinutes} className="flex h-full min-w-0 flex-1">
                  <span
                    role="img"
                    aria-label={t('barAriaLabel', { label, count: bin.count })}
                    className="flex h-full w-full items-end"
                  >
                    <span
                      className="block w-full rounded-t-lg"
                      style={{
                        height: `${(bin.count / max) * 100}%`,
                        backgroundColor: 'var(--chart-2)',
                      }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
          {/* 目盛りは区切りのいい下限だけに出す。全ビンに出すと狭い幅で文字が潰れる */}
          <div aria-hidden className="text-muted-foreground flex gap-1 text-xs tabular-nums">
            {bins.map((bin) => (
              <span
                key={bin.fromMinutes}
                className="min-w-0 flex-1 overflow-visible whitespace-nowrap"
              >
                {DURATION_TICKS.has(bin.fromMinutes) ? binTick(bin, t) : null}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** 読み上げ用のビンの名前（「15〜30 分」）。 */
function binLabel(
  bin: ReportDurationBin,
  t: ReturnType<typeof useTranslations<'report.allocation.durations'>>,
): string {
  if (bin.toMinutes === null) return t('rangeOpen', { from: bin.fromMinutes });
  return t('range', { from: bin.fromMinutes, to: bin.toMinutes });
}

/** 軸の短い目盛り。下限だけを出し、60 分以上は時間で書く。 */
function binTick(
  bin: ReportDurationBin,
  t: ReturnType<typeof useTranslations<'report.allocation.durations'>>,
): string {
  if (bin.fromMinutes >= 60 && bin.fromMinutes % 60 === 0) {
    return t('tickHours', { hours: bin.fromMinutes / 60 });
  }
  return t('tickMinutes', { minutes: bin.fromMinutes });
}

/** 符号付きの整数（+17 / −10 / 0）。 */
function formatSigned(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}

/**
 * カテゴリ色を CSS 変数へ写す。未分類（色なし）は `--muted-foreground`。
 *
 * 塗り面積が可変なので Tailwind クラスではなく inline style で色を渡す
 * （幅・高さと同じ style 属性にまとめる）。値は semantic token の変数のみ。
 */
function sliceColor(color: string | null): string {
  if (color === null) return 'var(--muted-foreground)';
  return getCategoryColorClasses(color).cssVar;
}
