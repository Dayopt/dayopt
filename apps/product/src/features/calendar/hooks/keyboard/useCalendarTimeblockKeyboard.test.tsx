import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShortcutDef } from '@/lib/keyboard/shortcut-registry';

import { useCalendarEventKeyboard } from './useCalendarTimeblockKeyboard';

const mocks = vi.hoisted(() => ({
  closeInspector: vi.fn(),
  createPlan: { mutateAsync: vi.fn() },
  createRecord: { mutateAsync: vi.fn() },
  registerShortcuts: vi.fn(),
  shortcuts: [] as ShortcutDef[],
  timeblockId: 'plan-1',
}));

vi.mock('@/lib/keyboard/shortcut-registry', () => ({
  registerShortcuts: mocks.registerShortcuts,
}));

vi.mock('@/features/timeblock', () => ({
  resolveTimeblockDestination: vi.fn(),
  useTimeblockInspectorStore: () => ({
    closeInspector: mocks.closeInspector,
    isOpen: true,
    openInspector: vi.fn(),
    timeblockId: mocks.timeblockId,
  }),
  useTimeblockWriteMutations: () => ({
    createPlan: mocks.createPlan,
    createRecord: mocks.createRecord,
  }),
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => string) =>
    selector({ timezone: 'UTC' }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

function getDeleteHandler(): ShortcutDef['handler'] {
  const shortcut = mocks.shortcuts.find((candidate) => candidate.key === 'Delete');
  if (!shortcut) throw new Error('Delete shortcut was not registered');
  return shortcut.handler;
}

describe('useCalendarEventKeyboard delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shortcuts = [];
    mocks.timeblockId = 'plan-1';
    mocks.registerShortcuts.mockImplementation((shortcuts: ShortcutDef[]) => {
      mocks.shortcuts = shortcuts;
      return vi.fn();
    });
  });

  it('Timeblockのコピーと貼り付けショートカットを登録しない', () => {
    renderHook(() => useCalendarEventKeyboard({}));

    const keys = mocks.shortcuts.map((shortcut) => shortcut.key);
    expect(keys).not.toContain('Cmd+C');
    expect(keys).not.toContain('Cmd+V');
  });

  it('CAS conflictで削除されなかった時はInspectorを閉じない', async () => {
    const onDeleteTimeblock = vi.fn().mockResolvedValue(false);
    renderHook(() => useCalendarEventKeyboard({ onDeleteTimeblock }));

    await act(async () => {
      getDeleteHandler()({ preventDefault: vi.fn() } as unknown as KeyboardEvent);
      await Promise.resolve();
    });

    expect(onDeleteTimeblock).toHaveBeenCalledWith('plan-1');
    expect(mocks.closeInspector).not.toHaveBeenCalled();
  });

  it('削除成功後にだけInspectorを閉じる', async () => {
    const onDeleteTimeblock = vi.fn().mockResolvedValue(true);
    renderHook(() => useCalendarEventKeyboard({ onDeleteTimeblock }));

    await act(async () => {
      getDeleteHandler()({ preventDefault: vi.fn() } as unknown as KeyboardEvent);
      await Promise.resolve();
    });

    expect(mocks.closeInspector).toHaveBeenCalledTimes(1);
  });

  it('削除待ちの間に別Timeblockを開いた場合は新しいInspectorを閉じない', async () => {
    let resolveDelete!: (deleted: boolean) => void;
    const onDeleteTimeblock = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const { rerender } = renderHook(() => useCalendarEventKeyboard({ onDeleteTimeblock }));

    act(() => {
      getDeleteHandler()({ preventDefault: vi.fn() } as unknown as KeyboardEvent);
    });
    mocks.timeblockId = 'plan-2';
    rerender();

    await act(async () => resolveDelete(true));

    expect(onDeleteTimeblock).toHaveBeenCalledWith('plan-1');
    expect(mocks.closeInspector).not.toHaveBeenCalled();
  });
});
