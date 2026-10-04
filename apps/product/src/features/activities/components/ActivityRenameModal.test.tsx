import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { ActivityRenameModal } from './ActivityRenameModal';
import { CategoryRenameModal } from './CategoryRenameModal';

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/BillingAccessProvider', () => ({
  useBillingAccess: () => ({ canUseProduct: true }),
}));
vi.mock('../hooks/useActivitiesQuery', () => ({
  useActivities: () => ({ data: [] }),
  useCategories: () => ({ data: [] }),
}));
vi.mock('../hooks/useActivityMutations', () => ({
  useUpdateActivity: () => ({ mutateAsync }),
}));
vi.mock('../hooks/useCategoryMutations', () => ({
  useUpdateCategory: () => ({ mutateAsync }),
}));

beforeEach(() => {
  mutateAsync.mockReset();
  // 実 hook は通知後にも mutateAsync を reject する。ここではその非同期境界を再現する。
  mutateAsync.mockRejectedValueOnce(new Error('Synthetic rename failure'));
  mutateAsync.mockResolvedValueOnce({ id: 'target', name: '変更後' });
});

it.each(['activity', 'category'] as const)(
  '%sの改名失敗を未処理rejectにせず、入力を保持して再試行できる',
  async (kind) => {
    const onClose = vi.fn();
    const target = { id: 'target', name: '変更前' };
    render(
      kind === 'activity' ? (
        <ActivityRenameModal open activity={target} onClose={onClose} />
      ) : (
        <CategoryRenameModal open category={target} onClose={onClose} />
      ),
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'name' });
    await user.clear(input);
    await user.type(input, '変更後');
    const save = screen.getByRole('button', { name: 'actions.save' });
    await user.click(save);

    await waitFor(() => expect(save).toBeEnabled());
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ id: 'target', name: '変更後' });
    expect(input).toHaveValue('変更後');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mutateAsync).toHaveBeenCalledTimes(2);
  },
);
