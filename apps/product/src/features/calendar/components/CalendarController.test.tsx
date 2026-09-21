import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canUseProduct: true,
  createTemplateMutate: vi.fn(),
  gateProductAccess: vi.fn(),
  openSettings: vi.fn(),
  openDuplicate: vi.fn(),
  stopSaving: vi.fn(),
}));

vi.mock('@/features/timeblock', () => ({
  createTimeblockDuplicateDraft: vi.fn(),
  deriveTemplateBlocksFromDay: vi.fn(() => []),
  resolveTimeblockDestination: vi.fn(),
  usePlanTemplateMutations: () => ({
    createTemplate: {
      isPending: false,
      mutate: mocks.createTemplateMutate,
    },
  }),
  useTimeblockInspectorStore: (
    selector: (state: { openDuplicate: typeof mocks.openDuplicate }) => unknown,
  ) => selector({ openDuplicate: mocks.openDuplicate }),
}));

vi.mock('@/lib/billing/useProductAccessGate', () => ({
  useProductAccessGate: () => mocks.gateProductAccess,
}));

vi.mock('@/lib/date', () => ({
  getDateKey: () => '2026-03-25',
}));

vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => unknown) =>
    selector({ timezone: 'Asia/Tokyo' }),
}));

vi.mock('@/features/calendar/stores/useTemplateSaveStore', () => ({
  useTemplateSaveStore: (
    selector: (state: {
      savingDateKey: string;
      startSaving: () => void;
      stopSaving: typeof mocks.stopSaving;
    }) => unknown,
  ) =>
    selector({
      savingDateKey: '2026-03-25',
      startSaving: vi.fn(),
      stopSaving: mocks.stopSaving,
    }),
}));

vi.mock('../contexts/CalendarTimeblockActionsContext', () => ({
  CalendarTimeblockActionsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../hooks/keyboard/useCalendarKeyboard', () => ({
  useCalendarKeyboard: vi.fn(),
}));

vi.mock('../hooks/useCalendarContextMenu', () => ({
  useCalendarContextMenu: () => ({
    contextMenuEvent: null,
    contextMenuPosition: null,
    handleCloseContextMenu: vi.fn(),
    handleEventContextMenu: vi.fn(),
  }),
}));

vi.mock('./controller/components', () => ({
  CalendarViewRenderer: () => <div data-testid="calendar-view" />,
}));

vi.mock('./controller/utils', () => ({
  initializePreload: vi.fn(),
}));

vi.mock('./templates/SaveAsTemplateHeader', () => ({
  SaveAsTemplateHeader: ({ onSave }: { onSave: (name: string) => void }) => (
    <button type="button" onClick={() => onSave('仕事の日')}>
      save-template
    </button>
  ),
}));

vi.mock('./layout/CalendarLayout', () => ({
  CalendarLayout: ({
    children,
    headerReplacement,
  }: {
    children: ReactNode;
    headerReplacement?: ReactNode;
  }) => (
    <div>
      {headerReplacement}
      {children}
    </div>
  ),
}));

vi.mock('./views/shared/components', () => ({
  EventContextMenu: () => null,
  MobileTouchHint: () => null,
}));

import { CalendarController } from './CalendarController';

const currentDate = new Date(2026, 2, 25);

function renderController() {
  return render(
    <CalendarController
      viewType="day"
      currentDate={currentDate}
      viewDateRange={{ start: currentDate, end: currentDate, days: [currentDate] }}
      filteredTimeblocks={[]}
      allTimeblocks={[]}
      showWeekends
      disabledTimeblockId={null}
      onTimeblockClick={vi.fn()}
      onTimeRangeSelect={vi.fn()}
      onTimeblockUpdate={vi.fn()}
      onDeleteTimeblock={vi.fn()}
      onDeleteTimeblockConfirm={vi.fn()}
      onViewStats={vi.fn()}
      onCopy={vi.fn()}
      onNavigate={vi.fn()}
      onViewChange={vi.fn()}
      onNavigatePrev={vi.fn()}
      onNavigateNext={vi.fn()}
      onNavigateToday={vi.fn()}
      onDateSelect={vi.fn()}
    />,
  );
}

describe('CalendarController template save access gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUseProduct = true;
    mocks.gateProductAccess.mockImplementation((callback: () => void) => {
      if (mocks.canUseProduct) {
        callback();
        return;
      }
      mocks.openSettings('billing');
    });
  });

  it('利用権があれば保存submitでcreateTemplateを呼ぶ', () => {
    renderController();

    fireEvent.click(screen.getByRole('button', { name: 'save-template' }));

    expect(mocks.createTemplateMutate).toHaveBeenCalledWith(
      { name: '仕事の日', blocks: [] },
      { onSuccess: expect.any(Function) },
    );
    expect(mocks.openSettings).not.toHaveBeenCalled();
  });

  it('利用権がなければcreateTemplateを呼ばず課金設定を開く', () => {
    mocks.canUseProduct = false;
    renderController();

    fireEvent.click(screen.getByRole('button', { name: 'save-template' }));

    expect(mocks.createTemplateMutate).not.toHaveBeenCalled();
    expect(mocks.openSettings).toHaveBeenCalledWith('billing');
  });
});
