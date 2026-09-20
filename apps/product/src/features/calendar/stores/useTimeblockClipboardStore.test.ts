import { beforeEach, describe, expect, it } from 'vitest';

import type { ClipboardTimeblock } from './useTimeblockClipboardStore';
import { useTimeblockClipboardStore } from './useTimeblockClipboardStore';

const mockTimeblock: ClipboardTimeblock = {
  kind: 'plan',
  title: 'テストタイムブロック',
  description: '説明文',
  duration: 60,
  startHour: 10,
  startMinute: 0,
  activityId: null,
};

describe('useTimeblockClipboardStore', () => {
  beforeEach(() => {
    useTimeblockClipboardStore.getState().clearClipboard();
    useTimeblockClipboardStore.getState().clearLastClickedPosition();
  });

  describe('初期状態', () => {
    it('クリップボードが空', () => {
      const state = useTimeblockClipboardStore.getState();
      expect(state.copiedTimeblock).toBeNull();
      expect(state.lastClickedPosition).toBeNull();
    });

    it('hasCopiedTimeblockがfalse', () => {
      expect(useTimeblockClipboardStore.getState().hasCopiedTimeblock()).toBe(false);
    });
  });

  describe('copyTimeblock', () => {
    it('タイムブロックをコピーできる', () => {
      useTimeblockClipboardStore.getState().copyTimeblock(mockTimeblock);
      expect(useTimeblockClipboardStore.getState().copiedTimeblock).toEqual(mockTimeblock);
    });

    it('hasCopiedTimeblockがtrueになる', () => {
      useTimeblockClipboardStore.getState().copyTimeblock(mockTimeblock);
      expect(useTimeblockClipboardStore.getState().hasCopiedTimeblock()).toBe(true);
    });

    it('上書きコピーできる', () => {
      useTimeblockClipboardStore.getState().copyTimeblock(mockTimeblock);
      const newTimeblock = { ...mockTimeblock, title: '新しいタイムブロック' };
      useTimeblockClipboardStore.getState().copyTimeblock(newTimeblock);
      expect(useTimeblockClipboardStore.getState().copiedTimeblock?.title).toBe(
        '新しいタイムブロック',
      );
    });
  });

  describe('clearClipboard', () => {
    it('クリップボードをクリアできる', () => {
      useTimeblockClipboardStore.getState().copyTimeblock(mockTimeblock);
      useTimeblockClipboardStore.getState().clearClipboard();
      expect(useTimeblockClipboardStore.getState().copiedTimeblock).toBeNull();
      expect(useTimeblockClipboardStore.getState().hasCopiedTimeblock()).toBe(false);
    });
  });

  describe('lastClickedPosition', () => {
    it('位置を設定・取得できる', () => {
      const pos = { date: new Date('2026-03-30') };
      useTimeblockClipboardStore.getState().setLastClickedPosition(pos);
      expect(useTimeblockClipboardStore.getState().lastClickedPosition).toEqual(pos);
    });

    it('位置をクリアできる', () => {
      useTimeblockClipboardStore.getState().setLastClickedPosition({ date: new Date() });
      useTimeblockClipboardStore.getState().clearLastClickedPosition();
      expect(useTimeblockClipboardStore.getState().lastClickedPosition).toBeNull();
    });
  });
});
