import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isValidTimeModelRange,
  TimeblockEditor,
  type TimeModelEditorValue,
} from './TimeblockEditor';

const preferences = vi.hoisted(() => ({
  timezone: 'UTC',
  selectedYear: 2026,
  selectedMonth: 8,
  selectedDay: 30,
}));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => unknown) => selector(preferences),
}));

vi.mock('@/features/timeblock', () => ({
  DateTimeSection: ({
    disabled = false,
    hasError = false,
    selectedDate,
    startTime,
    endTime,
    onStartChange,
    onEndChange,
    onDateSelect,
  }: {
    disabled?: boolean;
    hasError?: boolean;
    selectedDate: Date;
    startTime: string;
    endTime: string;
    onStartChange: (time: string) => void;
    onEndChange: (time: string) => void;
    onDateSelect: (date: Date) => void;
  }) => (
    <div
      data-disabled={String(disabled)}
      data-has-error={String(hasError)}
      data-testid="date-time-section"
    >
      <output data-testid="editor-date">{`${selectedDate.getFullYear()}-${selectedDate.getMonth() + 1}-${selectedDate.getDate()}`}</output>
      <output data-testid="editor-start">{startTime}</output>
      <output data-testid="editor-end">{endTime}</output>
      <button onClick={() => onStartChange('12:30')}>change-start</button>
      <button onClick={() => onEndChange('13:30')}>change-end</button>
      <button onClick={() => onStartChange(startTime)}>same-start</button>
      <button
        onClick={() =>
          onDateSelect(
            new Date(preferences.selectedYear, preferences.selectedMonth, preferences.selectedDay),
          )
        }
      >
        change-date
      </button>
    </div>
  ),
}));

const value: TimeModelEditorValue = {
  note: '',
  activityId: 'activity-1',
  startAt: new Date('2099-07-14T09:00:00.000Z'),
  endAt: new Date('2099-07-14T10:00:00.000Z'),
  source: 'plan',
};

