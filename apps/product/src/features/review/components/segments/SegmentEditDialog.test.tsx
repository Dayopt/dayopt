import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentEditDialog } from './SegmentEditDialog';
vi.mock('@/features/activities', () => ({
  useActivityTree: () => ({ data: { categories: [], uncategorized: [] } }),
}));
describe('segment input recovery', () => {
  it('keeps input after rejection and closes only after a successful manual resubmit', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access ended'))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(
      <SegmentEditDialog
        open
        onOpenChange={onOpenChange}
        title="Save segment"
        initialName="Original"
        initialActivityIds={['activity-1']}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Unsaved name')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSubmit).toHaveBeenLastCalledWith({
      name: 'Unsaved name',
      activityIds: ['activity-1'],
    });
  });
});
