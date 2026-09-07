import { describe, expect, it } from 'vitest';

import {
  isPlanRecordDrop,
  resolveTimeblockDestination,
  resolveTimeblockKindChoice,
} from './timeblock-destination';

const now = new Date('2026-07-10T12:00:00.000Z');

describe('resolveTimeblockDestination', () => {
  it('終了が現在より未来なら Plan を返す', () => {
    expect(resolveTimeblockDestination('2026-07-10T12:00:00.001Z', now)).toBe('plan');
  });

  it('終了が現在以前なら Record を返す', () => {
    expect(resolveTimeblockDestination('2026-07-10T12:00:00.000Z', now)).toBe('record');
  });
});

describe('isPlanRecordDrop', () => {
  it('Plan から Record レーンへのドロップだけを記録化とみなす', () => {
    expect(isPlanRecordDrop('plan', 'record')).toBe(true);
    expect(isPlanRecordDrop('record', 'plan')).toBe(false);
    expect(isPlanRecordDrop('plan', 'plan')).toBe(false);
  });
});

describe('resolveTimeblockKindChoice', () => {
  it('未来スロットは要求に関わらず Plan で、記録は選べない', () => {
    const future = '2026-07-10T12:00:00.001Z';

    expect(resolveTimeblockKindChoice(future, undefined, now)).toEqual({
      kind: 'plan',
      canRecord: false,
    });
    expect(resolveTimeblockKindChoice(future, 'record', now)).toEqual({
      kind: 'plan',
      canRecord: false,
    });
  });

  it('過去スロットの既定は Record で、Plan へ切り替えられる', () => {
    const past = '2026-07-10T11:00:00.000Z';

    expect(resolveTimeblockKindChoice(past, undefined, now)).toEqual({
      kind: 'record',
      canRecord: true,
    });
    expect(resolveTimeblockKindChoice(past, 'plan', now)).toEqual({
      kind: 'plan',
      canRecord: true,
    });
  });

  it('終了が現在ちょうどなら過去スロットとして扱う', () => {
    expect(resolveTimeblockKindChoice('2026-07-10T12:00:00.000Z', undefined, now)).toEqual({
      kind: 'record',
      canRecord: true,
    });
  });
});
