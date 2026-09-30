import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@dayopt/components', () => ({
  cn: (...values: unknown[]) => values.filter((value) => typeof value === 'string').join(' '),
  Drawer: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div data-testid="side-rail-drawer">{children}</div> : null,
  DrawerContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DrawerDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DrawerHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  InlineBanner: () => null,
}));

vi.mock('@/components/shell/AppHeader', () => ({
  AppHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/navigation/DateNavigator', () => ({
  DateNavigator: () => null,
}));

vi.mock('@/lib/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (
    selector: (state: { showWeekNumbers: boolean; weekStartsOn: 1 }) => unknown,
  ) => selector({ showWeekNumbers: false, weekStartsOn: 1 }),
}));

vi.mock('@/lib/hooks/useSwipeGesture', () => ({
  useSwipeGesture: () => ({
    handlers: {
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
    },
    ref: { current: null },
  }),
}));

vi.mock('./Header/DateRangeDisplay', () => ({
  DateRangeDisplay: () => null,
}));

vi.mock('./Header/MobileCalendarHeader', () => ({
  MobileCalendarHeader: () => null,
}));

vi.mock('./Header/ViewSwitcher', () => ({
  ViewSwitcher: () => null,
}));

import {
  CalendarLayout,
  canRecoverSideRailSpace,
  resolveSideRailMaxWidth,
  shouldUseSideRailSheet,
} from './CalendarLayout';

const RECOVERY_SETTLE_MS = 240;
let measuredLayoutWidth = 900;
let resizeObserverCallback: ResizeObserverCallback | null = null;

