'use client';

import { formatInTimeZone } from 'date-fns-tz';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useRef } from 'react';

import type { RefObject } from 'react';

import { getCategoryColorClasses } from '@/features/activities';
import { Button, Skeleton, cn } from '@dayopt/components';

import { formatReportDuration } from '../../domain/report/format-duration';
import {
  EXECUTION_MIN_PLAN_MINUTES,
  MIRROR_MIN_PLAN_BOXES,
  MIRROR_MIN_PLAN_MINUTES,
} from '../../domain/report/report-view-model';
import { resolveZonedDayKey } from '../../lib/report-period';
import { DurationStrip } from './DurationStrip';

import type { ReportGranularity } from '../../lib/report-period';
import type { ReportActivityDetailResult } from '../../server/report-detail-service';

export interface ReportDetailBodyProps {
  /** 表示中のアクティビティ名。`null` はアクティビティ未設定。 */
  name: string | null;
  categoryName: string | null;
  color: string | null;
  granularity: ReportGranularity;
  /**
   * ユーザーの timezone。**ブラウザのローカル時刻で描かない** — 設定が実機とずれている時に
   * 明細の時刻と曜日がカレンダーと食い違い、「カレンダーで見る」も別の日を開いてしまう。
   */
  timezone: string;
  detail: ReportActivityDetailResult | undefined;
  isPending: boolean;
  isError: boolean;
  onClose: () => void;
  /** 最初の箱の日をカレンダーで開く。`null` は明細が 0 件でボタンを出さない。 */
  onOpenCalendarDay: ((dayKey: string) => void) | null;
  /**
   * 週別の推移を出すか。**モバイルは出さない**（狭い面で 6 本の棒は読めない）。
   * 出さない時は取得側（`useReportActivityDetail`）も `includeTrend: false` にする。
   */
  showTrend: boolean;
}

/** 推移の棒の最大高さ（px）。 */
const TREND_MAX_HEIGHT = 38;
/** 推移を出す最小の「データのある期間」数。これ未満は節ごと出さない（仕様 §6-5）。 */
const TREND_MIN_PERIODS = 2;

/**
 * アクティビティ詳細の中身（仕様 §6）。
 *
 * **器を持たない。** デスクトップは shell の 4 カラム目へ portal する `ReportDetailPanel`、
 * モバイルはボトムシートの `ReportDetailSheet` が、この本文を同じ形で描く。
 * **どちらでも編集はしない**（充実の後付けは編集面の仕事）。「（記録中）」も作らない —
 * Dayopt の Record は常に `end_at <= now` で、記録中という状態が存在しない。
 */
export function ReportDetailBody({
  name,
  categoryName,
  color,
  granularity,
  timezone,
  detail,
  isPending,
  isError,
  onClose,
  onOpenCalendarDay,
  showTrend,
}: ReportDetailBodyProps) {
  const t = useTranslations('report.detail');

  return (
    <>
      <header className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1 size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor(color) }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium">{name ?? t('unassigned')}</p>
          <p className="text-muted-foreground truncate text-xs">
            {t(`subtitle.${granularity}`, { category: categoryName ?? t('uncategorized') })}
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
        <p className="text-muted-foreground text-xs">{t('error')}</p>
      ) : isPending || detail === undefined ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : (
        <DetailSections
          detail={detail}
          granularity={granularity}
          onOpenCalendarDay={onOpenCalendarDay}
          showTrend={showTrend}
          timezone={timezone}
        />
      )}
    </>
  );
}

