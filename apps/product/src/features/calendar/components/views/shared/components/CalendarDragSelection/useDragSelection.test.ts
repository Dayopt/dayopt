import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useDragSelection } from './useDragSelection';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../../../../../hooks/accessibility/useHapticFeedback', () => ({
  useHapticFeedback: () => ({ tap: vi.fn() }),
}));

describe('useDragSelection document listeners', () => {
  it('keeps mousemove subscribed across frames and advances a 15-minute preview to 30 minutes', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    const onTimeRangeSelect = vi.fn();
    const { result } = renderHook(() =>
      useDragSelection({
        date: new Date('2099-01-15T00:00:00'),
        hourHeight: 60,
        defaultDuration: 30,
        timeFormat: '24h',
        onTimeRangeSelect,
      }),
    );
    const container = document.createElement('div');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 100,
      bottom: 1440,
      width: 100,
      height: 1440,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    result.current.containerRef.current = container;

    act(() => {
      result.current.handleMouseDown({
        button: 0,
        clientY: 540,
        currentTarget: container,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.MouseEvent);
    });

    const moveMouseAndWaitForFrames = async (clientY: number) => {
      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientY }));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
    };

    await moveMouseAndWaitForFrames(552);
    expect(result.current.selection).toMatchObject({
      startHour: 9,
      startMinute: 0,
      endHour: 9,
      endMinute: 15,
    });

    await moveMouseAndWaitForFrames(564);
    expect(result.current.selection).toMatchObject({
      startHour: 9,
      startMinute: 0,
      endHour: 9,
      endMinute: 30,
    });

    act(() => document.dispatchEvent(new MouseEvent('mouseup')));
    expect(onTimeRangeSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        startHour: 9,
        startMinute: 0,
        endHour: 9,
        endMinute: 30,
        durationSource: 'dragged',
      }),
    );

    const mousemoveSubscriptions = () =>
      addListener.mock.calls.filter(([type]) => type === 'mousemove').length;
    expect(mousemoveSubscriptions()).toBe(1);
  });
});
