'use client';

/**
 * Time Model Inspector（Level 1）
 *
 * plans / records を対象にした Inspector シェル:
 * - store 読み取り（timeblockId + timeblockKind）、kind 別 getById、loading/empty 分岐
 * - レスポンシブ分岐（mobile=Drawer / PC=DockedInspectorPanel）
 * - keyboard ショートカット、URL同期
 *
 * 旧 TimeblockInspector（entries 用）の置き換え。旧実装は Step 9 で削除する。
 */

import { Suspense, useCallback, useEffect, useRef } from 'react';

import { useTranslations } from 'next-intl';

import { ErrorState } from '@/components/ui/feedback/ErrorState';
import { useActivitiesMap } from '@/features/activities';
import { MEDIA_QUERIES } from '@/lib/breakpoints';
import { useDomSlot } from '@/lib/dom-slots/useDomSlot';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { overlappingRecords, type DerivedBlock } from '@/lib/time';
import { api } from '@/lib/trpc';
import { Drawer, DrawerContent, DrawerTitle, Spinner } from '@dayopt/components';

import type { TimeblockDestination } from '../../domain/timeblock-destination';
import { useInspectorURLSync } from '../../hooks/useInspectorURLSync';
import { TIMEBLOCK_INSPECTOR_SLOT_KEY } from '../../lib/inspector-slot';
import type { ClipboardTimeblock } from '../../lib/timeblock-clipboard';
import { useTimeblockInspectorStore } from '../../stores/useTimeblockInspectorStore';
import { DockedInspectorPanel } from '../inspector/DockedInspectorPanel';
import { useInspectorKeyboard } from '../inspector/hooks';
import { TimeblockInspectorForm, type TimeblockRelationships } from './TimeblockInspectorForm';

/** URL同期（useSearchParams は Suspense が必要なため分離） */
function InspectorURLSyncHandler() {
  useInspectorURLSync();
  return null;
}

interface TimeModelInspectorProps {
  /** 振り返り panel を開くコールバック（Composition Layer から注入） */
  onViewStats?: ((tagId: string) => void) | undefined;
  /** Timeblockを独立複製用のクリップボードへ保存する。 */
  onCopy?: ((timeblock: ClipboardTimeblock) => void) | undefined;
  /**
   * ドラッグ作成モード（store.createMode）で描く内容。calendar 側が組み立てて
   * Composition Layer から注入する（timeblock は calendar を import できないため）。
   */
  createContent?: React.ReactNode | undefined;
}

const INSPECTOR_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function toInspectorDerivedBlock(
  row: {
    id: string;
    activity_id: string | null;
    start_at: string;
    end_at: string;
    note?: string | null;
    fulfillment?: string | null;
    source?: string;
  },
  kind: 'plan' | 'rec',
): DerivedBlock {
  const fulfillment = row.fulfillment;
  return {
    id: row.id,
    kind,
    activityId: row.activity_id,
    start: row.start_at,
    end: row.end_at,
    memo: row.note ?? null,
    fulfillment:
      fulfillment === 'low' || fulfillment === 'medium' || fulfillment === 'high'
        ? fulfillment
        : null,
    live: false,
    source: row.source ?? 'manual',
  };
}