function DetailSections({
  detail,
  granularity,
  onOpenCalendarDay,
  showTrend,
  timezone,
}: {
  detail: ReportActivityDetailResult;
  granularity: ReportGranularity;
  onOpenCalendarDay: ((dayKey: string) => void) | null;
  showTrend: boolean;
  timezone: string;
}) {
  const t = useTranslations('report.detail');
  const firstRecord = detail.records[0];
  const listRef = useRef<HTMLUListElement>(null);

  // ストリップの点は明細の行へ着地する（仕様 §0「数字は必ず明細に落ちる」）。
  // パネルは 1 本のスクロール面なので、行までスクロールしてフォーカスを移すだけでよい
  const handleSelectRecord = useCallback((recordId: string) => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-record-id="${CSS.escape(recordId)}"]`,
    );
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: 'nearest' });
    row.focus({ preventScroll: true });
  }, []);

  return (
    <>
      <StatGrid detail={detail} />
      <MirrorLine detail={detail} />
      <DurationStrip
        distribution={detail.durationDistribution}
        medianPlanBoxMinutes={detail.medianPlanBoxMinutes}
        onSelectRecord={handleSelectRecord}
        records={detail.records}
      />
      <TimeOfDayBars values={detail.timeOfDay} />
      {showTrend && <TrendBars granularity={granularity} trend={detail.trend} />}
      <RecordList listRef={listRef} records={detail.records} timezone={timezone} />

      {onOpenCalendarDay !== null && firstRecord !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 self-start"
          // ISO の先頭 10 文字は UTC の日付。深夜の記録で 1 日ずれるので timezone で切る
          onClick={() => onOpenCalendarDay(resolveZonedDayKey(firstRecord.startAt, timezone))}
        >
          {t('openCalendar')}
        </Button>
      )}
    </>
  );
}

/** 統計 4 枚（2×2）。仕様 §6-2。 */
function StatGrid({ detail }: { detail: ReportActivityDetailResult }) {
  const t = useTranslations('report.detail.stats');
  const answers = detail.fulfillment.low + detail.fulfillment.medium + detail.fulfillment.high;

  return (
    <ul data-report-stats="detail" className="grid grid-cols-2 gap-2">
      <StatCard label={t('recorded')} value={formatReportDuration(detail.recordedMinutes)} />
      <StatCard label={t('plan')} value={planValue(detail, t)} />
      <StatCard
        label={t('median')}
        value={
          detail.medianBoxMinutes === null
            ? t('none')
            : formatReportDuration(detail.medianBoxMinutes)
        }
      />
      <StatCard
        label={t('fulfillment')}
        sub={answers > 0 ? t('answerCount', { count: answers }) : undefined}
        value={answers === 0 ? t('unanswered') : fulfillmentValue(detail.fulfillment, t)}
      />
    </ul>
  );
}

function StatCard({
  label,
  sub,
  value,
}: {
  label: string;
  sub?: string | undefined;
  value: string;
}) {
  return (
    <li className="border-border-subtle bg-card flex flex-col gap-1 rounded-lg border p-2 shadow-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground text-sm tabular-nums">{value}</span>
      {sub !== undefined && <span className="text-muted-foreground text-xs">{sub}</span>}
    </li>
  );
}

function planValue(
  detail: ReportActivityDetailResult,
  t: ReturnType<typeof useTranslations<'report.detail.stats'>>,
): string {
  // 閾値は 2 章と同じものを domain から読む（値を複製すると、片方だけ変えた時に
  // 「章では予定比が出るのにパネルでは出ない」が起きる）
  if (detail.plannedPastMinutes >= EXECUTION_MIN_PLAN_MINUTES) {
    return t('planRatio', {
      percent: Math.round((detail.recordedMinutes / detail.plannedPastMinutes) * 100),
    });
  }
  // 予定はあるが、まだ来ていない（= 過去予定が閾値未満）。率ではなく状態を出す
  if (detail.plannedMinutes > 0) return t('planPending');
  return t('planNone');
}

function fulfillmentValue(
  fulfillment: ReportActivityDetailResult['fulfillment'],
  t: ReturnType<typeof useTranslations<'report.detail.stats'>>,
): string {
  // 0 の値は省く（「充 3 普 0 消 0」より「充 3」の方が読みやすい）
  return (['high', 'medium', 'low'] as const)
    .filter((level) => fulfillment[level] > 0)
    .map((level) => t(`fulfillmentLevel.${level}`, { count: fulfillment[level] }))
    .join(' ');
}

/** 見積もりの鏡（1 行）。候補条件を満たさなければ、傾向を出せないことだけ言う。 */
function MirrorLine({ detail }: { detail: ReportActivityDetailResult }) {
  const t = useTranslations('report.detail');
  // 候補条件も 2 章の見積もりの鏡と同じ（domain の定数を読む）
  const eligible =
    detail.plannedPastMinutes >= MIRROR_MIN_PLAN_MINUTES &&
    detail.recordedMinutes > 0 &&
    detail.plannedPastBoxes >= MIRROR_MIN_PLAN_BOXES;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">{t('mirror.heading')}</p>
      <p className="text-foreground text-xs">
        {eligible
          ? t('mirror.coefficient', {
              coefficient: (detail.recordedMinutes / detail.plannedPastMinutes).toFixed(2),
            })
          : t('mirror.notEnough')}
      </p>
    </div>
  );
}

/** 時間帯の分布（6 本）。最大バケットを基準に比例させる。 */
function TimeOfDayBars({ values }: { values: readonly number[] }) {
  const t = useTranslations('report.detail.timeOfDay');
  const labels = t.raw('labels') as string[];
  const max = Math.max(1, ...values);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t('heading')}</p>
      <ul data-report-bars="time-of-day" className="flex flex-col gap-2">
        {values.map((minutes, index) => (
          <li key={labels[index] ?? index} className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">{labels[index]}</span>
            <span className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded-full">
              <span
                className="bg-foreground block h-full rounded-full"
                style={{ width: `${(minutes / max) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 直近 6 期間の推移。**データのある期間が 2 未満なら節ごと出さない**（仕様 §6-5）。
 *
 * 棒は合計、重ねた線は 1 件あたりの中央値。合計だけでは「回数が増えたのか、1 回が長く
 * なったのか」が分からない。2 つの軸を持つので、線は棒とは別に自分の最大値で正規化する。
 */
function TrendBars({
  granularity,
  trend,
}: {
  granularity: ReportGranularity;
  trend: ReportActivityDetailResult['trend'];
}) {
  const t = useTranslations('report.detail');
  const withData = trend.filter((point) => point.recordedMinutes > 0);
  if (withData.length < TREND_MIN_PERIODS) return null;

  const max = Math.max(1, ...trend.map((point) => point.recordedMinutes));
  const medians = trend.map((point) => point.medianBoxMinutes);
  const medianMax = Math.max(1, ...medians.filter((value) => value !== null));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t(`trend.heading.${granularity}`)}</p>
      <div className="relative" style={{ height: `${TREND_MAX_HEIGHT}px` }}>
        <ul data-report-bars="trend" className="flex h-full items-end gap-2">
          {trend.map((point) => (
            <li key={point.key} className="flex min-w-0 flex-1 flex-col items-center justify-end">
              <span
                className="bg-foreground w-full rounded-lg"
                style={{
                  height: `${(point.recordedMinutes / max) * TREND_MAX_HEIGHT}px`,
                  opacity: point.recordedMinutes > 0 ? 1 : 0.25,
                }}
              />
            </li>
          ))}
        </ul>
        <TrendMedianLine medians={medians} medianMax={medianMax} />
      </div>
      <p className="text-muted-foreground text-xs">{t('trend.legend')}</p>
    </div>
  );
}

