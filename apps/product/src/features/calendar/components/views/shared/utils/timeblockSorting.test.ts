import { describe, expect, it } from 'vitest';

import type { CalendarDisplayEvent } from '../../../../types/calendar.types';

import {
  sortAgendaEventsByDateKeys,
  sortEventsByDateKeys,
  sortEventsByTime,
  sortEventsForAgenda,
} from './timeblockSorting';

function makeTimeblock(id: string, startDate: Date | null): CalendarDisplayEvent {
  return {
    id,
    title: `Timeblock ${id}`,
    startDate,
    endDate: startDate ? new Date(startDate.getTime() + 3600000) : null,
    color: '#000',
    version: '2026-07-15T00:00:00.000000Z',
    displayStartDate: startDate ?? new Date(),
    displayEndDate: startDate ? new Date(startDate.getTime() + 3600000) : new Date(),
    duration: 60,
    isMultiDay: false,
    kind: 'plan',
  };
}

describe('timeblockSorting', () => {
  describe('sortEventsByTime', () => {
    it('時刻昇順でソートする', () => {
      const timeblocks = [
        makeTimeblock('c', new Date('2026-02-21T14:00:00')),
        makeTimeblock('a', new Date('2026-02-21T09:00:00')),
        makeTimeblock('b', new Date('2026-02-21T11:00:00')),
      ];
      const sorted = sortEventsByTime(timeblocks);
      expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('startDateがnullのイベントは先頭に来る', () => {
      const timeblocks = [
        makeTimeblock('b', new Date('2026-02-21T10:00:00')),
        makeTimeblock('a', null),
      ];
      const sorted = sortEventsByTime(timeblocks);
      expect(sorted[0]!.id).toBe('a');
    });

    it('元の配列を変更しない', () => {
      const timeblocks = [
        makeTimeblock('b', new Date('2026-02-21T14:00:00')),
        makeTimeblock('a', new Date('2026-02-21T09:00:00')),
      ];
      const original = [...timeblocks];
      sortEventsByTime(timeblocks);
      expect(timeblocks.map((p) => p.id)).toEqual(original.map((p) => p.id));
    });

    it('空配列を処理できる', () => {
      expect(sortEventsByTime([])).toEqual([]);
    });
  });

  describe('sortEventsByDateKeys', () => {
    it('各日付キーのイベントをソートする', () => {
      const eventsByDate: Record<string, CalendarDisplayEvent[]> = {
        '2026-02-21': [
          makeTimeblock('b', new Date('2026-02-21T14:00:00')),
          makeTimeblock('a', new Date('2026-02-21T09:00:00')),
        ],
        '2026-02-22': [
          makeTimeblock('d', new Date('2026-02-22T16:00:00')),
          makeTimeblock('c', new Date('2026-02-22T08:00:00')),
        ],
      };

      const sorted = sortEventsByDateKeys(eventsByDate);
      expect(sorted['2026-02-21']!.map((p) => p.id)).toEqual(['a', 'b']);
      expect(sorted['2026-02-22']!.map((p) => p.id)).toEqual(['c', 'd']);
    });
  });

  describe('sortEventsForAgenda', () => {
    it('sortEventsByTimeと同じ結果を返す', () => {
      const timeblocks = [
        makeTimeblock('b', new Date('2026-02-21T14:00:00')),
        makeTimeblock('a', new Date('2026-02-21T09:00:00')),
      ];
      const sorted = sortEventsForAgenda(timeblocks);
      expect(sorted.map((p) => p.id)).toEqual(['a', 'b']);
    });
  });

  describe('sortAgendaEventsByDateKeys', () => {
    it('各日付キーのイベントをAgenda用にソートする', () => {
      const eventsByDate: Record<string, CalendarDisplayEvent[]> = {
        '2026-02-21': [
          makeTimeblock('b', new Date('2026-02-21T14:00:00')),
          makeTimeblock('a', new Date('2026-02-21T09:00:00')),
        ],
      };

      const sorted = sortAgendaEventsByDateKeys(eventsByDate);
      expect(sorted['2026-02-21']!.map((p) => p.id)).toEqual(['a', 'b']);
    });
  });
});
