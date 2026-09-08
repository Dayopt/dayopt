'use client';

import { useTranslations } from 'next-intl';

import { getCategoryColorClasses } from '@/features/activities';
import { cn } from '@dayopt/components';

import { formatReportDelta, formatReportDuration } from '../../../domain/report/format-duration';

import type {
  ReportAllocationSlice,
  ReportDenominators,
  ReportInkColumn,
  ReportSegmentBar,
} from '../../../domain/report/report-view-model';
import type { ReportGranularity } from '../../../lib/report-period';

interface AllocationChapterProps {
  granularity: ReportGranularity;
  denominators: ReportDenominators;
  /** 決算バーと凡例のセグメント。記録 0 のものは含まない。 */
  slices: readonly ReportAllocationSlice[];
  segmentBars: readonly ReportSegmentBar[];
  inkColumns: readonly ReportInkColumn[];
  maxInkMinutes: number;
  /** 未分類の占める割合（%）。 */
  uncategorizedPercent: number;
  /** 前期間との差（分）。前期間にインクが無ければ `null` で、Δ を出さない。 */
  previousDeltaMinutes: number | null;
  /** 余白を分母に入れているか。 */
  marginVisible: boolean;
  /** 選択中のセグメントレンズの名前。`null` は「すべて」（レンズなし）。 */
  activeSegmentName: string | null;
}

/** 日別インクの最大高さ（px）。仕様 §4.1。 */
const INK_MAX_HEIGHT = 72;

/**
 * 1 章「配分 — 何にいくら使ったか」。
 *
 * **余白を塗らない。** 余白 on のときは背景トラック（紙）として残し、セグメントも凡例の行も
 * 持たせない。「書かれていない時間は欠落ではなく紙」という仕様 §0-6 の扱いを、
 * 見た目でそのまま表す。
 */
export function AllocationChapter({
  granularity,
  denominators,
  slices,
  segmentBars,
  inkColumns,
  maxInkMinutes,
  uncategorizedPercent,
  previousDeltaMinutes,
  marginVisible,
  activeSegmentName,
}: AllocationChapterProps) {
  const t = useTranslations('report.allocation');
  const lensActive = activeSegmentName !== null;
  const showSegments = !lensActive && segmentBars.length > 0;
  const hasInk = inkColumns.some((column) => column.stacks.some((stack) => stack.minutes > 0));

  return (
    <section
      aria-label={t('kick')}
      data-report-chapter="allocation"
      className="border-border-subtle @container flex flex-col gap-4 border-b pb-8 last:border-b-0"
    >
      <h2 className="text-foreground text-sm font-medium">{t('kick')}</h2>

      <Headline
        activeSegmentName={activeSegmentName}
        denominators={denominators}
        granularity={granularity}
        marginVisible={marginVisible}
        previousDeltaMinutes={previousDeltaMinutes}
        uncategorizedPercent={uncategorizedPercent}
      />

      <SettlementBar
        ariaLabel={lensActive ? t('barAriaLabelLens') : t('barAriaLabel')}
        marginVisible={marginVisible}
        slices={slices}
        trackMinutes={denominators.trackMinutes}
      />

      {/* レンズ中はセグメント別バーを出さない。分母が選択中セグメントの記録合計なので、
          選択中だけ 100%・他が 0% と並び、比較としての意味を失う（2026-09-04 User 裁可） */}
      <div className={cn('grid gap-6', showSegments && '@lg:grid-cols-2')}>
        <Legend granularity={granularity} slices={slices} />
        {showSegments && <SegmentBars bars={segmentBars} />}
      </div>

      {hasInk && (
        <InkColumns columns={inkColumns} granularity={granularity} maxMinutes={maxInkMinutes} />
      )}
    </section>
  );
}

function Headline({
  activeSegmentName,
  denominators,
  granularity,
  marginVisible,
  previousDeltaMinutes,
  uncategorizedPercent,
}: Pick<
  AllocationChapterProps,
  | 'activeSegmentName'
  | 'denominators'
  | 'granularity'
  | 'marginVisible'
  | 'previousDeltaMinutes'
  | 'uncategorizedPercent'
>) {
  const t = useTranslations('report.allocation');

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <p
        data-report-headline="recorded"
        className="text-foreground text-3xl font-medium tabular-nums"
      >
        {formatReportDuration(denominators.visibleMinutes)}
      </p>

      <p className="text-muted-foreground text-xs">
        {marginVisible
          ? t('subtitleWithMargin', {
              recorded: formatReportDuration(denominators.visibleMinutes),
              margin: formatReportDuration(Math.max(0, denominators.marginMinutes)),
            })
          : t('subtitleInkOnly')}
      </p>

      {activeSegmentName !== null && (
        <p data-report-lens className="text-muted-foreground text-xs">
          {t('lensLabel', { name: activeSegmentName })}
        </p>
      )}

      {previousDeltaMinutes !== null && (
        <p className="text-muted-foreground text-xs tabular-nums">
          {t(`deltaPrevious.${granularity}`)} {formatReportDelta(previousDeltaMinutes)}
        </p>
      )}

      <p className="text-muted-foreground ml-auto text-xs tabular-nums">
        {t('uncategorizedShare', { percent: uncategorizedPercent })}
      </p>
    </div>
  );
}