/**
 * 推移に重ねる中央値の折れ線。
 *
 * div では斜線が引けないので、線だけ inline SVG を使う（chart library は入れない）。
 * `preserveAspectRatio="none"` で棒の並びへ引き伸ばすため、線の太さは
 * `vector-effect="non-scaling-stroke"` で保つ。**点は SVG に置かない** — 同じ引き伸ばしで
 * 円が横長の楕円に潰れるため、位置だけ % で持つ div にする。
 *
 * **中央値の無い期間で線を切る**（0 として谷を描くと「短くなった」と読めてしまう）。
 * x は棒の中心（`(i + 0.5) / n`）に合わせる。端に寄せると線が棒からはみ出す。
 */
function TrendMedianLine({
  medians,
  medianMax,
}: {
  medians: (number | null)[];
  medianMax: number;
}) {
  const t = useTranslations('report.detail');
  const points = medians.map((value, index) => {
    const x = ((index + 0.5) / medians.length) * 100;
    if (value === null) return null;
    return { x, y: TREND_MAX_HEIGHT - (value / medianMax) * TREND_MAX_HEIGHT, value };
  });

  // 連続している区間ごとに折れ線を分ける
  const segments: { x: number; y: number }[][] = [];
  for (const point of points) {
    if (point === null) {
      segments.push([]);
      continue;
    }
    const last = segments[segments.length - 1];
    if (last === undefined) segments.push([point]);
    else last.push(point);
  }

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <svg
        className="text-foreground h-full w-full"
        data-report-line="trend-median"
        preserveAspectRatio="none"
        viewBox={`0 0 100 ${TREND_MAX_HEIGHT}`}
      >
        {segments
          .filter((segment) => segment.length >= 2)
          .map((segment) => (
            <polyline
              key={`${segment[0]?.x}-${segment.length}`}
              fill="none"
              points={segment.map((point) => `${point.x},${point.y}`).join(' ')}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>
      {points.map((point, index) =>
        point === null ? null : (
          <span
            key={medians[index] === null ? index : `${index}-${point.value}`}
            data-report-point="trend-median"
            className="bg-foreground ring-background absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{ left: `${point.x}%`, top: `${(point.y / TREND_MAX_HEIGHT) * 100}%` }}
            title={t('trend.median', { duration: formatReportDuration(point.value) })}
          />
        ),
      )}
    </div>
  );
}

/** 記録の明細。曜日 1 字 / 開始–終了 / 長さ / 充実チップ。 */
function RecordList({
  listRef,
  records,
  timezone,
}: {
  /** ストリップの点から行を引くための参照。 */
  listRef: RefObject<HTMLUListElement | null>;
  records: ReportActivityDetailResult['records'];
  timezone: string;
}) {
  const t = useTranslations('report.detail.records');
  const weekdays = t.raw('weekdays') as string[];

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t('heading', { count: records.length })}</p>

      {records.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <ul ref={listRef} data-report-list="records" className="flex flex-col gap-1">
          {records.map((record) => (
            <li
              key={record.id}
              data-record-id={record.id}
              // ストリップの点から着地した時にフォーカスを受ける（Tab 順には入れない）
              tabIndex={-1}
              className="focus-visible:outline-ring flex items-center gap-2 rounded-lg text-xs focus-visible:outline-2"
            >
              <span className="text-muted-foreground w-4 shrink-0">
                {weekdays[zonedWeekdayIndex(record.startAt, timezone)]}
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate">
                {formatClock(record.startAt, timezone)}–{formatClock(record.endAt, timezone)}
              </span>
              <span className="text-foreground shrink-0 tabular-nums">
                {formatReportDuration(record.minutes)}
              </span>
              {/* 充実の 3 値に色を付けない（仕様 §10）。チップは単色 */}
              <span
                className={cn(
                  'bg-muted text-muted-foreground shrink-0 rounded-lg px-1',
                  record.fulfillment === null && 'opacity-60',
                )}
              >
                {record.fulfillment === null
                  ? t('unanswered')
                  : t(`fulfillment.${record.fulfillment}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `HH:mm`（ユーザーの timezone）。 */
function formatClock(isoString: string, timezone: string): string {
  return formatInTimeZone(new Date(isoString), timezone, 'HH:mm');
}

/** 曜日（0=日）。`weekdays` 配列の index に使う。 */
function zonedWeekdayIndex(isoString: string, timezone: string): number {
  return Number(formatInTimeZone(new Date(isoString), timezone, 'i')) % 7;
}

function dotColor(color: string | null): string {
  if (color === null) return 'var(--muted-foreground)';
  return getCategoryColorClasses(color).cssVar;
}
