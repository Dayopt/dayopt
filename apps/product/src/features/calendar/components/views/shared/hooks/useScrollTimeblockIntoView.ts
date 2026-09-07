'use client';

import { useEffect, type RefObject } from 'react';

import { useTimeblockInspectorStore } from '@/features/timeblock';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';

import { useInlineCreateStore } from '../../../../stores/useInlineCreateStore';

interface UseScrollEntryIntoViewOptions {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  hourHeight: number;
}

function scrollToTopPx(container: HTMLDivElement, topPx: number) {
  const targetScroll = Math.max(0, topPx - container.clientHeight * 0.25);
  container.scrollTo({ top: targetScroll, behavior: 'smooth' });
}

/**
 * Mobile + Inspector / Tag draft open のとき、対象 entry / draft が Drawer の上に
 * visible になるよう scroll する。
 *
 * Mobile では Drawer が下半分を覆うため、選択された entry や作成中の選択範囲が隠れる。
 * 対象を viewport の上端から ~25% の位置に置く。
 *
 * PC では何もしない（Inspector は右ドッキングパネルで entry を覆わないため）。
 */
export function useScrollTimeblockIntoView({
  scrollContainerRef,
  hourHeight,
}: UseScrollEntryIntoViewOptions) {
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const inspectorEntryId = useTimeblockInspectorStore((s) => s.timeblockId);
  const inspectorIsOpen = useTimeblockInspectorStore((s) => s.isOpen);
  const pendingSelection = useInlineCreateStore.use.pendingSelection();

  // Inspector 開時: 該当 entry を viewport の 25% に置く
  useEffect(() => {
    if (!isMobile) return;
    if (!inspectorIsOpen || !inspectorEntryId) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const timer = setTimeout(() => {
      const timeblockEl = container.querySelector<HTMLElement>(
        `[data-entry-id="${inspectorEntryId}"]`,
      );
      if (!timeblockEl) return;
      const containerRect = container.getBoundingClientRect();
      const timeblockRect = timeblockEl.getBoundingClientRect();
      const timeblockTopInContainer = timeblockRect.top - containerRect.top + container.scrollTop;
      scrollToTopPx(container, timeblockTopInContainer);
    }, 220);

    return () => clearTimeout(timer);
  }, [isMobile, inspectorIsOpen, inspectorEntryId, scrollContainerRef]);

  // ドラッグ作成の選択範囲: 開始時刻を viewport の 25% に置く。
  // 日付が変わった時だけ再 scroll する（パネルの時刻入力やグリッドの resize で
  // startHour が動くたびに scroll し直すと操作を奪うため）
  const pendingDateKey = pendingSelection ? pendingSelection.date.toDateString() : null;

  useEffect(() => {
    if (!isMobile) return;
    if (!pendingSelection) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const startMinutes = pendingSelection.startHour * 60 + pendingSelection.startMinute;
    const timer = setTimeout(() => {
      scrollToTopPx(container, startMinutes * (hourHeight / 60));
    }, 220);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 時刻の変化では re-scroll しない（対象日の切替時のみ）
  }, [isMobile, pendingDateKey, hourHeight, scrollContainerRef]);
}
