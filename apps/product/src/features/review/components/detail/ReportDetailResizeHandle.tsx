'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

import {
  clampReportDetailPanelWidth,
  REPORT_DETAIL_PANEL_MAX_WIDTH,
  REPORT_DETAIL_PANEL_MIN_WIDTH,
  REPORT_DETAIL_PANEL_RESIZE_STEP,
} from '../../lib/report-detail-slot';
import { useReportDetailStore } from '../../stores/useReportDetailStore';

import type { KeyboardEvent, PointerEvent } from 'react';

/**
 * 詳細パネルの左端をドラッグして幅を変える splitter。
 *
 * カレンダーのサイドレール（`CalendarLayout`）と同じ WAI-ARIA window splitter パターン。
 * pointer capture ではなく window listener を使うのも同じ理由で、ポインタがパネルの外へ
 * 出てもドラッグが続く。
 *
 * **ドラッグ中は shell の幅トランジションを切る**（`isResizing`）。200ms の補間が入ると
 * 指の位置とパネルの端がずれて、掴んでいる感触が消える。
 */
export function ReportDetailResizeHandle() {
  const t = useTranslations('report.detail');
  const width = useReportDetailStore((state) => state.width);
  const setWidth = useReportDetailStore((state) => state.setWidth);
  const setResizing = useReportDetailStore((state) => state.setResizing);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = width;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      setResizing(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      // パネルは右端にあるので、左へ動かすほど広がる
      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        setWidth(startWidth - (moveEvent.clientX - startX));
      };
      const handlePointerUp = () => {
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
    },
    [setResizing, setWidth, width],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setWidth(width + REPORT_DETAIL_PANEL_RESIZE_STEP);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setWidth(width - REPORT_DETAIL_PANEL_RESIZE_STEP);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setWidth(REPORT_DETAIL_PANEL_MIN_WIDTH);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setWidth(REPORT_DETAIL_PANEL_MAX_WIDTH);
      }
    },
    [setWidth, width],
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA の window splitter パターン。フォーカス可能な separator に aria-valuenow と onKeyDown を持たせるのが規定の形で、ルールが separator を一律に非 interactive として扱うための誤検出
    <div
      role="separator"
      aria-label={t('resize')}
      aria-orientation="vertical"
      aria-valuemin={REPORT_DETAIL_PANEL_MIN_WIDTH}
      aria-valuemax={REPORT_DETAIL_PANEL_MAX_WIDTH}
      aria-valuenow={clampReportDetailPanelWidth(width)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 同上。splitter は Tab で到達できる必要がある
      tabIndex={0}
      className="hover:bg-state-hover focus-visible:outline-ring absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize touch-none transition-colors duration-150 focus-visible:outline-2"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
