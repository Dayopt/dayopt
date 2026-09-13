'use client';

/**
 * ドラッグ作成パネル（Inspector の作成モード本体）
 *
 * カレンダーをドラッグして時間帯を確定すると、編集と同じ右パネル（モバイルは Drawer）に
 * この内容が出る。ヘッダー行に種別タブ（予定 / 記録）を置き、その直下にアクティビティ一覧、
 * その下に編集画面と同じ `TimeblockEditor`（日付・時間のグルーピング、記録なら充実度、メモ）を置く。
 *
 * 日付・時間・充実度・メモは選ぶ前に埋めておける。最後に残るのはアクティビティの選択だけで、
 * それを押した瞬間に全部まとめて作成する。
 *
 * - アクティビティを選んだ瞬間に作成する（明示の作成ボタンは持たない）
 * - 閉じると破棄する（明示のキャンセルボタンも持たない）
 * - 時間はグリッド上のドラッグ / リサイズと、この日時入力のどちらからでも直せる。
 *   どちらも同じ `pendingSelection` を読み書きするので相互に反映される
 */

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { IconTabSwitcher } from '@/components/ui/navigation/IconTabSwitcher';
import { ActivityPickerList } from '@/features/activities';
import {
  InspectorHeaderActions,
  RecordFulfillmentRow,
  resolveTimeblockKindChoice,
  TimeblockEditor,
  useActivityMedianDurations,
  type Fulfillment,
  type TimeblockDestination,
  type TimeModelEditorValue,
} from '@/features/timeblock';
import { convertFromTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { useHapticFeedback } from '../../hooks/accessibility/useHapticFeedback';
import { formatRemainingDuration } from '../../lib/remaining-day-minutes';
import { useInlineCreateStore } from '../../stores/useInlineCreateStore';

import { useInlineCreate } from './useInlineCreate';
import { useRemainingDayMinutes } from './useRemainingDayMinutes';

interface InlineCreatePanelProps {
  /** パネルを閉じる（＝作成せずに破棄する） */
  onClose: () => void;
}

/** ドラッグ選択からアクティビティを選んで plan / record を作る Inspector 作成モード */
export function InlineCreatePanel({ onClose }: InlineCreatePanelProps) {
  const { canUseProduct } = useBillingAccess();
  const t = useTranslations();
  const tCalendar = useTranslations('calendar');
  const timezone = useUserPreferences((s) => s.timezone);
  const { tap } = useHapticFeedback();
  // 選ぶ前に「このアクティビティは普段どのくらいか」が見えるよう、一覧の各行へ添える。
  // 予定・記録どちらのタブでも同じ記録の中央値を出す（実際にかかった時間が目安）
  const { medianByActivityId } = useActivityMedianDurations();

  const pendingSelection = useInlineCreateStore.use.pendingSelection();
  const setSelectionKind = useInlineCreateStore.use.setSelectionKind();
  const updateSelectionTimes = useInlineCreateStore.use.updateSelectionTimes();
  const setSelectionDate = useInlineCreateStore.use.setSelectionDate();

  // 作成前に埋めておける値。アクティビティを選んだ時に一緒に送る
  const [note, setNote] = useState('');
  const [fulfillment, setFulfillment] = useState<Fulfillment | null>(null);

  const { handleCreate, handleCreateAndSelect, handleActivityHover, hasConflict } = useInlineCreate(
    {
      note,
      fulfillment,
    },
  );

  // #2096: 予定を置く瞬間だけ、その日の残り時間を静かに示す
  const remainingMinutes = useRemainingDayMinutes(pendingSelection);

  // TimeblockEditor は Date で値を持つ。選択範囲（日付 + 時・分）へ落として store を更新する
  const handleDateTimeChange = useCallback(
    (next: TimeModelEditorValue) => {
      setSelectionDate(
        new Date(next.startAt.getFullYear(), next.startAt.getMonth(), next.startAt.getDate()),
      );
      updateSelectionTimes({
        startHour: next.startAt.getHours(),
        startMinute: next.startAt.getMinutes(),
        endHour: next.endAt.getHours(),
        endMinute: next.endAt.getMinutes(),
      });
    },
    [setSelectionDate, updateSelectionTimes],
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
    { value: 'plan' as const, label: tCalendar('timeblock.preview.plan') },
    {
      value: 'record' as const,
      label: tCalendar('timeblock.preview.record'),
      disabled: !canRecord,
    },
  ];

  const startAt = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    startHour,
    startMinute,
  );
  const endAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), endHour, endMinute);
  const editorValue: TimeModelEditorValue = { note, activityId: null, startAt, endAt };
  const dateTimeError = hasConflict ? t('timeblock.errors.timeOverlap') : undefined;

  if (!canUseProduct)
    return (
      <div role="status" className="p-4">
        <p>{t('settings.subscription.singlePlan.expired')}</p>
        <InspectorHeaderActions menuItems={[]} onCloseInspector={onClose} />
      </div>
    );

  return (
    <div className="flex flex-col">
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
        {/*
          残り時間はヘッダーのタブの隣に置く。本文の先頭に入れると「アクティビティ選択は
          タブの直下」（2026-09-07 User 指示）を崩すため。モバイル Drawer でも最上部に残る。
          重なりエラー中（本文の dateTimeError）と記録タブでは出さない
        */}
        <div className="flex min-w-0 items-center gap-2">
          {kind === 'plan' && !hasConflict && remainingMinutes !== null && (
            <span
              role="status"
              data-remaining-day-minutes={remainingMinutes}
              className="text-muted-foreground truncate text-xs tabular-nums"
            >
              {tCalendar('timeblock.preview.remaining', {
                duration: formatRemainingDuration(remainingMinutes),
              })}
            </span>
          )}
          <InspectorHeaderActions onCloseInspector={onClose} />
        </div>
      </div>

      {/*
        スクロールはこのパネルでは持たない。編集画面と同じく、外側の器
        （PC は DockedInspectorPanel、モバイルは Drawer の本文）が縦スクロールを担う。
        中で別の器をスクロールさせると、その scrollbar の幅だけ左右の余白がずれる
        （2026-09-07 User 指摘）。
      */}
      <div className="flex flex-col gap-3 px-4 pb-4">
        {!canRecord && (
          <p className="text-muted-foreground text-xs">
            {tCalendar('activitySelector.recordUnavailableFuture')}
          </p>
        )}

        {/*
          アクティビティ選択はタブの直下に置く（2026-09-07 User 指示）。ここが唯一の
          確定操作なので、パネルを開いた視線の先に置いて 1 タップで届くようにする。
        */}
        <ActivityPickerList
          variant="embedded"
          onSelect={handleCreate}
          onCreateAndSelect={handleCreateAndSelect}
          onActivityHover={handleActivityHover}
          durationByActivityId={medianByActivityId}
        />

        {/*
          日付・時間のグルーピング、充実度、メモは編集画面と同じ TimeblockEditor を使う。
          作成でも編集でも同じ形にするため、ここで別の並びを作らない。
        */}
        <div>
          <TimeblockEditor
            value={editorValue}
            onDateTimeChange={handleDateTimeChange}
            onNoteChange={setNote}
            {...(dateTimeError ? { dateTimeError } : {})}
            fulfillmentSlot={
              kind === 'record' ? (
                <RecordFulfillmentRow value={fulfillment} onChange={setFulfillment} />
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
