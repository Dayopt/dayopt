import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TREE = {
  categories: [
    {
      category: { id: 'cat-work', name: '仕事', color: 'blue', icon: 'briefcase' },
      activities: [{ id: 'act-dev', name: '実装' }],
    },
  ],
  uncategorized: [{ id: 'act-walk', name: '散歩' }],
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

vi.mock('@/features/activities', () => ({
  useActivityTree: () => ({ data: TREE, isPending: false }),
  ActivityIcon: () => <span data-testid="activity-icon" />,
}));

// モバイルの面（幅 < 768px）は coarse pointer でもあるので、一覧はタッチ扱いになる
vi.mock('@/lib/hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));

import { useReportViewStore } from '../../stores/useReportViewStore';
import { ReportFilterDrawer } from './ReportFilterDrawer';

describe('ReportFilterDrawer', () => {
  beforeEach(() => {
    useReportViewStore.setState({ hiddenCategoryIds: [], hiddenActivityIds: [] });
  });

  it('ボタンを押すとサイドバーと同じ一覧が Drawer で開き、同じ store を書く', async () => {
    const user = userEvent.setup();
    render(<ReportFilterDrawer />);

    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'open' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('title');
    expect(screen.getByText('実装').closest('[data-report-filter-row="activity"]')).toHaveClass(
      'h-11',
    );
    // アクティビティ単位の出し入れがモバイルにもある（チップ列の時は無かった）
    await user.click(screen.getByRole('button', { name: 'hide 実装' }));
    expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-dev']);
    await user.click(screen.getByRole('button', { name: 'hide 散歩' }));
    expect(useReportViewStore.getState().hiddenActivityIds).toEqual(['act-dev', 'act-walk']);
  });

  it('何かを外している間はボタンに印が付く', () => {
    const { rerender } = render(<ReportFilterDrawer />);
    expect(screen.getByRole('button', { name: 'open' })).not.toHaveAttribute(
      'data-report-filter-active',
    );

    useReportViewStore.setState({ hiddenActivityIds: ['act-dev'] });
    rerender(<ReportFilterDrawer />);

    expect(screen.getByRole('button', { name: 'open' })).toHaveAttribute(
      'data-report-filter-active',
      'true',
    );
  });
});
