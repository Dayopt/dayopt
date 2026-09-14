import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openSheetMock = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'ja',
}));

vi.mock('@/lib/stores/useShellStore', () => ({
  useShellStore: (selector: (state: { openSheet: typeof openSheetMock }) => unknown) =>
    selector({ openSheet: openSheetMock }),
}));

import { DropdownMenu, DropdownMenuContent } from '@dayopt/components';

import { HelpMenuItems } from './UserMenu';

/**
 * HelpMenuItems の onSelect が「選択操作の結果、正しい sheet が最終的に開かれる」
 * という契約を固定する。DropdownMenu を閉じる際の race（#2153 → #2248 で根治、
 * DropdownMenuContent の onCloseAutoFocus で解消）そのものは
 * Sidebar.shortcut-race.test.tsx（#2248）が実際に DropdownMenu を開閉させて
 * 固定しており、この test では扱わない。
 */
describe('HelpMenuItems (#2153)', () => {
  beforeEach(() => {
    openSheetMock.mockClear();
  });

  it('キーボードショートカット選択時、shortcutCheatSheet シートを開く', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <HelpMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByText('navigation.navUser.helpSubmenu.keyboardShortcuts'));

    await waitFor(() => {
      expect(openSheetMock).toHaveBeenCalledWith({ type: 'shortcutCheatSheet' });
    });
  });

  it('お問い合わせ選択時、contact シートを開く', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <HelpMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByText('navigation.navUser.helpSubmenu.contact'));

    await waitFor(() => {
      expect(openSheetMock).toHaveBeenCalledWith({ type: 'contact' });
    });
  });

  it('リリースノートは marketing site の公開ページへリンクし、GitHub へ誘導しない', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <HelpMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    // repository は非公開のため、GitHub Releases へのリンクはログイン済みユーザーにも 404 になる
    const releaseNotes = screen.getByRole('menuitem', {
      name: 'navigation.navUser.helpSubmenu.releaseNotes',
    });
    expect(releaseNotes).toHaveAttribute('href', 'https://dayopt.app/ja/blog/release');

    const hrefs = screen
      .getAllByRole('menuitem')
      .map((item) => item.getAttribute('href'))
      .filter((href): href is string => href !== null);
    expect(hrefs.filter((href) => href.includes('github.com'))).toEqual([]);
  });
});
