'use client';

import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';

import { useDomSlot } from '@/lib/dom-slots/useDomSlot';

import { REPORT_DETAIL_SLOT_KEY } from '../../lib/report-detail-slot';
import { ReportDetailBody } from './ReportDetailBody';
import { ReportDetailResizeHandle } from './ReportDetailResizeHandle';

import type { ReportDetailBodyProps } from './ReportDetailBody';

type ReportDetailPanelProps = Omit<ReportDetailBodyProps, 'showTrend'>;

/**
 * アクティビティ詳細パネル（デスクトップの器）。
 *
 * shell（`desktop-layout.tsx`）が用意した 4 カラム目へ portal する。中身は
 * `ReportDetailBody` が持ち、モバイルのボトムシート（`ReportDetailSheet`）と共有する。
 *
 * timeblock inspector と同時に開くことは無い（inspector はカレンダー、これはレポートに属し、
 * 別ページなので共存しない）。DOM 上は両方の器が常にあるが、開くのは高々どちらか一方。
 */
export function ReportDetailPanel(props: ReportDetailPanelProps) {
  const t = useTranslations('report.detail');
  const slot = useDomSlot(REPORT_DETAIL_SLOT_KEY);

  if (slot === null) return null;

  return createPortal(
    // splitter はスクロール面の外に置く（中に入れると `inset-y-0` がスクロール量に引きずられる）
    <div className="relative h-full">
      <ReportDetailResizeHandle />
      <section
        aria-label={t('ariaLabel')}
        data-report-panel="detail"
        className="flex h-full flex-col gap-4 overflow-y-auto p-4"
      >
        {/* デスクトップは幅に余裕があるので推移を出す */}
        <ReportDetailBody {...props} showTrend />
      </section>
    </div>,
    slot,
  );
}
