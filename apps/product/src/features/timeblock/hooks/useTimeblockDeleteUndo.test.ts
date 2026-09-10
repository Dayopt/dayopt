/**
 * 削除の取り消し。カレンダー（キーボード / 右クリック）と Inspector で同じ戻し方にする。
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const restorePlanMutate = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const restoreRecordMutate = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('./useTimeblockWriteMutations', () => ({
  useTimeblockWriteMutations: () => ({
    restorePlan: { mutateAsync: restorePlanMutate },
    restoreRecord: { mutateAsync: restoreRecordMutate },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { useTimeblockDeleteUndo } = await import('./useTimeblockDeleteUndo');

const DELETED = { id: 'timeblock-1', updated_at: '2026-09-10T03:00:05.000Z' };

function undoFromToast() {
  const [, options] = toastSuccess.mock.calls[0] as [string, { action: { onClick: () => void } }];
  options.action.onClick();
}

describe('useTimeblockDeleteUndo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('取り消しつきの削除トーストを出す', () => {
    const { result } = renderHook(() => useTimeblockDeleteUndo());

    result.current('plan', DELETED);

    const [message, options] = toastSuccess.mock.calls[0] as [
      string,
      { action: { label: string } },
    ];
    expect(message).toBe('timeblock.editor.toast.deleted');
    expect(options.action.label).toBe('common.undo');
  });

  it('予定は予定として、削除が返した版で戻す', () => {
    const { result } = renderHook(() => useTimeblockDeleteUndo());
    result.current('plan', DELETED);

    undoFromToast();

    // 削除前の版だと STALE_VERSION で弾かれる
    expect(restorePlanMutate).toHaveBeenCalledWith({
      id: 'timeblock-1',
      expectedUpdatedAt: '2026-09-10T03:00:05.000Z',
    });
    expect(restoreRecordMutate).not.toHaveBeenCalled();
  });

  it('記録は記録として戻す', () => {
    const { result } = renderHook(() => useTimeblockDeleteUndo());
    result.current('record', DELETED);

    undoFromToast();

    expect(restoreRecordMutate).toHaveBeenCalledWith({
      id: 'timeblock-1',
      expectedUpdatedAt: '2026-09-10T03:00:05.000Z',
    });
    expect(restorePlanMutate).not.toHaveBeenCalled();
  });

  it('復元に失敗しても未処理の rejection にしない（知らせるのは mutation 側）', async () => {
    restorePlanMutate.mockRejectedValueOnce(new Error('STALE_VERSION'));
    const { result } = renderHook(() => useTimeblockDeleteUndo());
    result.current('plan', DELETED);

    expect(() => undoFromToast()).not.toThrow();
    await Promise.resolve();
  });
});
