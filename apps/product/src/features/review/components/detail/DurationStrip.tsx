'use client';

import { formatInTimeZone } from 'date-fns-tz';
import { useTranslations } from 'next-intl';

import {
  isMedianEligibleSource,
  resolveDurationAxis,
  summarizeDurationDistribution,
  toAxisPercent,
} from '../../domain/report/duration-distribution';
import { formatReportDuration } from '../../domain/report/format-duration';

import type { ReportActivityDetailResult } from '../../server/report-detail-service';

interface DurationStripProps {
  records: ReportActivityDetailResult['records'];
  /** 開始済みの予定 1 件あたりの中央値。`null` なら ▲ を出さない。 */
  medianPlanBoxMinutes: number | null;
  /** ユーザーの timezone。点の読み上げに開始時刻を載せるのに使う。 */
  timezone: string;
  /** 点を押した時。明細の該当行へ着地させる（仕様 §0「数字は必ず明細に落ちる」）。 */
  onSelectRecord: (recordId: string) => void;
}

/** ストリップの高さ（px）。点のヒット領域は 44px で、この帯からはみ出して重なる。 */
const STRIP_HEIGHT_CLASS = 'h-10';

/**
 * 1 件あたりの長さの分布（詳細パネル）。
 *
 * 中央値の数字 1 つでは「その代表値がどれくらい信用できるか」が読めない。点・25–75% の帯・
 * 中央値の線・予定の中央値（▲）を 1 本の軸へ重ねて、ばらつきと予定とのずれを同時に出す。
 *
 * **`auto_migrated` の記録は点にしない**（中央値カードと同じ母集団。`duration-distribution`）。
 * 明細のリストには残る（実際にその時間は埋まっていた）。
 *
 * **色で良し悪しを言わない**（仕様 §9）。単色で、長い / 短いに意味を付けない。
 */
export function DurationStrip({
  records,
  medianPlanBoxMinutes,
  timezone,
  onSelectRecord,
}: DurationStripProps) {
  const t = useTranslations('report.detail.strip');

  // 明細は 200 件で切られている（`REPORT_DETAIL_RECORD_LIMIT`）。それを超える期間では、
  // 点の n とカードの中央値（全件から算出）の母集団がずれる。閲覧の目安としては十分で、
  // 点を全件描いても読めないので、ここは明細と同じ集合をそのまま使う。
  const eligible = records.filter((record) => isMedianEligibleSource(record.source));
  const distribution = summarizeDurationDistribution(eligible.map((record) => record.minutes));

  if (distribution === null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">{t('heading')}</p>
        <p className="text-foreground text-xs">{t('notEnough')}</p>
      </div>
    );
  }

  const axis = resolveDurationAxis(distribution, medianPlanBoxMinutes);
  const percent = (value: number) => `${toAxisPercent(value, axis)}%`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        {t('heading')}
        <span className="tabular-nums">{t('count', { count: distribution.n })}</span>
      </p>

      <div data-report-strip="duration" className={`relative ${STRIP_HEIGHT_CLASS}`}>
        {/* 25–75% の帯 */}
        <span
          aria-hidden
          className="bg-muted absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{ left: percent(distribution.q1), width: `${widthPercent(distribution, axis)}%` }}
        />
        {/* 中央値 */}
        <span
          aria-hidden
          className="bg-foreground absolute inset-y-1 w-px"
          style={{ left: percent(distribution.median) }}
        />

        {eligible.map((record) => (
          <button
            key={record.id}
            type="button"
            // 44px のヒット領域。見た目の点は 8px で、帯の上に重なる
            className="focus-visible:outline-ring absolute top-1/2 flex h-11 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center focus-visible:outline-2"
            style={{ left: percent(record.minutes) }}
            onClick={() => onSelectRecord(record.id)}
          >
            <span
              aria-hidden
              className="bg-foreground size-2 rounded-full opacity-60 transition-opacity hover:opacity-100"
            />
            <span className="sr-only">
              {t('dotAriaLabel', {
                start: formatInTimeZone(new Date(record.startAt), timezone, 'M/d HH:mm'),
                duration: formatReportDuration(record.minutes),
              })}
            </span>
          </button>
        ))}

        {/* 予定の中央値。記録の外側にあれば軸ごと広がっているので、位置は嘘をつかない */}
        {medianPlanBoxMinutes !== null && (
          <span
            className="text-foreground absolute bottom-0 -translate-x-1/2 text-xs leading-none"
            style={{ left: percent(medianPlanBoxMinutes) }}
          >
            <span aria-hidden>▲</span>
            <span className="sr-only">
              {t('planMedian', { duration: formatReportDuration(medianPlanBoxMinutes) })}
            </span>
          </span>
        )}
      </div>

      <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
        <span>{formatReportDuration(axis.min)}</span>
        <span className="text-foreground">
          {t('median', { duration: formatReportDuration(distribution.median) })}
        </span>
        <span>{formatReportDuration(axis.max)}</span>
      </div>

      <p className="text-muted-foreground text-xs">
        {t('iqr', {
          low: formatReportDuration(distribution.q1),
          high: formatReportDuration(distribution.q3),
        })}
      </p>
    </div>
  );
}

/** 帯（25–75%）の幅（%）。軸が幅ゼロなら 0 になる。 */
function widthPercent(
  distribution: { q1: number; q3: number },
  axis: { min: number; max: number },
): number {
  return toAxisPercent(distribution.q3, axis) - toAxisPercent(distribution.q1, axis);
}
