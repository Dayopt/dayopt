import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCalendarKeyboard } from './useCalendarKeyboard';
import { useShortcutRegistry } from './useShortcutRegistry';

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

describe('useCalendarKeyboard', () => {
  it('Cmd+7でweekではなく7dayへ切り替える', () => {
    const onViewChange = vi.fn();

    renderHook(() => {
      useShortcutRegistry();
      useCalendarKeyboard({
        viewType: 'day',
        onNavigate: vi.fn(),
        onViewChange,
      });
    });

    fireEvent.keyDown(window, { key: '7', metaKey: true });

    expect(onViewChange).toHaveBeenCalledWith('7day');
    expect(onViewChange).not.toHaveBeenCalledWith('week');
  });
});
