import { describe, expect, it } from 'vitest';

import { isValidEvent } from './dateHelpers';

describe('isValidEvent', () => {
  it.each([
    [{ startDate: new Date('2024-06-15') }, true],
    [{ startDate: '2024-06-15' }, true],
    [{}, false],
    [{ startDate: 'invalid-date' }, false],
  ])('イベントの開始日時の妥当性を判定する: %j → %s', (event, expected) => {
    expect(isValidEvent(event)).toBe(expected);
  });
});
