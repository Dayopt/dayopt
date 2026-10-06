import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.hoisted(() => vi.fn(() => '/projects'));
const bannerState = vi.hoisted(() => ({
  current: { visible: true, message: 'Payment required' },
}));

vi.mock('@dayopt/i18n/navigation', () => ({
  usePathname: pathnameMock,
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));

vi.mock('@/features/calendar', () => ({
  isCalendarViewPath: (pathname: string) => pathname === '/' || pathname === '',
  formatCalendarDateParam: () => '2026-03-25',
  useCalendarNavigation: () => null,
  ActivityChipRow: () => <div data-testid="activity-chip-row" />,
}));

vi.mock('@/lib/user', () => ({
  getAvatarUrl: () => null,
  getDisplayName: () => 'User',
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: {
    use: {
      sidebar: () => ({ open: true, width: 256 }),
      sidebarSuppressed: () => false,
      toggleSidebar: () => vi.fn(),
      pageTitle: () => 'Page title',
    },
  },
}));

vi.mock('@/components/shell/AnimatedWidthPanel', () => ({
  // `data-panel` など呼び出し側が付けた属性はそのまま通す（右側のパネルが 2 枚あるので、
  // 並び順ではなく属性で選べる必要がある）
  AnimatedWidthPanel: ({
    children,
    open,
    width,
    ...rest
  }: {
    children: React.ReactNode;
    open?: boolean;
    width?: number;
  } & Record<string, unknown>) => (
    // 幅は本物では inline style。mock では属性で見えるようにする（可変幅のパネルがあるため）
    <aside data-open={open} data-width={width} {...pickDataAttributes(rest)}>
      {children}
    </aside>
  ),
}));

/** mock へ渡された props のうち `data-*` だけを DOM へ流す。 */
function pickDataAttributes(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-')));
}

vi.mock('@/components/shell/sidebar', () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./SidebarContent', () => ({
  SidebarContent: () => <div>Sidebar</div>,
}));

vi.mock('./MobileAccountButton', () => ({
  ConnectedMobileAccountButton: () => <button type="button">Account</button>,
}));

vi.mock('./useAppInlineBanner', () => ({
  useAppInlineBanner: () => bannerState.current,
}));

import { useTimeblockInspectorStore } from '@/features/timeblock';
import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';

import { DesktopLayout } from './desktop-layout';
import { MobileLayout } from './mobile-layout';

function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
}

function expectSingleVisibleBanner(container: HTMLElement) {
  expect(container.querySelectorAll('[data-slot="inline-banner"]')).toHaveLength(1);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Payment required');
  return alert;
}

describe('DesktopLayout', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/projects');
    bannerState.current = { visible: true, message: 'Payment required' };
  });

  it('shows one banner between the shell header and main content on a normal route', () => {
    const { container } = render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    const header = screen.getByRole('banner');
    const alert = expectSingleVisibleBanner(container);
    const main = screen.getByRole('main');

    expectBefore(header, alert);
    expectBefore(alert, main);
  });

  it('keeps one banner before home content and omits the shell header', () => {
    pathnameMock.mockReturnValue('/');

    const { container } = render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    const alert = expectSingleVisibleBanner(container);
    expectBefore(alert, screen.getByRole('main'));
  });

  it.each(['/projects', '/settings'])('keeps the shell header on %s', (pathname) => {
    pathnameMock.mockReturnValue(pathname);

    render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('keeps a single hidden banner container out of the accessibility tree', () => {
    bannerState.current = { visible: false, message: '' };

    const { container } = render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    expect(container.querySelectorAll('[data-slot="inline-banner"]')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the inspector as a 3rd column that opens when the inspector store opens', () => {
    act(() => useTimeblockInspectorStore.getState().closeInspector());

    const { container } = render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    // 右側のパネルは 2 枚あるので、並び順ではなく `data-panel` で選ぶ。
    const inspector = () => container.querySelector('[data-panel="timeblock-inspector"]');
    expect(inspector()?.getAttribute('data-open')).toBe('false');

    act(() => useTimeblockInspectorStore.getState().openInspector('timeblock-1', 'plan'));
    expect(inspector()?.getAttribute('data-open')).toBe('true');

    act(() => useTimeblockInspectorStore.getState().closeInspector());
  });

  it('renders the activity detail panel as a separate column driven by the activity store', () => {
    act(() => useActivityDetailStore.getState().close());

    const { container } = render(
      <DesktopLayout>
        <div>Content</div>
      </DesktopLayout>,
    );

    const detail = () => container.querySelector('[data-panel="activity-detail"]');
    const inspector = () => container.querySelector('[data-panel="timeblock-inspector"]');
    expect(detail()?.getAttribute('data-open')).toBe('false');

    act(() => useActivityDetailStore.getState().open({ activityId: 'act-1', name: 'Writing' }));

    expect(detail()?.getAttribute('data-open')).toBe('true');
    // Detail panel and inspector are mutually exclusive.
    expect(inspector()?.getAttribute('data-open')).toBe('false');

    act(() => useActivityDetailStore.getState().close());
  });
});

describe('MobileLayout', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/projects');
    bannerState.current = { visible: true, message: 'Payment required' };
  });

  it('shows one banner between the shell header and main content on a normal route', () => {
    const { container } = render(
      <MobileLayout>
        <div>Content</div>
      </MobileLayout>,
    );

    const header = screen.getByRole('banner');
    const alert = expectSingleVisibleBanner(container);
    const main = screen.getByRole('main');

    expectBefore(header, alert);
    expectBefore(alert, main);
  });

  it.each(['/', '/settings', '/settings/billing'])(
    'shows one banner before main content and omits the shell header on %s',
    (pathname) => {
      pathnameMock.mockReturnValue(pathname);

      const { container } = render(
        <MobileLayout>
          <div>Own header content</div>
        </MobileLayout>,
      );

      expect(screen.queryByRole('banner')).not.toBeInTheDocument();
      const alert = expectSingleVisibleBanner(container);
      expectBefore(alert, screen.getByRole('main'));
      expect(screen.queryAllByTestId('activity-chip-row')).toHaveLength(pathname === '/' ? 1 : 0);
    },
  );

  it.each(['/', '/projects'])(
    'does not show the calendar toggle in the shell header on %s',
    (pathname) => {
      pathnameMock.mockReturnValue(pathname);

      render(
        <MobileLayout>
          <div>Content</div>
        </MobileLayout>,
      );

      expect(
        screen.queryByRole('link', { name: 'calendar.actions.openCalendar' }),
      ).not.toBeInTheDocument();
    },
  );

  it('keeps a single hidden banner container out of the accessibility tree', () => {
    bannerState.current = { visible: false, message: '' };

    const { container } = render(
      <MobileLayout>
        <div>Content</div>
      </MobileLayout>,
    );

    expect(container.querySelectorAll('[data-slot="inline-banner"]')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
