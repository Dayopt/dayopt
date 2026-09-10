import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attemptChunkLoadRecovery,
  clearDayoptCaches,
  isChunkLoadError,
} from './chunk-load-recovery';

const FLAG_KEY = 'dayopt:chunk-reload-attempted';

/** sessionStorage 相当の最小実装。 */
function createFakeStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

function createChunkError() {
  const error = new Error('Loading chunk 42 failed.');
  error.name = 'ChunkLoadError';
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('isChunkLoadError', () => {
  it('name が ChunkLoadError なら true', () => {
    expect(isChunkLoadError(createChunkError())).toBe(true);
  });

  it('dynamic import 失敗のメッセージでも true', () => {
    expect(
      isChunkLoadError(new Error('Failed to fetch dynamically imported module: /_next/x.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('無関係な error は false', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false);
  });
});

describe('attemptChunkLoadRecovery', () => {
  it('初回の chunk error でリロードし、flag を立て、dayopt- のキャッシュだけ削除する', async () => {
    const storage = createFakeStorage();
    const reload = vi.fn();
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['dayopt-static-v1', 'dayopt-dynamic-v1', 'other-cache']),
      delete: deleteCache,
    });

    const recovered = attemptChunkLoadRecovery(createChunkError(), { storage, reload });

    expect(recovered).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.store.get(FLAG_KEY)).toBe('1');

    // キャッシュ削除は非同期に走らせるので解決を待ってから検証する
    await vi.waitFor(() => {
      expect(deleteCache).toHaveBeenCalledTimes(2);
    });
    expect(deleteCache).toHaveBeenCalledWith('dayopt-static-v1');
    expect(deleteCache).toHaveBeenCalledWith('dayopt-dynamic-v1');
    expect(deleteCache).not.toHaveBeenCalledWith('other-cache');
  });

  it('flag がある 2 回目はリロードせず、flag を消す', () => {
    const storage = createFakeStorage({ [FLAG_KEY]: '1' });
    const reload = vi.fn();
    const clearCaches = vi.fn().mockResolvedValue(undefined);

    const recovered = attemptChunkLoadRecovery(createChunkError(), {
      storage,
      reload,
      clearCaches,
    });

    expect(recovered).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(clearCaches).not.toHaveBeenCalled();
    expect(storage.store.has(FLAG_KEY)).toBe(false);
  });

  it('chunk error でなければ storage に触れない', () => {
    const storage = createFakeStorage();
    const reload = vi.fn();

    expect(attemptChunkLoadRecovery(new Error('boom'), { storage, reload })).toBe(false);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('storage が throw しても落ちず、リロードもしない', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const reload = vi.fn();

    expect(() => attemptChunkLoadRecovery(createChunkError(), { storage, reload })).not.toThrow();
    expect(attemptChunkLoadRecovery(createChunkError(), { storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('キャッシュ削除が失敗してもリロードは行う', async () => {
    const storage = createFakeStorage();
    const reload = vi.fn();
    const clearCaches = vi.fn().mockRejectedValue(new Error('cache unavailable'));

    expect(attemptChunkLoadRecovery(createChunkError(), { storage, reload, clearCaches })).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(clearCaches).toHaveBeenCalledTimes(1);
    });
  });
});

describe('clearDayoptCaches', () => {
  it('CacheStorage が無い環境では何もしない', async () => {
    await expect(clearDayoptCaches()).resolves.toBeUndefined();
  });
});
