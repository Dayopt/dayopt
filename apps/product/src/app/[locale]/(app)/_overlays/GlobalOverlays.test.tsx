import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useTimeblockInspectorStore } from '@/features/timeblock';
import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';

const navigation = vi.hoisted(() => ({
  pathname: '/ja',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'ja',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/hooks/useUserPreferences', () => ({
  useUserPreferences: (selector: (state: { timezone: string }) => string) =>
    selector({ timezone: 'Asia/Tokyo' }),
}));
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) =>
    loader.toString().includes('TimeblockInspector')
      ? function Inspector({
          onViewActivityDetails,
        }: {
          onViewActivityDetails: (id: string) => void;
        }) {
          return (
            <button onClick={() => onViewActivityDetails('activity-1')}>Activity details</button>
          );
        }
      : () => null,
}));
vi.mock('@/features/calendar', () => ({
  isCalendarViewPath: (path: string) => path === '/' || path === '',
  useCalendarNavigation: () => ({ currentDate: new Date(2026, 8, 6) }),
  useShortcutRegistry: () => undefined,
  useTimeblockSearchShortcut: () => undefined,
  InlineCreatePanel: () => null,
}));
vi.mock('@/features/activities', () => ({
  useActivitiesMap: () => ({
    getActivityById: () => ({
      id: 'activity-1',
      name: 'Writing',
      categoryName: 'Work',
      color: 'blue',
    }),
  }),
}));
vi.mock('@/components/ui/feedback/toast', () => ({ Toaster: () => null }));
vi.mock('@/components/ui/overlays/shortcut-cheat-sheet-dialog', () => ({
  ShortcutCheatSheetDialog: () => null,
}));
vi.mock('./app-shortcut-catalog', () => ({ APP_SHORTCUT_CATALOG: { groups: [], shortcuts: [] } }));
vi.mock('./useTimeblockSearchResultNavigation', () => ({
  useTimeblockSearchResultNavigation: () => vi.fn(),
}));

import { GlobalOverlays } from './GlobalOverlays';

beforeEach(() => {
  vi.clearAllMocks();
  navigation.pathname = '/ja';
  useTimeblockInspectorStore.getState().openInspector('record-1', 'record');
  useActivityDetailStore.getState().close();
});

it('opens activity details in place and closes the inspector', () => {
  render(<GlobalOverlays />);
  fireEvent.click(screen.getByRole('button', { name: 'Activity details' }));
  expect(useActivityDetailStore.getState().target).toEqual({
    activityId: 'activity-1',
    name: 'Writing',
    categoryName: 'Work',
    color: 'blue',
  });
  expect(useActivityDetailStore.getState().isOpen).toBe(true);
  expect(useTimeblockInspectorStore.getState().isOpen).toBe(false);
});
