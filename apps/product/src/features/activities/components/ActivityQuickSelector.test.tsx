/**
 * アクティビティ選択一覧の「普段の長さ」表示。
 *
 * 集計を持つのは timeblock feature で、この一覧は Map を受け取って描くだけ。
 * サンプルが足りず中央値の無いアクティビティでは何も出さない（沈黙）ことを確認する。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActivityPickerList } from './ActivityQuickSelector';

const TREE = {
  categories: [
    {
      category: { id: 'category-1', name: '仕事', color: 'blue', icon: 'briefcase' },
      activities: [
        { id: 'activity-1', name: '会議', categoryId: 'category-1' },
        { id: 'activity-2', name: '読書', categoryId: 'category-1' },
      ],
    },
  ],
  uncategorized: [{ id: 'activity-3', name: '散歩', categoryId: null }],
};

vi.mock('../hooks/useActivitiesQuery', () => ({
  useActivityTree: () => ({ data: TREE }),
}));
vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: { use: { openActivityCreateModal: () => vi.fn() } },
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

function renderList(durationByActivityId?: ReadonlyMap<string, number>) {
  render(
    <ActivityPickerList
      onSelect={vi.fn()}
      onCreateAndSelect={vi.fn()}
      {...(durationByActivityId ? { durationByActivityId } : {})}
    />,
  );
}

describe('ActivityPickerList の普段の長さ', () => {
  it('中央値のあるアクティビティの行にだけ長さを添える', () => {
    renderList(new Map([['activity-1', 45]]));

    expect(screen.getByRole('button', { name: /会議/ })).toHaveTextContent('45m');
    // 中央値の無い行には数字を出さない
    expect(screen.getByRole('button', { name: /読書/ })).not.toHaveTextContent('45m');
  });

  it('1 時間を超える中央値は時間つきで出す', () => {
    renderList(new Map([['activity-3', 90]]));

    expect(screen.getByRole('button', { name: /散歩/ })).toHaveTextContent('1h 30m');
  });

  it('中央値を渡さない時はどの行にも長さを出さない', () => {
    renderList();

    for (const name of ['会議', '読書', '散歩']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toHaveTextContent(
        new RegExp(`^${name}$`),
      );
    }
  });
});
