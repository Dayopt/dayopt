'use client';

import { useTranslations } from 'next-intl';

import { COMPASS_MIN_FULFILLMENT } from '../../../domain/report/report-view-model';
import { CompassScatter } from './CompassScatter';
import { WaitingList } from './WaitingList';

import type {
  ReportCompassPoint,
  ReportWaitingActivity,
} from '../../../domain/report/report-view-model';
import type { ReportDetailTarget } from '../../../stores/useReportDetailStore';

interface QualityChapterProps {
  points: readonly ReportCompassPoint[];
  waitingActivities: readonly ReportWaitingActivity[];
  onSelectActivity?: ((target: ReportDetailTarget) => void) | undefined;
}

/**
 * 3 章「質 — それは良い配分だったか」。
 *
 * 充実の 3 値に色を付けず、平均も出さない（仕様 §0-4 / §10）。回答が閾値に届かない
 * アクティビティは点にせず、名前だけを待機リストへ回す（分布と n で語る）。
 */
export function QualityChapter({
  points,
  waitingActivities,
  onSelectActivity,
}: QualityChapterProps) {
  const t = useTranslations('report.quality');

  return (
    <section
      aria-label={t('kick')}
      data-report-chapter="quality"
      className="border-border-subtle flex flex-col gap-4 border-b pb-8 last:border-b-0"
    >
      <h2 className="text-foreground text-sm font-medium">{t('kick')}</h2>

      <CompassScatter onSelectActivity={onSelectActivity} points={points} />

      {points.length > 0 && (
        <div className="flex flex-col gap-1">
          <WaitingList activities={waitingActivities} />
          {/* 濃度の意味と点が生まれる回数は常に添える（読み手が濃さを推測しないで済むように） */}
          <p className="text-muted-foreground text-xs">
            {t('footnote', { threshold: COMPASS_MIN_FULFILLMENT })}
          </p>
        </div>
      )}
    </section>
  );
}
