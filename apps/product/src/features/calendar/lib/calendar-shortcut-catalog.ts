/**
 * Calendar Shortcut Catalog
 *
 * calendar画面で有効なショートカットの宣言。「何が存在するか」だけを持ち、
 * キーとハンドラの結び付けは hooks/keyboard/ 配下の各hookが持つ。
 */

import type { ShortcutCatalog } from '@/lib/keyboard/shortcut-catalog';

export const CALENDAR_SHORTCUT_CATALOG: ShortcutCatalog = {
  groups: [
    {
      id: 'navigation',
      labelKey: 'shortcuts.groups.navigation',
      scope: 'calendar',
      order: 10,
    },
    {
      id: 'views',
      labelKey: 'shortcuts.groups.views',
      scope: 'calendar',
      order: 20,
    },
    {
      id: 'blocks',
      labelKey: 'shortcuts.groups.blocks',
      scope: 'calendar',
      order: 30,
    },
  ],
  entries: [
    // navigation
    {
      groupId: 'navigation',
      labelKey: 'calendar.shortcuts.actions.previousPeriod',
      keys: ['Cmd+ArrowLeft'],
      order: 10,
    },
    {
      groupId: 'navigation',
      labelKey: 'calendar.shortcuts.actions.nextPeriod',
      keys: ['Cmd+ArrowRight'],
      order: 20,
    },
    {
      groupId: 'navigation',
      labelKey: 'calendar.shortcuts.actions.today',
      keys: ['Cmd+T'],
      order: 30,
    },
    // views
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.dayView',
      keys: ['Cmd+1', '1'],
      order: 100,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.weekView',
      keys: ['W'],
      order: 105,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.twoDayView',
      keys: ['2'],
      order: 110,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.threeDayView',
      keys: ['Cmd+3', '3'],
      order: 120,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.fourDayView',
      keys: ['4'],
      order: 130,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.fiveDayView',
      keys: ['Cmd+5', '5'],
      order: 140,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.sixDayView',
      keys: ['6'],
      order: 150,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.sevenDayView',
      keys: ['Cmd+7', '7'],
      order: 160,
    },
    {
      groupId: 'views',
      labelKey: 'calendar.shortcuts.actions.toggleWeekends',
      keys: ['Cmd+W'],
      order: 170,
    },
    // blocks
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.createBlock',
      keys: ['C'],
      order: 200,
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.createBlockNow',
      keys: ['Shift+C'],
      order: 210,
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.copyBlock',
      keys: ['Cmd+C'],
      order: 220,
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.pasteBlock',
      keys: ['Cmd+V'],
      order: 230,
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.deleteBlock',
      keys: ['Delete', 'Backspace'],
      order: 240,
    },
    {
      groupId: 'blocks',
      labelKey: 'calendar.shortcuts.actions.closeInspector',
      keys: ['Escape'],
      order: 250,
    },
  ],
};
