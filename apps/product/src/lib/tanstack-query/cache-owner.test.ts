/**
 * 記憶している query cache の所有者（#2619）。
 *
 * オフラインで session を解決できない時のフォールバックに使う。sign-out で必ず消えることが
 * 安全性の前提なので、そこを固定する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetLastKnownUserId, readLastKnownUserId, rememberLastKnownUserId } from './cache-owner';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function createMemoryLocalStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createMemoryLocalStorage() });
});

describe('cache owner の記憶', () => {
  it('記憶していなければ null', () => {
    expect(readLastKnownUserId()).toBeNull();
  });

  it('記憶した所有者を読み戻せる', () => {
    rememberLastKnownUserId('user-a');

    expect(readLastKnownUserId()).toBe('user-a');
  });

  it('忘れると null に戻る（sign-out 後にフォールバックが効かない）', () => {
    rememberLastKnownUserId('user-a');

    forgetLastKnownUserId();

    expect(readLastKnownUserId()).toBeNull();
  });

  // Safari の private mode 等で localStorage が例外を投げる。落とさず null に倒す。
  it('localStorage が使えない環境でも例外を投げない', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      },
    });

    expect(readLastKnownUserId()).toBeNull();
    expect(() => rememberLastKnownUserId('user-a')).not.toThrow();
    expect(() => forgetLastKnownUserId()).not.toThrow();
  });
});
