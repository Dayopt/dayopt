'use client';

import { useTranslations } from 'next-intl';

import { getCategoryColorClasses } from '@/features/activities';
import { cn } from '@dayopt/components';

import { COMPASS_MIN_FULFILLMENT } from '../../../domain/report/report-view-model';

import { formatReportDuration } from '../../../domain/report/format-duration';

import type { ReportCompassPoint } from '../../../domain/report/report-view-model';
import type { ReportDetailTarget } from '../../../stores/useReportDetailStore';

interface CompassScatterProps {
  /** 座標・濃度は domain が計算済み。component 側で再計算しない。 */
  points: readonly ReportCompassPoint[];
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
}

/** 盤の高さ（px）。仕様 §4.3。 */
const BOARD_HEIGHT = 150;
/** 点の直径（px）。 */
const POINT_DIAMETER = 13;
/** ラベルを左寄せへ倒す x（%）。右端の点のラベルが盤からはみ出すのを避ける（仕様 §13-14）。 */
const LABEL_FLIP_X = 70;

/**
 * 羅針盤（仕様 §4.3）。
 *
 * 左下原点の散布図。**目盛りも数値も出さない**（位置関係だけを読む盤で、
 * 測る道具ではない）。**平均・回帰線・象限の塗り分け・ランキングは作らない**（仕様 §12）。
 */
export function CompassScatter({ points, onSelectActivity }: CompassScatterProps) {
  const t = useTranslations('report.quality');

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t('emptyBoard', { threshold: COMPASS_MIN_FULFILLMENT })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-stretch gap-2 overflow-x-clip">
        {/* 縦軸は言葉だけ。上が充実、下が消耗 */}
        <div className="text-muted-foreground flex flex-col justify-between text-xs">
          <span>{t('axis.fulfilled')}</span>
          <span>{t('axis.drained')}</span>
        </div>

        <div
          className="border-border-subtle relative min-w-0 flex-1 border-b border-l"
          data-report-board="compass"
          style={{ height: BOARD_HEIGHT }}
        >
          <p className="text-muted-foreground absolute top-0 left-0 w-1/2 text-xs opacity-70">
            {t('hint.lowButFulfilled')}
          </p>
          <p className="text-muted-foreground absolute right-0 bottom-0 w-1/2 text-right text-xs opacity-70">
            {t('hint.heavyButDrained')}
          </p>
          {points.map((point) => (
            <CompassPoint
              key={point.activityId ?? '__unassigned'}
              onSelectActivity={onSelectActivity}
              point={point}
            />
          ))}
        </div>
      </div>

      <p className="text-muted-foreground text-right text-xs">{t('axis.time')}</p>
    </div>
  );
}

function CompassPoint({
  onSelectActivity,
  point,
}: {
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
  point: ReportCompassPoint;
}) {
  const t = useTranslations('report.quality');
  const name = point.name ?? t('unnamed');
  const flipped = point.x > LABEL_FLIP_X;

  return (
    <button
      type="button"
      // 詳細パネルを開く（本体は Composition Bridge が描く。#2581）
      onClick={() =>
        onSelectActivity?.({
          activityId: point.activityId,
          name: point.name,
          categoryName: point.categoryName,
          color: point.color,
        })
      }
      aria-label={t('pointAriaLabel', {
        name,
        recorded: formatReportDuration(point.recordedMinutes),
      })}
      // 点は 13px でも、触れる面は 44px 角を確保する（点の中心に重ねる）
      className="absolute flex min-h-11 min-w-11 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full"
      style={{ bottom: `${point.y}%`, left: `${point.x}%` }}
    >
      <span
        aria-hidden
        className="rounded-full"
        style={{
          backgroundColor: pointColor(point.color),
          height: POINT_DIAMETER,
          opacity: point.opacity,
          width: POINT_DIAMETER,
        }}
      />
      <span
        aria-hidden
        className={cn(
          'text-muted-foreground absolute top-1/2 max-w-24 truncate text-xs',
          flipped ? 'right-1/2 text-right' : 'left-1/2',
        )}
      >
        {name}
      </span>
    </button>
  );
}

function pointColor(color: string | null): string {
  if (color === null) return 'var(--muted-foreground)';
  return getCategoryColorClasses(color).cssVar;
}