/**
 * 決算バー。全長は `track`。
 *
 * 余白 on のときは背景を `bg-muted`（紙）にして、塗るのはカテゴリのぶんだけ。
 * off のときは背景を透明にし、セグメントの合計が 100% になる。
 */
function SettlementBar({
  ariaLabel,
  marginVisible,
  slices,
  trackMinutes,
}: {
  ariaLabel: string;
  marginVisible: boolean;
  slices: readonly ReportAllocationSlice[];
  trackMinutes: number;
}) {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn(
        'flex h-3 overflow-hidden rounded-full',
        marginVisible ? 'bg-muted' : 'bg-transparent',
      )}
    >
      {slices.map((slice) => (
        <span
          key={slice.key}
          className="h-full"
          style={{
            width: `${(slice.minutes / trackMinutes) * 100}%`,
            backgroundColor: sliceColor(slice.color),
          }}
        />
      ))}
    </div>
  );
}

function Legend({
  granularity,
  slices,
}: {
  granularity: ReportGranularity;
  slices: readonly ReportAllocationSlice[];
}) {
  const t = useTranslations('report.allocation');

  if (slices.length === 0) {
    return <p className="text-muted-foreground text-xs">{t(`legendEmpty.${granularity}`)}</p>;
  }

  return (
    <ul data-report-legend="allocation" className="flex flex-col gap-2">
      {slices.map((slice) => (
        <li key={slice.key} className="flex items-center gap-2 text-sm">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: sliceColor(slice.color) }}
          />
          <span className="text-foreground min-w-0 flex-1 truncate">
            {slice.label ?? t('uncategorized')}
          </span>
          <span className="text-foreground tabular-nums">
            {formatReportDuration(slice.minutes)}
          </span>
          <span className="text-muted-foreground w-10 text-right tabular-nums">
            {slice.percent}%
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * セグメント別のバー。
 *
 * セグメント同士は重なってよく、合計しない。円グラフにも積み上げにもしない
 * （仕様 §12）。
 */
function SegmentBars({ bars }: { bars: readonly ReportSegmentBar[] }) {
  const t = useTranslations('report.allocation.segments');

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t('heading')}</p>

      {bars.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {bars.map((bar) => (
            <li key={bar.segmentId} className="flex items-center gap-2 text-sm">
              <span className="text-foreground w-14 shrink-0 truncate">{bar.name}</span>
              <span className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded-full">
                <span
                  className="bg-foreground block h-full rounded-full"
                  style={{ width: `${bar.percent}%` }}
                />
              </span>
              <span className="text-foreground tabular-nums">
                {formatReportDuration(bar.minutes)}
              </span>
              <span className="text-muted-foreground w-10 text-right tabular-nums">
                {bar.percent}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 日別（週）／週別（月）／月別（年）のインク。カテゴリを下から積み上げる。 */
function InkColumns({
  columns,
  granularity,
  maxMinutes,
}: {
  columns: readonly ReportInkColumn[];
  granularity: ReportGranularity;
  maxMinutes: number;
}) {
  const t = useTranslations('report.allocation.ink');
  const weekdays = t.raw('weekdays') as string[];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t(`heading.${granularity}`)}</p>

      <ul className="flex items-end gap-2">
        {columns.map((column, index) => (
          <li key={column.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span
              className="flex w-full flex-col-reverse justify-start"
              style={{ height: INK_MAX_HEIGHT }}
            >
              {column.stacks.map((stack) => (
                <span
                  key={stack.key}
                  className="w-full"
                  style={{
                    height: `${(stack.minutes / maxMinutes) * INK_MAX_HEIGHT}px`,
                    backgroundColor: sliceColor(stack.color),
                  }}
                />
              ))}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {columnLabel({ column, granularity, index, weekdays, t })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
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
  t: ReturnType<typeof useTranslations<'report.allocation.ink'>>;
}): string {
  if (granularity === 'week') {
    // 列は週の開始曜日に従って並ぶので、曜日名は列の日付から引く（配列の index ではない）
    const weekdayIndex = (new Date(`${column.key}T00:00:00`).getDay() + 6) % 7;
    return weekdays[weekdayIndex] ?? column.key;
  }
  if (granularity === 'month') {
    return t('weekColumn', { index: index + 1 });
  }
  return t('monthColumn', { month: Number(column.key.slice(5)) });
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
