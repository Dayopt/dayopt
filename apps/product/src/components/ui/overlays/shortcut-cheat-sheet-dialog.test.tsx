import type { ComponentProps } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { IntlErrorCode, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

// このファイルは next-intl の global mock（src/lib/test/setup.ts）を解除し、
// 実 next-intl + 実 messages/{en}/*.json で描画する。vi.unmock はファイル全体に
// hoistされるため、モック版と実messages版を同一ファイルに混在させることはできない。
// namespace 登録漏れ（APP_NAMESPACES への `shortcuts` 追加忘れ）や引数なし
// useTranslations() の見落としは静的チェック（pnpm lint:i18n）の穴になりうるため、
// 実messagesで描画してMISSING_MESSAGEが出ないことを実行時にも二重で確認する
// （旧 docs/projects/_archive/shortcut-catalog-unification/overview.md §8、
// docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
vi.unmock('next-intl');

import type { ShortcutCatalog } from '@/lib/keyboard/shortcut-catalog';
import calendarMessagesEn from '../../../../messages/en/calendar.json';
import shortcutsMessagesEn from '../../../../messages/en/shortcuts.json';
import { ShortcutCheatSheetDialog } from './shortcut-cheat-sheet-dialog';

const MESSAGES = { ...shortcutsMessagesEn, ...calendarMessagesEn };

const CATALOG: ShortcutCatalog = {
  groups: [{ id: 'blocks', labelKey: 'shortcuts.groups.blocks', scope: 'calendar', order: 0 }],
  entries: [
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.copyBlock',
      order: 10,
      keys: ['Cmd+C'],
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.deleteBlock',
      order: 20,
      keys: ['Delete', 'Backspace'],
    },
  ],
};

/** 実messagesのNextIntlClientProviderでdialogを描画する。onErrorはMISSING_MESSAGE検出用。 */
function renderDialog(props: Partial<ComponentProps<typeof ShortcutCheatSheetDialog>> = {}) {
  const onError = vi.fn();
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={MESSAGES} onError={onError}>
      <ShortcutCheatSheetDialog
        open
        onOpenChange={vi.fn()}
        catalog={CATALOG}
        activeScope="calendar"
        platform="mac"
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return onError;
}

function expectNoMissingMessage(onError: ReturnType<typeof vi.fn>) {
  const missing = onError.mock.calls.filter(
    ([error]) => (error as { code?: string }).code === IntlErrorCode.MISSING_MESSAGE,
  );
  expect(missing).toEqual([]);
}

