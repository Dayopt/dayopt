'use client';

/**
 * ドラッグ作成パネル（Inspector の作成モード本体）
 *
 * カレンダーをドラッグして時間帯を確定すると、編集と同じ右パネル（モバイルは Drawer）に
 * この内容が出る。並びは編集画面と同じで、ヘッダー行に種別タブ（予定 / 記録）を置き、
 * その下に日付・時間 → アクティビティ一覧と続く。
 *
 * - アクティビティを選んだ瞬間に作成する（明示の作成ボタンは持たない）
 * - 閉じると破棄する（明示のキャンセルボタンも持たない）
 * - 時間はグリッド上のドラッグ / リサイズと、この日時入力のどちらからでも直せる。
 *   どちらも同じ `pendingSelection` を読み書きするので相互に反映される
 */

import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { IconTabSwitcher } from '@/components/ui/navigation/IconTabSwitcher';
import { ActivityPickerList } from '@/features/activities';
import {
  DateTimeSection,
  InspectorHeaderActions,
  resolveTimeblockKindChoice,
  TimeConflictAlert,
  type TimeblockDestination,
} from '@/features/timeblock';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { cn } from '@dayopt/components';

import { useHapticFeedback } from '../../hooks/accessibility/useHapticFeedback';
import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

import { useInlineCreate } from './useInlineCreate';

/** `HH:MM` を時・分へ分解する（不正値は 0 に倒す） */
function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** 時・分を `HH:MM` にする */
function formatHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface InlineCreatePanelProps {
  /** パネルを閉じる（＝作成せずに破棄する） */
  onClose: () => void;
}

/** ドラッグ選択からアクティビティを選んで plan / record を作る Inspector 作成モード */
export function InlineCreatePanel({ onClose }: InlineCreatePanelProps) {
  const t = useTranslations();
  const tCalendar = useTranslations('calendar');
  const tEditor = useTranslations('timeblock.editor');
  const timezone = useUserPreferences((s) => s.timezone);
  const { tap } = useHapticFeedback();

  const pendingSelection = useInlineCreateStore.use.pendingSelection();
  const setSelectionKind = useInlineCreateStore.use.setSelectionKind();
  const updateSelectionTimes = useInlineCreateStore.use.updateSelectionTimes();
  const setSelectionDate = useInlineCreateStore.use.setSelectionDate();

  const { handleCreate, handleCreateAndSelect, handleActivityHover, hasConflict } =
    useInlineCreate();

  const handleStartChange = useCallback(
    (next: string) => {
      const { hour, minute } = parseHHMM(next);
      updateSelectionTimes({ startHour: hour, startMinute: minute });
    },
    [updateSelectionTimes],
  );

  const handleEndChange = useCallback(
    (next: string) => {
      const { hour, minute } = parseHHMM(next);
      updateSelectionTimes({ endHour: hour, endMinute: minute });
    },
    [updateSelectionTimes],
  );

  if (!pendingSelection) return null;

  const { date, startHour, startMinute, endHour, endMinute } = pendingSelection;

  const selectionEndLocal = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    endHour,
    endMinute,
  );
  const { kind, canRecord } = resolveTimeblockKindChoice(
    convertFromTimezone(selectionEndLocal, timezone),
    pendingSelection.kind,
  );

  // 並びは時間軸と同じ「これからのこと → 済んだこと」。未来スロットでは記録を選べないので
  // 出したまま押せなくし、理由はタブの下に常時表示する（disabled は hover を受け付けない）
  const kindItems = [
    { value: 'plan' as const, label: tCalendar('event.preview.plan') },
    {
      value: 'record' as const,
      label: tCalendar('event.preview.record'),
      disabled: !canRecord,
    },
  ];

  const isInvalidRange = endHour * 60 + endMinute <= startHour * 60 + startMinute;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        ヘッダー行は編集画面（TimeblockInspectorForm）と同じ h-14 / px-2 に揃える。
        編集がアクティビティ名を置く位置に、作成では種別タブを置く（作成時の主語は種別で、
        アクティビティは下の一覧で選ぶため）。
      */}
      <div className="flex h-14 shrink-0 items-center justify-between px-2">
        <div className="flex min-w-0 items-center pl-2">
          <IconTabSwitcher
            value={kind}
            onValueChange={(next: TimeblockDestination) => {
              tap();
              setSelectionKind(next);
            }}
            items={kindItems}
            ariaLabel={tCalendar('activitySelector.kindLabel')}
          />
        </div>
        <InspectorHeaderActions onCloseInspector={onClose} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        {!canRecord && (
          <p className="text-muted-foreground shrink-0 text-xs">
            {tCalendar('activitySelector.recordUnavailableFuture')}
          </p>
        )}

        <div className="shrink-0">
          <DateTimeSection
            dateLabel={tEditor('date')}
            timeLabel={tEditor('time')}
            selectedDate={date}
            onDateSelect={setSelectionDate}
            startTime={formatHHMM(startHour, startMinute)}
            onStartChange={handleStartChange}
            endTime={formatHHMM(endHour, endMinute)}
            onEndChange={handleEndChange}
            hasError={hasConflict || isInvalidRange}
            testId="inline-create-time"
          />
        </div>

        <div
          className={cn(
            // eslint-disable-next-line tailwindcss/no-arbitrary-value -- 展開/折りたたみの grid animation（Inspector と同じパターン）
            'grid shrink-0 transition-[grid-template-rows] duration-200',
            hasConflict ? 'grid-rows-expanded' : 'grid-rows-collapsed',
          )}
          aria-hidden={!hasConflict}
        >
          <div className="overflow-hidden">
            <TimeConflictAlert message={t('timeblock.errors.timeOverlap')} />
          </div>
        </div>

        {/* アクティビティを選んだ瞬間に作成する。パネル内で唯一の確定操作 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ActivityPickerList
            variant="embedded"
            onSelect={handleCreate}
            onCreateAndSelect={handleCreateAndSelect}
            onActivityHover={handleActivityHover}
          />
        </div>
      </div>
    </div>
  );
}
