import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useTimeblockInspectorStore } from '@/features/timeblock';

const navigation = vi.hoisted(() => ({
  pathname: '/ja/calendar',
  push: vi.fn(),
  buildReportPath: vi.fn(() => '/ja/report?date=2026-09-06'),
  date: new Date(2026, 8, 6),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
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
      ? function Inspector({ onViewStats }: { onViewStats: (id: string) => void }) {
          return <button onClick={() => onViewStats('activity-1')}>Review</button>;
        }
      : () => null,
}));
vi.mock('@/features/calendar', () => ({
  buildReportPath: navigation.buildReportPath,
  isCalendarViewPath: (path: string) => path === '/calendar',
  useCalendarNavigation: () => ({ currentDate: navigation.date }),
  useShortcutRegistry: () => undefined,
  useTimeblockSearchShortcut: () => undefined,
  useTimeblockClipboardStore: () => vi.fn(),
  InlineCreatePanel: () => null,
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
  navigation.pathname = '/ja/calendar';
  useTimeblockInspectorStore.getState().openInspector('record-1', 'record');
});

it('振り返りへの遷移を開始した時はInspectorを閉じず、遷移完了後に閉じる', () => {
  const { rerender } = render(<GlobalOverlays />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(navigation.buildReportPath).toHaveBeenCalledWith('ja', navigation.date);
  expect(navigation.push).toHaveBeenCalledWith('/ja/report?date=2026-09-06');
  // 遷移中に閉じると URL 同期の replaceState が router.push を上書きする。
  expect(useTimeblockInspectorStore.getState().isOpen).toBe(true);

  navigation.pathname = '/ja/report';
  rerender(<GlobalOverlays />);
  expect(useTimeblockInspectorStore.getState().isOpen).toBe(false);
});