describe('ShortcutCheatSheetDialog', () => {
  it('登録済み操作をplatformに合うキー表記で表示する', () => {
    const onError = renderDialog();

    expect(screen.getByText('Copy the selected timeblock')).toBeInTheDocument();
    expect(screen.getByText('⌘C')).toBeInTheDocument();
    expect(screen.getAllByText('⌫')).toHaveLength(1);
    expectNoMissingMessage(onError);
  });

  it('Escapeで閉じる', () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange, platform: 'other' });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('検索語でラベル表記を絞り込む', () => {
    const catalog: ShortcutCatalog = {
      groups: [
        { id: 'general', labelKey: 'shortcuts.groups.general', scope: 'global', order: 0 },
        { id: 'blocks', labelKey: 'shortcuts.groups.blocks', scope: 'calendar', order: 10 },
      ],
      entries: [
        {
          groupId: 'general',
          labelKey: 'calendar.shortcuts.actions.open',
          order: 0,
          keys: ['Shift+?'],
        },
        {
          groupId: 'blocks',
          labelKey: 'calendar.shortcuts.actions.copyBlock',
          order: 10,
          keys: ['Cmd+C'],
        },
        {
          groupId: 'blocks',
          labelKey: 'calendar.shortcuts.actions.deleteBlock',
          order: 20,
          keys: ['Delete', 'Backspace'],
        },
      ],
    };

    const onError = renderDialog({ catalog });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), {
      target: { value: 'copy' },
    });

    expect(screen.getByText('Copy the selected timeblock')).toBeInTheDocument();
    expect(screen.queryByText('Delete the selected timeblock')).not.toBeInTheDocument();
    expect(screen.queryByText('Open keyboard shortcuts')).not.toBeInTheDocument();
    expectNoMissingMessage(onError);
  });

  it('検索語がキー表記にのみ一致する場合も絞り込む', () => {
    // platform='other'ではCmd+Cが'Ctrl+C'に表記される。ラベル文には'ctrl'を
    // 含む語が無いため、'ctrl'での一致はキー表記側のみで起きる。
    const onError = renderDialog({ platform: 'other' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), {
      target: { value: 'ctrl' },
    });

    expect(screen.getByText('Copy the selected timeblock')).toBeInTheDocument();
    expect(screen.queryByText('Delete the selected timeblock')).not.toBeInTheDocument();
    expectNoMissingMessage(onError);
  });

  it('該当する操作が無い場合はnoResultsを表示する', () => {
    const onError = renderDialog();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), {
      target: { value: 'no-such-shortcut' },
    });

    expect(screen.getByText('No matching shortcuts')).toBeInTheDocument();
    expect(screen.queryByText('Copy the selected timeblock')).not.toBeInTheDocument();
    expectNoMissingMessage(onError);
  });

  it('activeScopeと一致しないgroupはscopeHint付きで後方に並ぶ', () => {
    const catalog: ShortcutCatalog = {
      groups: [
        { id: 'general', labelKey: 'shortcuts.groups.general', scope: 'global', order: 0 },
        { id: 'blocks', labelKey: 'shortcuts.groups.blocks', scope: 'calendar', order: 10 },
      ],
      entries: [
        {
          groupId: 'general',
          labelKey: 'calendar.shortcuts.actions.open',
          order: 0,
          keys: ['Shift+?'],
        },
        {
          groupId: 'blocks',
          labelKey: 'calendar.shortcuts.actions.copyBlock',
          order: 10,
          keys: ['Cmd+C'],
        },
      ],
    };

    // globalスコープが有効な画面（設定・タグ画面等）では、calendar専用groupに
    // 但し書きが付き、generalが先に並ぶ。
    const onError = renderDialog({ catalog, activeScope: 'global' });

    expect(screen.getByText('Available on the calendar screen')).toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    const generalIndex = headings.findIndex((text) => text?.includes('General'));
    const blocksIndex = headings.findIndex((text) => text?.includes('Timeblocks'));
    expect(generalIndex).toBeGreaterThanOrEqual(0);
    expect(blocksIndex).toBeGreaterThan(generalIndex);
    expectNoMissingMessage(onError);
  });

  it('activeScopeに一致するgroupが専用groupとして先頭に並ぶ', () => {
    const catalog: ShortcutCatalog = {
      groups: [
        { id: 'general', labelKey: 'shortcuts.groups.general', scope: 'global', order: 0 },
        { id: 'blocks', labelKey: 'shortcuts.groups.blocks', scope: 'calendar', order: 10 },
      ],
      entries: [
        {
          groupId: 'general',
          labelKey: 'calendar.shortcuts.actions.open',
          order: 0,
          keys: ['Shift+?'],
        },
        {
          groupId: 'blocks',
          labelKey: 'calendar.shortcuts.actions.copyBlock',
          order: 10,
          keys: ['Cmd+C'],
        },
      ],
    };

    // calendar画面ではcalendar専用group（blocks）がgeneralより先に並び、
    // globalスコープのgeneralは常時有効なので但し書きは付かない。
    const onError = renderDialog({ catalog, activeScope: 'calendar' });

    expect(screen.queryByText('Available on the calendar screen')).not.toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    const generalIndex = headings.findIndex((text) => text?.includes('General'));
    const blocksIndex = headings.findIndex((text) => text?.includes('Timeblocks'));
    expect(blocksIndex).toBeGreaterThanOrEqual(0);
    expect(generalIndex).toBeGreaterThan(blocksIndex);
    expectNoMissingMessage(onError);
  });
});
