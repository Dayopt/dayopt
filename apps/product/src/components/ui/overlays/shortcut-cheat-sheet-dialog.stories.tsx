import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { ShortcutCatalog } from '@/lib/keyboard/shortcut-catalog';
import { ShortcutCheatSheetDialog } from './shortcut-cheat-sheet-dialog';

const CATALOG: ShortcutCatalog = {
  groups: [
    { id: 'general', labelKey: 'shortcuts.groups.general', scope: 'global', order: 0 },
    {
      id: 'navigation',
      labelKey: 'shortcuts.groups.navigation',
      scope: 'calendar',
      order: 10,
    },
    { id: 'views', labelKey: 'shortcuts.groups.views', scope: 'calendar', order: 20 },
    { id: 'blocks', labelKey: 'shortcuts.groups.blocks', scope: 'calendar', order: 30 },
  ],
  entries: [
    {
      groupId: 'general',
      labelKey: 'calendar.shortcuts.actions.open',
      order: 0,
      keys: ['Shift+?'],
    },
    {
      groupId: 'general',
      labelKey: 'calendar.shortcuts.actions.openSearch',
      order: 10,
      keys: ['Cmd+K'],
    },
    {
      groupId: 'navigation',
      labelKey: 'calendar.shortcuts.actions.previousPeriod',
      order: 10,
      keys: ['Cmd+ArrowLeft'],
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.dayView',
      order: 100,
      keys: ['Cmd+1', '1'],
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.copyBlock',
      order: 220,
      keys: ['Cmd+C'],
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.deleteBlock',
      order: 240,
      keys: ['Delete', 'Backspace'],
    },
  ],
};

const meta = {
  title: 'Product/Components/Overlays/ShortcutCheatSheetDialog',
  component: ShortcutCheatSheetDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    onOpenChange: fn(),
    catalog: CATALOG,
    activeScope: 'calendar',
    platform: 'mac',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ShortcutCheatSheetDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** calendar画面で開いた状態。calendar専用グループ（navigation/views/blocks）が先に並ぶ。 */
export const Default: Story = {};

/** calendar以外の画面で開いた状態。generalが先に並び、calendar専用グループは淡色 + 但し書き表示になる。 */
export const GlobalScope: Story = {
  args: { activeScope: 'global' },
};

/** Windows / Linux向けキー表記。 */
export const OtherPlatform: Story = {
  args: { platform: 'other' },
};

/** 検索語でラベル・キー表記を絞り込む。Dialogはportal描画のためdocument.bodyから探す。 */
export const Search: Story = {
  play: async () => {
    const body = within(document.body);
    const input = await body.findByRole('searchbox', { name: 'ショートカットを検索' });
    await userEvent.type(input, 'コピー');

    await expect(body.getByText('選択中のタイムブロックをコピー')).toBeInTheDocument();
    await expect(body.queryByText('選択中のタイムブロックを削除')).not.toBeInTheDocument();
  },
};

/** 該当する操作が無い場合の表示。 */
export const NoResults: Story = {
  play: async () => {
    const body = within(document.body);
    const input = await body.findByRole('searchbox', { name: 'ショートカットを検索' });
    await userEvent.type(input, 'zzz');

    await expect(body.getByText('該当するショートカットがありません')).toBeInTheDocument();
  },
};

/** 全パターン一覧。activeScopeをglobalにし、淡色 + 但し書き表示も含めて確認する。 */
export const AllPatterns: Story = {
  args: { activeScope: 'global' },
};
