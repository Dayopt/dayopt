import { beforeEach, describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../types/calendar.types';

import { useCalendarDragStore } from './useCalendarDragStore';

const mockCalendarEvent: CalendarDisplayEvent = {
  id: 'plan-1',
  title: 'テストプラン',
  startDate: new Date('2026-02-21T10:00:00'),
  endDate: new Date('2026-02-21T11:00:00'),
  color: 'blue',
  version: '2026-07-15T00:00:00.000000Z',
  displayStartDate: new Date('2026-02-21T10:00:00'),
  displayEndDate: new Date('2026-02-21T11:00:00'),
  duration: 60,
  isMultiDay: false,
  kind: 'plan',
};

describe('useCalendarDragStore', () => {
  beforeEach(() => {
    useCalendarDragStore.getState().endDrag();
  });

  describe('初期状態', () => {
    it('ドラッグしていない', () => {
      const state = useCalendarDragStore.getState();
      expect(state.isDragging).toBe(false);
      expect(state.draggedEntryId).toBeNull();
    });
  });

  describe('startDrag', () => {
    it('カレンダー内ドラッグを開始できる', () => {
      useCalendarDragStore.getState().startDrag('plan-1', mockCalendarEvent, 2, 'plan');
      const state = useCalendarDragStore.getState();
      expect(state.isDragging).toBe(true);
      expect(state.draggedEntryId).toBe('plan-1');
      expect(state.draggedEntry).toEqual(mockCalendarEvent);
      expect(state.originalDateIndex).toBe(2);
      expect(state.targetDateIndex).toBe(2);
      expect(state.sourceLane).toBe('plan');
      expect(state.targetLane).toBe('plan');
    });
  });

  describe('updateDrag', () => {
    it('ドラッグ中の状態を部分更新できる', () => {
      useCalendarDragStore.getState().startDrag('plan-1', mockCalendarEvent, 0);
      useCalendarDragStore.getState().updateDrag({ targetDateIndex: 3 });
      expect(useCalendarDragStore.getState().targetDateIndex).toBe(3);
      expect(useCalendarDragStore.getState().draggedEntryId).toBe('plan-1');
    });

    it('ターゲット日付を更新できる', () => {
      useCalendarDragStore.getState().startDrag('plan-1', mockCalendarEvent, 0);
      useCalendarDragStore.getState().updateDrag({ targetDateIndex: 5 });
      expect(useCalendarDragStore.getState().targetDateIndex).toBe(5);
    });

    it('ドロップ先レーンを更新できる', () => {
      useCalendarDragStore.getState().startDrag('plan-1', mockCalendarEvent, 0, 'plan');
      useCalendarDragStore.getState().updateDrag({ targetLane: 'record' });
      expect(useCalendarDragStore.getState().targetLane).toBe('record');
    });

    it('プレビュー時間を設定できる', () => {
      const time = {
        start: new Date('2026-02-21T14:00:00'),
        end: new Date('2026-02-21T15:00:00'),
      };
      useCalendarDragStore.getState().updateDrag({ previewTime: time });
      expect(useCalendarDragStore.getState().previewTime).toEqual(time);
    });

    it('nullでクリアできる', () => {
      useCalendarDragStore.getState().updateDrag({
        previewTime: { start: new Date(), end: new Date() },
      });
      useCalendarDragStore.getState().updateDrag({ previewTime: null });
      expect(useCalendarDragStore.getState().previewTime).toBeNull();
    });
  });

  describe('endDrag', () => {
    it('ドラッグ状態を初期化できる', () => {
      useCalendarDragStore.getState().startDrag('plan-1', mockCalendarEvent, 2);
      useCalendarDragStore.getState().endDrag();
      const state = useCalendarDragStore.getState();
      expect(state.isDragging).toBe(false);
      expect(state.draggedEntryId).toBeNull();
    });
  });
});