/** plans / records 対応 Inspector のトップレベル（モバイル=Drawer / PC=DockedInspectorPanel） */
export function TimeblockInspector({
  onViewStats,
  onCopy,
  createContent,
}: TimeModelInspectorProps) {
  const t = useTranslations();
  const isMobile = useMediaQuery(MEDIA_QUERIES.mobile);
  const { getActivityById } = useActivitiesMap();

  const isOpen = useTimeblockInspectorStore((state) => state.isOpen);
  const timeblockId = useTimeblockInspectorStore((state) => state.timeblockId);
  const timeblockKind = useTimeblockInspectorStore((state) => state.timeblockKind);
  const duplicateDraft = useTimeblockInspectorStore((state) => state.duplicateDraft);
  const createMode = useTimeblockInspectorStore((state) => state.createMode);
  const inspectorSlotElement = useDomSlot(TIMEBLOCK_INSPECTOR_SLOT_KEY);
  const openInspector = useTimeblockInspectorStore((state) => state.openInspector);
  const openDuplicate = useTimeblockInspectorStore((state) => state.openDuplicate);
  const cancelDuplicate = useTimeblockInspectorStore((state) => state.cancelDuplicate);
  const closeInspector = useTimeblockInspectorStore((state) => state.closeInspector);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFocusRelationshipRef = useRef(false);

  const planQuery = api.plans.getById.useQuery(
    { id: timeblockId ?? '' },
    { enabled: isOpen && !duplicateDraft && !!timeblockId && timeblockKind === 'plan' },
  );
  const recordQuery = api.records.getById.useQuery(
    { id: timeblockId ?? '' },
    { enabled: isOpen && !duplicateDraft && !!timeblockId && timeblockKind === 'record' },
  );
  const relatedRecordsQuery = api.records.list.useQuery(
    {
      startDate: planQuery.data?.start_at,
      endDate: planQuery.data?.end_at,
      sortBy: 'start_at',
      sortOrder: 'asc',
    },
    { enabled: isOpen && !duplicateDraft && !!planQuery.data && timeblockKind === 'plan' },
  );

  const activeQuery = timeblockKind === 'plan' ? planQuery : recordQuery;
  const plan = timeblockKind === 'plan' ? planQuery.data : undefined;
  const record = timeblockKind === 'record' ? recordQuery.data : undefined;
  const target = plan ?? record;

  const handleOpenRelationship = useCallback(
    (id: string, kind: TimeblockDestination) => {
      shouldFocusRelationshipRef.current = true;
      openInspector(id, kind);
    },
    [openInspector],
  );

  const handleClose = useCallback(() => {
    shouldFocusRelationshipRef.current = false;
    closeInspector();
  }, [closeInspector]);

  const handleCancelDuplicate = useCallback(() => {
    shouldFocusRelationshipRef.current = true;
    cancelDuplicate();
  }, [cancelDuplicate]);

  useEffect(() => {
    if (!isOpen || activeQuery.isLoading || !shouldFocusRelationshipRef.current) return;

    shouldFocusRelationshipRef.current = false;
    const content = contentRef.current;
    if (!content) return;

    const focusTarget = content.querySelector<HTMLElement>(INSPECTOR_FOCUSABLE_SELECTOR);
    (focusTarget ?? content).focus();
  }, [activeQuery.isLoading, duplicateDraft, isOpen, target?.id, timeblockKind]);

  // 作成モードは自動で先頭 focusable（種別タブ）へ focus しない。ドラッグ直後にグリッド側の
  // リサイズ操作を続けられるよう、パネルは focus を奪わずに開く（DockedInspectorPanel が
  // slot 到着時に 1 回 focus するのは既存挙動のまま）。

  let relationships: TimeblockRelationships | undefined;
  if (!duplicateDraft && timeblockKind === 'plan') {
    const status: 'loading' | 'error' | 'success' = relatedRecordsQuery.isError
      ? 'error'
      : relatedRecordsQuery.isSuccess
        ? 'success'
        : 'loading';
    relationships = {
      kind: 'plan',
      status,
      records: plan
        ? (() => {
            const rows = relatedRecordsQuery.data ?? [];
            const ids = new Set(
              overlappingRecords(
                toInspectorDerivedBlock(plan, 'plan'),
                rows.map((row) => toInspectorDerivedBlock(row, 'rec')),
                new Date(),
              ).map((row) => row.id),
            );
            return rows.filter((row) => ids.has(row.id));
          })()
        : [],
      onRetry: () => void relatedRecordsQuery.refetch(),
    };
  }

  useInspectorKeyboard({
    isOpen,
    onClose: handleClose,
  });

  // --- コンテンツ（loading / error / empty / form） ---
  const displayActivityId = duplicateDraft?.activityId ?? target?.activity_id;
  const title = createMode
    ? t('calendar.activitySelector.title')
    : ((displayActivityId ? getActivityById(displayActivityId)?.name : undefined) ??
      t('calendar.filter.noActivity'));
  let content: React.ReactNode;

  if (createMode) {
    content = createContent ?? null;
  } else if (duplicateDraft) {
    content = (
      <TimeblockInspectorForm
        key={`duplicate:${duplicateDraft.kind}:${duplicateDraft.sourceId}`}
        kind={duplicateDraft.kind}
        duplicateDraft={duplicateDraft}
        onCancelDuplicate={handleCancelDuplicate}
        onDuplicateCreated={handleOpenRelationship}
        onCloseInspector={handleClose}
        onDeleted={handleClose}
      />
    );
  } else if (activeQuery.isLoading) {
    content = (
      <div className="flex h-full flex-1 items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  } else if (activeQuery.isError) {
    content = (
      <ErrorState
        title={t('error.boundary.title')}
        onRetry={() => activeQuery.refetch()}
        size="sm"
        centered
      />
    );
  } else if (!target) {
    content = (
      <div className="flex h-full flex-1 items-center justify-center">
        <p className="text-muted-foreground">{t('timeblock.inspector.notFound')}</p>
      </div>
    );
  } else {
    content = (
      <TimeblockInspectorForm
        key={`${timeblockKind}:${target.id}`}
        kind={timeblockKind}
        plan={plan}
        record={record}
        relationships={relationships}
        onOpenRelationship={handleOpenRelationship}
        onViewStats={onViewStats}
        onCopy={onCopy}
        onStartDuplicate={openDuplicate}
        onCloseInspector={handleClose}
        onDeleted={handleClose}
      />
    );
  }

  const contentElement = (
    <div ref={contentRef} tabIndex={-1} className="focus:outline-none">
      {content}
    </div>
  );

  // URL同期は常時有効（popstateリスナーをInspector閉じ中も維持するため）
  const urlSyncElement = (
    <Suspense fallback={null}>
      <InspectorURLSyncHandler />
    </Suspense>
  );

  if (!isOpen) return urlSyncElement;

  return (
    <>
      {urlSyncElement}

      {isMobile ? (
        <Drawer
          open={isOpen}
          onOpenChange={(open) => !open && handleClose()}
          handleOnly
          repositionInputs={false}
        >
          <DrawerContent className="flex flex-col gap-0 overflow-hidden p-0">
            <DrawerTitle className="sr-only">{title}</DrawerTitle>
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <div className="mx-auto w-full max-w-lg">{contentElement}</div>
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <DockedInspectorPanel
          title={title}
          slotElement={inspectorSlotElement}
          onRequestClose={handleClose}
        >
          {contentElement}
        </DockedInspectorPanel>
      )}
    </>
  );
}
