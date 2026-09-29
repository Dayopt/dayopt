'use client';

import { differenceInCalendarDays } from 'date-fns';
import { StickyNote } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DateTimeSection } from '@/features/timeblock';
import { addDays, formatHHmm } from '@/lib/date';
import { convertFromTimezone, convertToTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { type TimeblockDestination } from '../../domain/timeblock-destination';
import { NoteSection } from '../inspector/fields';
import { TimeConflictAlert } from '../inspector/fields/TimeConflictAlert';

export interface TimeModelEditorValue {
  note: string;
  activityId: string | null;
  /** 保存・callbackの日時は実時刻。表示用の壁時計Dateは保持しない。 */
  startAt: Date;
  endAt: Date;
  /** 既存 Plan の編集時だけ指定する。 */
  source?: TimeblockDestination | undefined;
}

interface TimeModelEditorProps {
  value: TimeModelEditorValue;
  onDateTimeChange: (next: TimeModelEditorValue) => void;
  onNoteChange: (note: string) => void;
  onNoteBlur?: (() => void) | undefined;
  /** 日時入力に紐づけて表示するエラー。 */
  dateTimeError?: string | undefined;
  disabled?: boolean | undefined;
  /** 日時グルーピングの直下（時間の下）に差し込む要素。Record の充実度用（#2412） */
  fulfillmentSlot?: React.ReactNode | undefined;
  /**
   * 日時グルーピングの直上に差し込む要素。見積もりフィードフォワード用。
   * 時間を決める前に目に入る位置に置くため、グループの中ではなく上に出す。
   */
  beforeDateTimeSlot?: React.ReactNode | undefined;
}

function withTime(date: Date, value: string): Date {
  const [hour, minute] = value.split(':').map(Number);
  const next = new Date(date);
  next.setHours(hour ?? 0, minute ?? 0, 0, 0);
  return next;
}

function toEditedInstant(original: Date, displayDate: Date, timezone: string): Date {
  // 入力は分単位。無変更の再確定では保存済みの秒やDSTの重複時刻も保持する。
  const originalDisplay = convertToTimezone(original, timezone);
  originalDisplay.setSeconds(0, 0);
  if (originalDisplay.getTime() === displayDate.getTime()) return original;
  return convertFromTimezone(displayDate, timezone);
}

export function isValidTimeModelRange(value: TimeModelEditorValue): boolean {
  return value.startAt.getTime() < value.endAt.getTime();
}

/** Plan / Record 共通エディタ。確定した入力は上位で自動保存する。 */
export function TimeblockEditor({
  value,
  onDateTimeChange,
  onNoteChange,
  onNoteBlur,
  dateTimeError,
  disabled,
  fulfillmentSlot,
  beforeDateTimeSlot,
}: TimeModelEditorProps) {
  const t = useTranslations('timeblock.editor');
  const timezone = useUserPreferences((preferences) => preferences.timezone);
  const displayStart = convertToTimezone(value.startAt, timezone);
  const displayEnd = convertToTimezone(value.endAt, timezone);
  const hasDateTimeError = !isValidTimeModelRange(value) || dateTimeError != null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {beforeDateTimeSlot ? <div className="pb-2">{beforeDateTimeSlot}</div> : null}
        <div className="bg-muted rounded-2xl px-4 py-2">
          <DateTimeSection
            dateLabel={t('date')}
            timeLabel={t('time')}
            selectedDate={displayStart}
            onDateSelect={(date) => {
              const start = new Date(date);
              start.setHours(displayStart.getHours(), displayStart.getMinutes(), 0, 0);
              const end = addDays(date, differenceInCalendarDays(displayEnd, displayStart));
              end.setHours(displayEnd.getHours(), displayEnd.getMinutes(), 0, 0);
              onDateTimeChange({
                ...value,
                startAt: toEditedInstant(value.startAt, start, timezone),
                endAt: toEditedInstant(value.endAt, end, timezone),
              });
            }}
            startTime={formatHHmm(displayStart.getHours(), displayStart.getMinutes())}
            onStartChange={(next) =>
              onDateTimeChange({
                ...value,
                startAt: toEditedInstant(value.startAt, withTime(displayStart, next), timezone),
              })
            }
            endTime={formatHHmm(displayEnd.getHours(), displayEnd.getMinutes())}
            onEndChange={(next) =>
              onDateTimeChange({
                ...value,
                endAt: toEditedInstant(value.endAt, withTime(displayEnd, next), timezone),
              })
            }
            disabled={disabled === true}
            hasError={hasDateTimeError}
          />
          {fulfillmentSlot}
        </div>
        <div
          // eslint-disable-next-line tailwindcss/no-arbitrary-value -- sidebar create と同じ expand/collapse animation
          className={`grid transition-[grid-template-rows] duration-200 ${dateTimeError ? 'grid-rows-expanded mt-2' : 'grid-rows-collapsed'}`}
          aria-hidden={!dateTimeError}
        >
          <div className="overflow-hidden">
            <TimeConflictAlert message={dateTimeError ?? ''} />
          </div>
        </div>
      </div>
      {/* メモは一番下（v1.0 設計書 §6.1、#2412） */}
      <div onBlurCapture={onNoteBlur}>
        <NoteSection
          label={t('note')}
          icon={StickyNote}
          note={value.note}
          onNoteChange={onNoteChange}
          placeholder={t('notePlaceholder')}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
