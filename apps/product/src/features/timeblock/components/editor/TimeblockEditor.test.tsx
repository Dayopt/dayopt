import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  isValidTimeModelRange,
  TimeblockEditor,
  type TimeModelEditorValue,
} from './TimeblockEditor';

vi.mock('@/features/timeblock', () => ({
  DateTimeSection: ({
    disabled = false,
    hasError = false,
  }: {
    disabled?: boolean;
    hasError?: boolean;
  }) => (
    <div
      data-disabled={String(disabled)}
      data-has-error={String(hasError)}
      data-testid="date-time-section"
    />
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
