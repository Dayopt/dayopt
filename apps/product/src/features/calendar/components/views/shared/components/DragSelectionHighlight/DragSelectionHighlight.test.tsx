/**
 * ドラッグ選択ハイライトのプレビュー表示。
 *
 * 作成パネルでアクティビティをホバーすると、グリッド上のハイライトが色と名前を先出しする。
 * カテゴリーに icon が無い場合も、一覧と同じく色ドットへフォールバックする。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInlineCreateStore } from '../../../../../stores/useInlineCreateStore';
import type { CalendarDisplayEvent } from '../../../../../types/calendar.types';

import { DragSelectionHighlight } from './DragSelectionHighlight';

vi.mock('@/features/timeblock', async () => {
  const domain = await vi.importActual<
    typeof import('@/features/timeblock/domain/timeblock-destination')
  >('@/features/timeblock/domain/timeblock-destination');

  return {
    resolveTimeblockDestination: domain.resolveTimeblockDestination,
    resolveTimeblockKindChoice: domain.resolveTimeblockKindChoice,
    useTimeblockInspectorStore: Object.assign(
      (selector: (s: { createMode: boolean }) => unknown) => selector({ createMode: true }),
      { getState: () => ({ createMode: true }) },
    ),
  };
});

vi.mock('@/features/activities', () => ({
  getCategoryColorClasses: () => ({ border: 'border-blue', tint: 'bg-blue' }),
  ActivityIcon: ({ icon, color }: { icon: string | null; color: string | null }) => (
    <span data-testid="activity-marker" data-icon={icon ?? 'dot'} data-color={color ?? 'none'} />
  ),
}));

vi.mock('../../../../create/useInlineCreate', () => ({
  useInlineCreate: () => ({ hasConflict: false }),
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (s: { timezone: string; timeFormat: string }) => unknown) =>
    selector({ timezone: 'UTC', timeFormat: '24h' }),
}));
vi.mock('../../../../../hooks/accessibility/useHapticFeedback', () => ({
  useHapticFeedback: () => ({ tap: vi.fn(), impact: vi.fn() }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

function seedSelection() {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  useInlineCreateStore.setState({
    pendingSelection: {
      date,
      startHour: 9,
      startMinute: 0,
      endHour: 11,
      endMinute: 0,
    },
  });
  return date;
}

/** 壁時計の日付 + 時刻から、mock した TZ（UTC）の instant を作る */
function utcAt(day: Date, hour: number): Date {
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0));
}

function planEvent(start: Date, end: Date, overrides: Partial<CalendarDisplayEvent> = {}) {
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
    ...overrides,
  } as CalendarDisplayEvent;
}

describe('DragSelectionHighlight のプレビュー', () => {
  beforeEach(() => {
    useInlineCreateStore.setState({ pendingSelection: null, hoveredActivity: null });
  });

  it('ホバー中のアクティビティのマーカーを出す', () => {
    seedSelection();
    useInlineCreateStore.setState({
      hoveredActivity: { id: 'a1', name: '開発', color: 'blue', icon: 'briefcase' },
    });

    render(<DragSelectionHighlight hourHeight={60} />);

    const marker = screen.getByTestId('activity-marker');
    expect(marker).toHaveAttribute('data-icon', 'briefcase');
    expect(marker).toHaveAttribute('data-color', 'blue');
    expect(screen.getByText('開発')).toBeInTheDocument();
  });

  it('カテゴリーに icon が無くても色のマーカーを出す', () => {
    seedSelection();
    useInlineCreateStore.setState({
      hoveredActivity: { id: 'a1', name: '開発', color: 'blue', icon: null },
    });

    render(<DragSelectionHighlight hourHeight={60} />);

    expect(screen.getByTestId('activity-marker')).toHaveAttribute('data-color', 'blue');
  });

  it('未分類は継承する色が無いのでマーカーを出さない', () => {
    seedSelection();
    useInlineCreateStore.setState({
      hoveredActivity: { id: 'a1', name: '散歩', color: null, icon: null },
    });

    render(<DragSelectionHighlight hourHeight={60} />);

    expect(screen.queryByTestId('activity-marker')).not.toBeInTheDocument();
    expect(screen.getByText('散歩')).toBeInTheDocument();
  });
});

describe('DragSelectionHighlight の残り時間（#2096）', () => {
  beforeEach(() => {
    useInlineCreateStore.setState({ pendingSelection: null, hoveredActivity: null });
  });

  it('24h からその日の予定合計と選択中の長さを引いた残りを出す', () => {
    const day = seedSelection();
    const dayEntries = [
      planEvent(utcAt(day, 13), utcAt(day, 14)),
      planEvent(utcAt(day, 15), utcAt(day, 16)),
    ];

    const { container } = render(
      <DragSelectionHighlight hourHeight={60} dayEntries={dayEntries} />,
    );

    // 24h - 予定 2h - 選択 2h = 20h
    expect(container.querySelector('[data-remaining-day-minutes]')).toHaveAttribute(
      'data-remaining-day-minutes',
      '1200',
    );
  });

  it('別の日の予定は引かない', () => {
    const day = seedSelection();
    const otherDay = new Date(day);
    otherDay.setDate(otherDay.getDate() + 1);

    const { container } = render(
      <DragSelectionHighlight
        hourHeight={60}
        dayEntries={[planEvent(utcAt(otherDay, 13), utcAt(otherDay, 14))]}
      />,
    );

    // 24h - 選択 2h = 22h
    expect(container.querySelector('[data-remaining-day-minutes]')).toHaveAttribute(
      'data-remaining-day-minutes',
      '1320',
    );
  });

  it('記録の選択では出さない', () => {
    const date = new Date();
    date.setDate(date.getDate() - 2);
    useInlineCreateStore.setState({
      pendingSelection: {
        date,
        startHour: 9,
        startMinute: 0,
        endHour: 11,
        endMinute: 0,
        kind: 'record',
      },
    });

    const { container } = render(<DragSelectionHighlight hourHeight={60} dayEntries={[]} />);

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });

  it('dayEntries が未配線なら出さない', () => {
    seedSelection();

    const { container } = render(<DragSelectionHighlight hourHeight={60} />);

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });

  it('compact（40px 未満）では出さない', () => {
    const day = seedSelection();
    useInlineCreateStore.setState({
      pendingSelection: {
        date: day,
        startHour: 9,
        startMinute: 0,
        endHour: 9,
        endMinute: 30,
      },
    });

    // 30 分 x hourHeight 60 = 30px < 40px
    const { container } = render(<DragSelectionHighlight hourHeight={60} dayEntries={[]} />);

    expect(container.querySelector('[data-remaining-day-minutes]')).toBeNull();
  });
});
