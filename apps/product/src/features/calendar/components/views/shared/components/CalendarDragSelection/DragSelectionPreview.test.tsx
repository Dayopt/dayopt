/**
 * ドラッグ中プレビューの残り時間表示（#2096）。
 *
 * 予定として保存される選択のときだけ、24h からその日の予定合計と選択中の長さを引いた
 * 残りを静かに示す。記録の選択・重なり表示中・compact では出さない。
 */

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

import { DragSelectionPreview } from './DragSelectionPreview';

vi.mock('@/features/timeblock', async () => {
  const domain = await vi.importActual<
    typeof import('@/features/timeblock/domain/timeblock-destination')
  >('@/features/timeblock/domain/timeblock-destination');

  return { resolveTimeblockDestination: domain.resolveTimeblockDestination };
});

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string }) => unknown) =>
    selector({ timezone: 'UTC' }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function futureDay(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** 壁時計の日付 + 時刻から、mock した TZ（UTC）の instant を作る */
function utcAt(day: Date, hour: number): Date {
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0));
}

function planEvent(start: Date, end: Date): CalendarDisplayEvent {
  return {
    id: `plan-${start.toISOString()}`,
    title: 'Focus',
    startDate: start,
    endDate: end,
    plannedStartDate: start,
    plannedEndDate: end,
    displayStartDate: start,
    displayEndDate: end,
    status: 'open',
    color: 'var(--category-blue)',
    activityId: 'a1',
    createdAt: start,
    updatedAt: end,
    version: '2026-07-15T00:00:00.000000Z',
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
  } as CalendarDisplayEvent;
}

const selection = { startHour: 9, startMinute: 0, endHour: 11, endMinute: 0 };

describe('DragSelectionPreview の残り時間', () => {
  it('24h からその日の予定合計と選択中の長さを引いた残りを出す', () => {
    const day = futureDay();

    const { container } = render(
      <DragSelectionPreview
        selection={selection}
        date={day}
        formatTime={formatTime}
        allDayEvents={[planEvent(utcAt(day, 13), utcAt(day, 14))]}
      />,
    );

    // 24h - 予定 1h - 選択 2h = 21h
    const label = container.querySelector('[data-remaining-day-minutes]');
    expect(label).toHaveAttribute('data-remaining-day-minutes', '1260');
    expect(label?.textContent).toContain('timeblock.preview.remaining');
    expect(label?.textContent).toContain('21h');
  });

  it('24h を超えて置いている日は符号付きで出す', () => {
    const day = futureDay();

    const { container } = render(
      <DragSelectionPreview
        selection={selection}
        date={day}
        formatTime={formatTime}
        allDayEvents={[
          planEvent(utcAt(day, 0), utcAt(day, 8)),
          planEvent(utcAt(day, 8), utcAt(day, 16)),
          planEvent(utcAt(day, 16), utcAt(day, 23)),
        ]}
      />,
    );

    // 24h - 23h - 選択 2h = -1h
    const label = container.querySelector('[data-remaining-day-minutes]');
    expect(label).toHaveAttribute('data-remaining-day-minutes', '-60');
    expect(label?.textContent).toContain('-1h');
  });

  it('記録になる過去の選択では出さない', () => {
    const day = new Date();
    day.setDate(day.getDate() - 2);
    day.setHours(0, 0, 0, 0);

    const { container } = render(
      <DragSelectionPreview
        selection={selection}
        date={day}
        formatTime={formatTime}
        allDayEvents={[]}
      />,
    );

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });

  it('重なり表示中は出さない', () => {
    const day = futureDay();

    const { container } = render(
      <DragSelectionPreview
        selection={selection}
        date={day}
        formatTime={formatTime}
        isOverlapping
        allDayEvents={[]}
      />,
    );

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });

  it('compact（40px 未満）では出さない', () => {
    const day = futureDay();

    const { container } = render(
      <DragSelectionPreview
        selection={{ startHour: 9, startMinute: 0, endHour: 9, endMinute: 30 }}
        date={day}
        formatTime={formatTime}
        hourHeight={60}
        allDayEvents={[]}
      />,
    );

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });

  it('allDayEvents が未配線なら出さない', () => {
    const day = futureDay();

    const { container } = render(
      <DragSelectionPreview selection={selection} date={day} formatTime={formatTime} />,
    );

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });
});
