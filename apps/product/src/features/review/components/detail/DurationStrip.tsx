'use client';

import { useTranslations } from 'next-intl';

import {
  isMedianEligibleSource,
  resolveDurationAxis,
  toAxisPercent,
} from '../../domain/report/duration-distribution';
import { formatReportDuration } from '../../domain/report/format-duration';

import type { ReportActivityDetailResult } from '../../server/report-detail-service';

interface DurationStripProps {
  /** 代表値と件数。**server が全件から出す**（明細は 200 件で切られる）。`null` は沈黙。 */
  distribution: ReportActivityDetailResult['durationDistribution'];
  records: ReportActivityDetailResult['records'];
  /** 開始済みの予定 1 件あたりの中央値。`null` なら ▲ を出さない。 */
  medianPlanBoxMinutes: number | null;
  /** 点を押した時。明細の該当行へ着地させる（仕様 §0「数字は必ず明細に落ちる」）。 */
  onSelectRecord: (recordId: string) => void;
}

/**
 * 1 件あたりの長さの分布（詳細パネル）。
 *
 * 中央値の数字 1 つでは「その代表値がどれくらい信用できるか」が読めない。点・25–75% の帯・
 * 中央値の線・予定の中央値（▲）を 1 本の軸へ重ねて、ばらつきと予定とのずれを同時に出す。
 *
 * **代表値と n は server の `distribution` をそのまま出す**（自前で計算し直さない）。明細は
 * 200 件で切られるので、client で数え直すと多い期間で「カードの中央値」と「ストリップの
 * 中央値」が食い違う。明細の集合に従うのは点だけ。
 *
 * **`auto_migrated` の記録は点にしない**（代表値と同じ母集団）。明細のリストには残る。
 *
 * **色で良し悪しを言わない**（仕様 §9）。単色で、長い / 短いに意味を付けない。
 */
export function DurationStrip({
  distribution,
  records,
  medianPlanBoxMinutes,
  onSelectRecord,
}: DurationStripProps) {
  const t = useTranslations('report.detail.strip');

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
  const marks = groupByDuration(records);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        {t('heading')}
        <span className="tabular-nums">{t('count', { count: distribution.n })}</span>
      </p>

      <div data-report-strip="duration" className="relative h-10">
        {/* 25–75% の帯 */}
        <span
          aria-hidden
          className="bg-muted absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{
            left: percent(distribution.q1),
            width: `${toAxisPercent(distribution.q3, axis) - toAxisPercent(distribution.q1, axis)}%`,
          }}
        />
        {/* 中央値 */}
        <span
          aria-hidden
          className="bg-foreground absolute inset-y-1 w-px"
          style={{ left: percent(distribution.median) }}
        />

        {marks.map((mark) => (
          <button
            key={mark.minutes}
            type="button"
            // 44px のヒット領域。見た目の点は 8px で、帯の上に重なる
            className="focus-visible:outline-ring absolute top-1/2 flex h-11 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center focus-visible:outline-2"
            style={{ left: percent(mark.minutes) }}
            onClick={() => onSelectRecord(mark.firstRecordId)}
          >
            <span
              aria-hidden
              className="bg-foreground size-2 rounded-full opacity-60 transition-opacity hover:opacity-100"
            />
            <span className="sr-only">
              {t('dotAriaLabel', {
                duration: formatReportDuration(mark.minutes),
                count: mark.count,
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

interface DurationMark {
  minutes: number;
  count: number;
  /** 同じ長さのうち最初（最も古い）の記録。押した時の着地先。 */
  firstRecordId: string;
}

/**
 * 同じ長さの記録を 1 つの点へまとめる。
 *
 * 長さが同じ点は座標も同じなので、1 記録 = 1 ボタンにすると 44px のヒット領域が完全に
 * 重なり、ポインタでは最後に描いた 1 件しか押せない（「25 分」を繰り返す使い方で必ず起きる）。
 * 点が重なって見えるのは構わないが、押した先が嘘になるのは困るので、まとめて件数で語る。
 */
function groupByDuration(records: ReportActivityDetailResult['records']): DurationMark[] {
  const byMinutes = new Map<number, DurationMark>();

  for (const record of records) {
    if (!isMedianEligibleSource(record.source)) continue;
    const existing = byMinutes.get(record.minutes);
    if (existing === undefined) {
      byMinutes.set(record.minutes, {
        minutes: record.minutes,
        count: 1,
        firstRecordId: record.id,
      });
      continue;
    }
    existing.count += 1;
  }

  return [...byMinutes.values()];
}
