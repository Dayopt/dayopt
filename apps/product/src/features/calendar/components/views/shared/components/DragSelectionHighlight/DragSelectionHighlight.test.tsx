/**
 * ドラッグ選択ハイライトのプレビュー表示。
 *
 * 作成パネルでアクティビティをホバーすると、グリッド上のハイライトが色と名前を先出しする。
 * カテゴリーに icon が無い場合も、一覧と同じく色ドットへフォールバックする。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInlineCreateStore } from '../../../../../stores/useInlineCreateStore';

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
