/**
 * 同一レーンの空き探し。
 *
 * サイドバーのタップは「今の時間が埋まっているから作れない」で止めず、
 * その日のうちで長さが丸ごと入る最初の空きへずらす。長さは縮めない。
 */

import { describe, expect, it } from 'vitest';

import { findFreeTimeblockLaneSlot } from './timeblock-lane-conflict';

function item(id: string, startAt: string, endAt: string) {
  return { id, start_at: startAt, end_at: endAt };
}

const DAY_END = new Date('2026-09-10T23:59:59.999Z');

describe('findFreeTimeblockLaneSlot', () => {
  it('重なりが無ければ希望どおりの枠を返す', () => {
    const slot = findFreeTimeblockLaneSlot([], new Date('2026-09-10T10:00:00Z'), 45, DAY_END);

    expect(slot?.startAt.toISOString()).toBe('2026-09-10T10:00:00.000Z');
    expect(slot?.endAt.toISOString()).toBe('2026-09-10T10:45:00.000Z');
  });

  it('重なる時は既存の終わりからにずらし、長さは保つ', () => {
    const items = [item('a', '2026-09-10T09:30:00Z', '2026-09-10T11:00:00Z')];

    const slot = findFreeTimeblockLaneSlot(items, new Date('2026-09-10T10:00:00Z'), 45, DAY_END);

    expect(slot?.startAt.toISOString()).toBe('2026-09-10T11:00:00.000Z');
    expect(slot?.endAt.toISOString()).toBe('2026-09-10T11:45:00.000Z');
  });

  it('連続して埋まっていても、丸ごと入る空きまで進む', () => {
    const items = [
      item('a', '2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z'),
      item('b', '2026-09-10T11:00:00Z', '2026-09-10T12:00:00Z'),
      // 12:00–12:30 は 30 分しか空いていないので 45 分は入らない
      item('c', '2026-09-10T12:30:00Z', '2026-09-10T13:00:00Z'),
    ];

    const slot = findFreeTimeblockLaneSlot(items, new Date('2026-09-10T10:00:00Z'), 45, DAY_END);

    expect(slot?.startAt.toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  it('半開区間なので、既存の終わりと同時に始まる枠は重ならない', () => {
    const items = [item('a', '2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z')];

    const slot = findFreeTimeblockLaneSlot(items, new Date('2026-09-10T11:00:00Z'), 60, DAY_END);

    expect(slot?.startAt.toISOString()).toBe('2026-09-10T11:00:00.000Z');
  });

  it('その日にもう入らなければ null を返す（呼び出し側が知らせる）', () => {
    const items = [item('a', '2026-09-10T10:00:00Z', '2026-09-10T23:30:00Z')];

    const slot = findFreeTimeblockLaneSlot(items, new Date('2026-09-10T10:00:00Z'), 45, DAY_END);

    expect(slot).toBeNull();
  });

  it('開始より前に終わっている既存は無視する', () => {
    const items = [item('a', '2026-09-10T08:00:00Z', '2026-09-10T09:00:00Z')];

    const slot = findFreeTimeblockLaneSlot(items, new Date('2026-09-10T10:00:00Z'), 45, DAY_END);

    expect(slot?.startAt.toISOString()).toBe('2026-09-10T10:00:00.000Z');
  });
});
