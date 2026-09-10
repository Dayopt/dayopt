import { beforeEach, describe, expect, it } from 'vitest';

import { useInlineCreateStore } from './useInlineCreateStore';

const mockSelection = {
  date: new Date('2026-03-30'),
  startHour: 10,
  startMinute: 0,
  endHour: 11,
  endMinute: 30,
};

describe('useInlineCreateStore', () => {
  beforeEach(() => {
    useInlineCreateStore.getState().clearPendingSelection();
  });

  describe('初期状態', () => {
    it('pendingSelectionがnull', () => {
      expect(useInlineCreateStore.getState().pendingSelection).toBeNull();
    });
  });

  describe('setPendingSelection', () => {
    it('選択範囲を設定できる', () => {
      useInlineCreateStore.getState().setPendingSelection(mockSelection);
      const state = useInlineCreateStore.getState();
      expect(state.pendingSelection).toEqual(mockSelection);
    });

    it('planned gap 由来の選択元を保持できる', () => {
      useInlineCreateStore
        .getState()
        .setPendingSelection({ ...mockSelection, creationSource: 'planned-gap' });

      expect(useInlineCreateStore.getState().pendingSelection?.creationSource).toBe('planned-gap');
    });

    it('レーン起点を保持できる', () => {
      useInlineCreateStore.getState().setPendingSelection({ ...mockSelection, lane: 'record' });

      expect(useInlineCreateStore.getState().pendingSelection?.lane).toBe('record');
    });

    it('既存の選択を上書きできる', () => {
      useInlineCreateStore.getState().setPendingSelection(mockSelection);
      const newSelection = { ...mockSelection, startHour: 14, endHour: 15 };
      useInlineCreateStore.getState().setPendingSelection(newSelection);
      expect(useInlineCreateStore.getState().pendingSelection?.startHour).toBe(14);
    });
  });

  describe('clearPendingSelection', () => {
    it('選択をクリアできる', () => {
      useInlineCreateStore.getState().setPendingSelection(mockSelection);
      useInlineCreateStore.getState().clearPendingSelection();
      expect(useInlineCreateStore.getState().pendingSelection).toBeNull();
    });
  });

  describe('previewActivityDuration（普段の長さの着せ替え）', () => {
    function setSelection() {
      useInlineCreateStore.getState().setPendingSelection(mockSelection);
    }

    it('ホバー中のアクティビティの長さを選択範囲へ着せる', () => {
      setSelection();

      useInlineCreateStore.getState().previewActivityDuration(120);

      const selection = useInlineCreateStore.getState().pendingSelection;
      expect(selection?.startHour).toBe(10);
      expect(selection?.startMinute).toBe(0);
      expect(selection?.endHour).toBe(12);
      expect(selection?.endMinute).toBe(0);
    });

    it('null を渡すとドラッグで決めた長さ（1 時間 30 分）へ戻す', () => {
      setSelection();
      useInlineCreateStore.getState().previewActivityDuration(120);

      useInlineCreateStore.getState().previewActivityDuration(null);

      const selection = useInlineCreateStore.getState().pendingSelection;
      expect(selection?.endHour).toBe(11);
      expect(selection?.endMinute).toBe(30);
    });

    it('ユーザーが長さを直した後は着せ替えない', () => {
      setSelection();
      // 時刻入力 / リサイズで 10:00–10:15 にした
      useInlineCreateStore.getState().updateSelectionTimes({ endHour: 10, endMinute: 15 });

      useInlineCreateStore.getState().previewActivityDuration(120);

      const selection = useInlineCreateStore.getState().pendingSelection;
      expect(selection?.endHour).toBe(10);
      expect(selection?.endMinute).toBe(15);
    });

    it('長さを保ったまま位置だけ動かす操作は着せ替えを止めない', () => {
      setSelection();
      // long-press 移動: 10:00–11:30 → 13:00–14:30（長さは 90 分のまま）
      useInlineCreateStore
        .getState()
        .updateSelectionTimes({ startHour: 13, startMinute: 0, endHour: 14, endMinute: 30 });

      useInlineCreateStore.getState().previewActivityDuration(120);

      const selection = useInlineCreateStore.getState().pendingSelection;
      expect(selection?.endHour).toBe(15);
      expect(selection?.endMinute).toBe(0);
    });

    it('日をまたがないよう 23:59 でクランプする', () => {
      useInlineCreateStore.getState().setPendingSelection({
        ...mockSelection,
        startHour: 23,
        startMinute: 0,
        endHour: 23,
        endMinute: 30,
      });

      useInlineCreateStore.getState().previewActivityDuration(180);

      const selection = useInlineCreateStore.getState().pendingSelection;
      expect(selection?.endHour).toBe(23);
      expect(selection?.endMinute).toBe(59);
    });

    it('選択が無い時は何も起きない', () => {
      useInlineCreateStore.getState().previewActivityDuration(120);

      expect(useInlineCreateStore.getState().pendingSelection).toBeNull();
    });
  });
});
