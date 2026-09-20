'use client';

import { StickyNote } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DateTimeSection } from '@/features/timeblock';
import { formatHHmm } from '@/lib/date';

import { type TimeblockDestination } from '../../domain/timeblock-destination';
import { NoteSection } from '../inspector/fields';
import { TimeConflictAlert } from '../inspector/fields/TimeConflictAlert';

export interface TimeModelEditorValue {
  note: string;
  activityId: string | null;
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
  const hasDateTimeError = !isValidTimeModelRange(value) || dateTimeError != null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {beforeDateTimeSlot ? <div className="pb-2">{beforeDateTimeSlot}</div> : null}
        <div className="bg-muted rounded-2xl px-4 py-2">
          <DateTimeSection
            dateLabel={t('date')}
            timeLabel={t('time')}
            selectedDate={value.startAt}
            onDateSelect={(date) => {
              const startAt = new Date(date);
              startAt.setHours(value.startAt.getHours(), value.startAt.getMinutes(), 0, 0);
              const endAt = new Date(date);
              endAt.setHours(value.endAt.getHours(), value.endAt.getMinutes(), 0, 0);
              onDateTimeChange({ ...value, startAt, endAt });
            }}
            startTime={formatHHmm(value.startAt.getHours(), value.startAt.getMinutes())}
            onStartChange={(next) =>
              onDateTimeChange({ ...value, startAt: withTime(value.startAt, next) })
            }
            endTime={formatHHmm(value.endAt.getHours(), value.endAt.getMinutes())}
            onEndChange={(next) =>
              onDateTimeChange({ ...value, endAt: withTime(value.endAt, next) })
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
