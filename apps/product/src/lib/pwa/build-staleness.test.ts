import { describe, expect, it } from 'vitest';

import {
  isStaleAgainstDeployed,
  isStaleOnControllerChange,
  readServiceWorkerVersion,
} from './build-staleness';

describe('readServiceWorkerVersion', () => {
  it('絶対 URL の v パラメータを読む', () => {
    expect(readServiceWorkerVersion('https://app.dayopt.app/sw.js?v=abcdef12')).toBe('abcdef12');
  });

  it('相対 URL でも読む', () => {
    expect(readServiceWorkerVersion('/sw.js?v=abcdef12')).toBe('abcdef12');
  });

  it('v が無い・空・URL 自体が無い時は null', () => {
    expect(readServiceWorkerVersion('https://app.dayopt.app/sw.js')).toBeNull();
    expect(readServiceWorkerVersion('/sw.js?v=')).toBeNull();
    expect(readServiceWorkerVersion(undefined)).toBeNull();
    expect(readServiceWorkerVersion(null)).toBeNull();
  });
});

describe('isStaleOnControllerChange', () => {
  it('新しい SW の版がページと同じなら古くない（自分が新版を起動した側）', () => {
    expect(isStaleOnControllerChange('abcdef12', 'https://app.dayopt.app/sw.js?v=abcdef12')).toBe(
      false,
    );
  });

  it('新しい SW の版がページと違えば古い', () => {
    expect(isStaleOnControllerChange('abcdef12', 'https://app.dayopt.app/sw.js?v=12345678')).toBe(
      true,
    );
  });

  it('ページの SHA が無いビルドでは比較できないので古いとみなす', () => {
    expect(isStaleOnControllerChange('', 'https://app.dayopt.app/sw.js')).toBe(true);
  });

  it('新しい SW の版が読めない時は古いとみなす', () => {
    expect(isStaleOnControllerChange('abcdef12', 'https://app.dayopt.app/sw.js')).toBe(true);
    expect(isStaleOnControllerChange('abcdef12', undefined)).toBe(true);
  });
});

describe('isStaleAgainstDeployed', () => {
  it('配信中の SHA と違えば古い', () => {
    expect(isStaleAgainstDeployed('abcdef12', '12345678')).toBe(true);
  });

  it('同じなら古くない', () => {
    expect(isStaleAgainstDeployed('abcdef12', 'abcdef12')).toBe(false);
  });

  it('どちらかが空なら比較できないので古いとはみなさない', () => {
    expect(isStaleAgainstDeployed('', '12345678')).toBe(false);
    expect(isStaleAgainstDeployed('abcdef12', '')).toBe(false);
    expect(isStaleAgainstDeployed('abcdef12', null)).toBe(false);
  });
});
