import { describe, expect, it, vi } from 'vitest';

import { getTimeblockMenuItems } from './timeblock-menu-items';

describe('getTimeblockMenuItems', () => {
  const noop = vi.fn();

  const keys = (args: Parameters<typeof getTimeblockMenuItems>[0]) =>
    getTimeblockMenuItems(args).map((item) => item.key);

  it('指定された基本操作だけを順番どおり返す', () => {
    expect(
      keys({
        activityId: 'activity-1',
        onViewStats: noop,
        onDuplicate: noop,
        onDelete: noop,
      }),
    ).toEqual(['viewStats', 'duplicate', 'delete']);
  });

  it('アクティビティがなければ振り返りを省き、複製を表示する', () => {
    expect(keys({ onViewStats: noop, onDuplicate: noop })).toEqual(['duplicate']);
  });

  it('ハンドラがなければ項目を返さない', () => {
    expect(keys({})).toEqual([]);
  });
});