function createRect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height: 800,
    top: 0,
    right: width,
    bottom: 800,
    left: 0,
    toJSON: () => ({}),
  };
}

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function emitLayoutWidth(width: number) {
  measuredLayoutWidth = width;
  act(() => {
    resizeObserverCallback?.(
      [{ contentRect: createRect(width) } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

function renderCalendarLayout({
  sideRailOpen = true,
  recoverableSidebarWidth = 256,
  onSideRailSpaceRecoveryChange,
}: {
  sideRailOpen?: boolean;
  recoverableSidebarWidth?: number;
  onSideRailSpaceRecoveryChange: (recovering: boolean) => void;
}) {
  return (
    <CalendarLayout
      viewType="week"
      currentDate={new Date(2026, 2, 25)}
      onNavigate={vi.fn()}
      onViewChange={vi.fn()}
      sideRail={<div>Review rail</div>}
      sideRailOpen={sideRailOpen}
      recoverableSidebarWidth={recoverableSidebarWidth}
      onSideRailSpaceRecoveryChange={onSideRailSpaceRecoveryChange}
    >
      <div>Calendar content</div>
    </CalendarLayout>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  measuredLayoutWidth = 900;
  resizeObserverCallback = null;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    createRect(measuredLayoutWidth),
  );
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shouldUseSideRailSheet', () => {
  it('keeps the desktop rail when the remaining Calendar content is 768px', () => {
    expect(
      shouldUseSideRailSheet({
        layoutWidth: 1024,
        sideRailWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(false);
  });

  it('switches to sheet when the remaining Calendar content is below 768px', () => {
    expect(
      shouldUseSideRailSheet({
        layoutWidth: 1023,
        sideRailWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(true);
  });

  it('uses the actual resized rail width', () => {
    expect(
      shouldUseSideRailSheet({
        layoutWidth: 1100,
        sideRailWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(false);
    expect(
      shouldUseSideRailSheet({
        layoutWidth: 1100,
        sideRailWidth: 560,
        minContentWidth: 768,
      }),
    ).toBe(true);
  });

  it('keeps the rail before page measurement is available', () => {
    expect(
      shouldUseSideRailSheet({
        layoutWidth: null,
        sideRailWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(false);
  });
});

describe('canRecoverSideRailSpace', () => {
  it('returns true when closing sidebar can recover enough page width', () => {
    expect(
      canRecoverSideRailSpace({
        layoutWidth: 900,
        sideRailWidth: 256,
        recoverableWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(true);
  });

  it('returns false when closing sidebar is still not enough', () => {
    expect(
      canRecoverSideRailSpace({
        layoutWidth: 720,
        sideRailWidth: 256,
        recoverableWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(false);
  });

  it('accounts for the actual resized rail width', () => {
    expect(
      canRecoverSideRailSpace({
        layoutWidth: 1024,
        sideRailWidth: 560,
        recoverableWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(false);
  });
});

describe('resolveSideRailMaxWidth', () => {
  it('caps resize at the width that preserves 768px of Calendar content', () => {
    expect(
      resolveSideRailMaxWidth({
        layoutWidth: 1024,
        recoverableWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(512);
  });

  it('keeps the rail within its fixed minimum and maximum', () => {
    expect(
      resolveSideRailMaxWidth({
        layoutWidth: 720,
        recoverableWidth: 0,
        minContentWidth: 768,
      }),
    ).toBe(256);
    expect(
      resolveSideRailMaxWidth({
        layoutWidth: 1400,
        recoverableWidth: 256,
        minContentWidth: 768,
      }),
    ).toBe(560);
  });
});

describe('CalendarLayout side rail space recovery', () => {
  it.each(['pointerup', 'pointercancel', 'unmount', 'close'] as const)(
    'releases resizing and body styles after %s',
    (interruption) => {
      measuredLayoutWidth = 1400;
      const onRecoveryChange = vi.fn();
      const { unmount, rerender } = render(
        renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }),
      );
      document.body.style.cursor = 'crosshair';
      document.body.style.userSelect = 'text';
      try {
        fireEvent.pointerDown(screen.getByRole('separator'), { button: 0, clientX: 500 });
        fireEvent.pointerMove(window, { clientX: 440 });
        expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '316');
        expect(document.body.style.userSelect).toBe('none');

        if (interruption === 'unmount') unmount();
        else if (interruption === 'close') {
          rerender(
            renderCalendarLayout({
              sideRailOpen: false,
              onSideRailSpaceRecoveryChange: onRecoveryChange,
            }),
          );
        } else if (interruption === 'pointerup') fireEvent.pointerUp(window);
        else fireEvent.pointerCancel(window);

        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
        fireEvent.pointerMove(window, { clientX: 400 });
        if (interruption !== 'unmount') {
          rerender(renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }));
          expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '316');
        }
      } finally {
        fireEvent.pointerUp(window);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    },
  );

  it('requests suppression once, settles, and restores when the rail closes', () => {
    const onRecoveryChange = vi.fn();
    const { rerender } = render(
      renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }),
    );

    expect(onRecoveryChange).toHaveBeenCalledTimes(1);
    expect(onRecoveryChange).toHaveBeenLastCalledWith(true);

    emitLayoutWidth(1156);
    act(() => vi.advanceTimersByTime(RECOVERY_SETTLE_MS));

    expect(onRecoveryChange).toHaveBeenCalledTimes(1);

    rerender(
      renderCalendarLayout({
        sideRailOpen: false,
        onSideRailSpaceRecoveryChange: onRecoveryChange,
      }),
    );

    expect(onRecoveryChange).toHaveBeenCalledTimes(2);
    expect(onRecoveryChange).toHaveBeenLastCalledWith(false);

    act(() => vi.advanceTimersByTime(RECOVERY_SETTLE_MS));
    expect(onRecoveryChange).toHaveBeenCalledTimes(2);
  });

  it('restores a suppressed Sidebar when CalendarLayout unmounts', () => {
    const onRecoveryChange = vi.fn();
    const { unmount } = render(
      renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }),
    );

    expect(onRecoveryChange).toHaveBeenCalledWith(true);
    emitLayoutWidth(1156);
    act(() => vi.advanceTimersByTime(RECOVERY_SETTLE_MS));

    unmount();

    expect(onRecoveryChange).toHaveBeenLastCalledWith(false);
    expect(onRecoveryChange).toHaveBeenCalledTimes(2);
  });

  it('caps a resized rail and suppresses Sidebar instead of trapping it in a sheet', () => {
    measuredLayoutWidth = 1024;
    const onRecoveryChange = vi.fn();
    render(renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }));

    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-valuenow', '256');
    expect(separator).toHaveAttribute('aria-valuemax', '512');

    fireEvent.keyDown(separator, { key: 'End' });

    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '512');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRecoveryChange).toHaveBeenCalledOnce();
    expect(onRecoveryChange).toHaveBeenCalledWith(true);
  });

  it('reclamps an expanded rail when the viewport narrows', () => {
    measuredLayoutWidth = 1400;
    const onRecoveryChange = vi.fn();
    render(renderCalendarLayout({ onSideRailSpaceRecoveryChange: onRecoveryChange }));

    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '560');

    emitLayoutWidth(900);

    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuemax', '388');
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '388');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRecoveryChange).toHaveBeenCalledWith(true);
  });
});