describe('TimeblockEditor', () => {
  beforeEach(() => {
    preferences.timezone = 'UTC';
    preferences.selectedYear = 2026;
    preferences.selectedMonth = 8;
    preferences.selectedDay = 30;
  });

  it('保存済みの実時刻をニューヨークの9月29日12:14として表示する', () => {
    preferences.timezone = 'America/New_York';
    render(
      <TimeblockEditor
        value={{
          ...value,
          startAt: new Date('2026-09-29T16:14:00Z'),
          endAt: new Date('2026-09-29T17:14:00Z'),
        }}
        onDateTimeChange={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('editor-date')).toHaveTextContent('2026-9-29');
    expect(screen.getByTestId('editor-start')).toHaveTextContent('12:14');
    expect(screen.getByTestId('editor-end')).toHaveTextContent('13:14');
  });

  it('開始時刻の変更をニューヨークの実時刻へ戻して終了は保持する', () => {
    preferences.timezone = 'America/New_York';
    const onDateTimeChange = vi.fn();
    const original = {
      ...value,
      startAt: new Date('2026-09-29T16:14:00Z'),
      endAt: new Date('2026-09-29T17:14:00Z'),
    };
    render(
      <TimeblockEditor
        value={original}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'change-start' }));

    expect(onDateTimeChange).toHaveBeenCalledOnce();
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt.toISOString()).toBe(
      '2026-09-29T16:30:00.000Z',
    );
    expect(onDateTimeChange.mock.calls[0]?.[0].endAt).toBe(original.endAt);
  });

  it('日付変更でもニューヨークの壁時計時刻と翌日の終了を保持する', () => {
    preferences.timezone = 'America/New_York';
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={{
          ...value,
          startAt: new Date('2026-09-29T03:00:00Z'),
          endAt: new Date('2026-09-29T06:00:00Z'),
        }}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'change-date' }));

    expect(onDateTimeChange.mock.calls[0]?.[0].startAt.toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    expect(onDateTimeChange.mock.calls[0]?.[0].endAt.toISOString()).toBe(
      '2026-10-01T06:00:00.000Z',
    );
  });
  it.each([
    ['UTC', '2026-09-29T12:14:00Z', '2026-09-29T13:14:00Z', '2026-09-29T12:30:00.000Z'],
    ['Asia/Tokyo', '2026-09-29T03:14:00Z', '2026-09-29T04:14:00Z', '2026-09-29T03:30:00.000Z'],
  ])('%sでも設定の時刻を表示し実時刻で返す', (timezone, start, end, expected) => {
    preferences.timezone = timezone;
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={{ ...value, startAt: new Date(start), endAt: new Date(end) }}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-start')).toHaveTextContent('12:14');
    fireEvent.click(screen.getByRole('button', { name: 'change-start' }));
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt.toISOString()).toBe(expected);
  });

  it('終了だけ編集すると開始の実時刻は保持する', () => {
    preferences.timezone = 'America/New_York';
    const original = {
      ...value,
      startAt: new Date('2026-09-29T16:14:00Z'),
      endAt: new Date('2026-09-29T17:14:00Z'),
    };
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={original}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'change-end' }));
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt).toBe(original.startAt);
    expect(onDateTimeChange.mock.calls[0]?.[0].endAt.toISOString()).toBe(
      '2026-09-29T17:30:00.000Z',
    );
  });

  it('DST終了の2回目の同時刻を再確定しても実時刻を動かさない', () => {
    preferences.timezone = 'America/New_York';
    const original = {
      ...value,
      startAt: new Date('2026-11-01T06:30:00Z'),
      endAt: new Date('2026-11-01T07:30:00Z'),
    };
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={original}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-start')).toHaveTextContent('01:30');
    fireEvent.click(screen.getByRole('button', { name: 'same-start' }));
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt).toBe(original.startAt);
    expect(onDateTimeChange.mock.calls[0]?.[0].endAt).toBe(original.endAt);
  });

  it('同じ分の入力を再確定しても保存済みの秒を切り捨てない', () => {
    preferences.timezone = 'America/New_York';
    const original = {
      ...value,
      startAt: new Date('2026-09-29T16:14:25Z'),
      endAt: new Date('2026-09-29T17:14:25Z'),
    };
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={original}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'same-start' }));
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt).toBe(original.startAt);
  });

  it('DST開始日への日付変更は壁時計時刻を保ちUTCオフセットを変える', () => {
    preferences.timezone = 'America/New_York';
    preferences.selectedMonth = 2;
    preferences.selectedDay = 8;
    const onDateTimeChange = vi.fn<(next: TimeModelEditorValue) => void>();
    render(
      <TimeblockEditor
        value={{
          ...value,
          startAt: new Date('2026-03-07T17:00:00Z'),
          endAt: new Date('2026-03-07T18:00:00Z'),
        }}
        onDateTimeChange={onDateTimeChange}
        onNoteChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'change-date' }));
    expect(onDateTimeChange.mock.calls[0]?.[0].startAt.toISOString()).toBe(
      '2026-03-08T16:00:00.000Z',
    );
    expect(onDateTimeChange.mock.calls[0]?.[0].endAt.toISOString()).toBe(
      '2026-03-08T17:00:00.000Z',
    );
  });

  it('開始が終了以降の入力を未確定として扱う', () => {
    expect(
      isValidTimeModelRange({
        ...value,
        startAt: new Date('2099-07-14T10:00:00.000Z'),
        endAt: new Date('2099-07-14T10:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('詳細画面に保存先チップ・タイトル入力・保存ボタンを表示しない', () => {
    render(
      <TimeblockEditor
        value={value}
        onDateTimeChange={vi.fn()}
        onNoteChange={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.queryByText('plan')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('title')).not.toBeInTheDocument();
    expect(screen.getByText('0/1000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });

  it('メモ入力の変更とフォーカス解除を上位へ通知する', () => {
    const onNoteChange = vi.fn();
    const onNoteBlur = vi.fn();
    render(
      <TimeblockEditor
        value={value}
        onDateTimeChange={vi.fn()}
        onNoteChange={onNoteChange}
        onNoteBlur={onNoteBlur}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'note' }));
    const note = screen.getByRole('textbox', { name: 'note' });
    fireEvent.change(note, { target: { value: '調査メモ' } });
    fireEvent.blur(note);

    expect(onNoteChange).toHaveBeenCalledWith('調査メモ');
    expect(onNoteBlur).toHaveBeenCalledOnce();
  });

  it('時間重複を入力状態と共通のTimeConflictAlertで表示する', () => {
    render(
      <TimeblockEditor
        value={value}
        onDateTimeChange={vi.fn()}
        onNoteChange={vi.fn()}
        dateTimeError="この時間帯には既に予定があります"
      />,
    );

    expect(screen.getByTestId('date-time-section')).toHaveAttribute('data-has-error', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('この時間帯には既に予定があります');
  });

  it('過去Planでも日時とメモを編集できる', () => {
    render(
      <TimeblockEditor
        value={{
          ...value,
          startAt: new Date('2020-07-14T09:00:00.000Z'),
          endAt: new Date('2020-07-14T10:00:00.000Z'),
        }}
        onDateTimeChange={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('date-time-section')).toHaveAttribute('data-disabled', 'false');
    const note = screen.getByRole('button', { name: 'note' });
    expect(note).toHaveAttribute('tabindex', '0');
    fireEvent.click(note);
    expect(screen.getByRole('textbox', { name: 'note' })).not.toBeDisabled();
    expect(screen.queryByText('timeLocked')).not.toBeInTheDocument();
  });

  it('過去Recordでは日時とメモを編集できる', () => {
    render(
      <TimeblockEditor
        value={{
          ...value,
          source: 'record',
          startAt: new Date('2020-07-14T09:00:00.000Z'),
          endAt: new Date('2020-07-14T10:00:00.000Z'),
        }}
        onDateTimeChange={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('date-time-section')).toHaveAttribute('data-disabled', 'false');
    const note = screen.getByRole('button', { name: 'note' });
    expect(note).toHaveAttribute('tabindex', '0');
    fireEvent.click(note);
    expect(screen.getByRole('textbox', { name: 'note' })).not.toBeDisabled();
    expect(screen.queryByText('timeLocked')).not.toBeInTheDocument();
  });

  it('全体を無効化した場合は日時とメモを編集できない', () => {
    render(
      <TimeblockEditor value={value} onDateTimeChange={vi.fn()} onNoteChange={vi.fn()} disabled />,
    );

    expect(screen.getByTestId('date-time-section')).toHaveAttribute('data-disabled', 'true');
    const note = screen.getByRole('button', { name: 'note' });
    expect(note).toHaveAttribute('tabindex', '-1');
    fireEvent.click(note);
    expect(screen.queryByRole('textbox', { name: 'note' })).not.toBeInTheDocument();
  });
});
