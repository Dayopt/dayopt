/**
 * 永続化 query cache の user 束縛（#2619）。
 *
 * IndexedDB の fake は入れず、`QueryCacheStorage` の in-memory 実装を注入して
 * 「誰の blob をいつ読み書きするか」だけを検証する。IndexedDB そのものの挙動ではなく、
 * 認可境界（別 principal のキャッシュを復元しない）が本件の争点であるため。
 */

import type { PersistedClient } from '@tanstack/query-persist-client-core';
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPersistedQueryCache,
  createUserScopedQueryPersister,
  type QueryCacheStorage,
} from './persist-storage';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const forgetLastKnownUserId = vi.hoisted(() => vi.fn());
vi.mock('./cache-owner', () => ({ forgetLastKnownUserId }));

const USER_A = 'user-a';
const USER_B = 'user-b';

function createMemoryStorage(): QueryCacheStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: async (key) => entries.get(key) ?? null,
    setItem: async (key, value) => {
      entries.set(key, value);
    },
    removeItem: async (key) => {
      entries.delete(key);
    },
    keys: async () => [...entries.keys()],
    clear: async () => {
      entries.clear();
    },
  };
}

function persistedClient(marker: string): PersistedClient {
  return {
    timestamp: Date.now(),
    buster: 'test',
    clientState: {
      mutations: [],
      queries: [{ queryKey: ['plans', marker], queryHash: marker, state: {} }],
    },
  } as unknown as PersistedClient;
}

/** `typeof window` / `indexedDB` の存在判定を通すための最小の browser 環境 */
beforeEach(() => {
  vi.stubGlobal('window', { indexedDB: {} });
  vi.stubGlobal('indexedDB', {});
});

describe('createUserScopedQueryPersister', () => {
  it.each(['auth-clear', 'persister-remove'] as const)(
    '%s後に旧主体の遅い読み取りをhydrateしない',
    async (removal) => {
      // IndexedDB読み取り開始後に別タブのsign-inが入り、auth boundaryがclearする順序。
      const storage = createMemoryStorage();
      let owner = USER_A;
      const persister = createUserScopedQueryPersister({
        resolveUserId: async () => owner,
        storage,
      });
      const source = new QueryClient();
      source.setQueryData(['plans'], ['private-plan-a']);
      await persister.persistClient({
        timestamp: Date.now(),
        buster: 'test',
        clientState: dehydrate(source),
      });

      let finishRead!: () => void;
      let signalRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      const getItem = storage.getItem;
      storage.getItem = async (key) => {
        const snapshot = await getItem(key);
        signalRead();
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
        return snapshot;
      };
      const target = new QueryClient();
      const restoring = persistQueryClientRestore({
        queryClient: target,
        persister,
        buster: 'test',
      });
      await readStarted;

      owner = USER_B;
      target.clear();
      if (removal === 'auth-clear') await clearPersistedQueryCache(storage);
      else await persister.removeClient();
      finishRead();
      await restoring;

      expect(target.getQueryData(['plans'])).toBeUndefined();
      // 破棄後の新しい主体の保存・復元は引き続きできる。
      storage.getItem = getItem;
      source.setQueryData(['plans'], ['private-plan-b']);
      await persister.persistClient({
        timestamp: Date.now(),
        buster: 'test',
        clientState: dehydrate(source),
      });
      await persistQueryClientRestore({ queryClient: target, persister, buster: 'test' });
      expect(target.getQueryData(['plans'])).toEqual(['private-plan-b']);
      source.clear();
      target.clear();
    },
  );

  it('user が未解決なら書き込まない（誰のものとも言えない blob を作らない）', async () => {
    const storage = createMemoryStorage();
    const persister = createUserScopedQueryPersister({
      resolveUserId: async () => null,
      storage,
    });

    await persister.persistClient(persistedClient('a'));

    expect(storage.entries.size).toBe(0);
  });

  it('同一 user は復元できる（オフライン再訪の既存挙動を壊さない）', async () => {
    const storage = createMemoryStorage();
    const persister = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });

    await persister.persistClient(persistedClient('a'));
    const restored = await persister.restoreClient();

    expect(restored?.clientState.queries[0]?.queryHash).toBe('a');
  });

  // 本 issue の核心: 共有端末で A の後に B がログインしても A のデータを見せない。
  it('別 user の blob は復元せず、その場で削除する', async () => {
    const storage = createMemoryStorage();
    const persisterA = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    await persisterA.persistClient(persistedClient('a'));
    expect(storage.entries.size).toBe(1);

    const persisterB = createUserScopedQueryPersister({
      resolveUserId: async () => USER_B,
      storage,
    });
    const restored = await persisterB.restoreClient();

    expect(restored).toBeUndefined();
    // A の blob がディスクに残らない（ログアウトを経ずタブを閉じた場合の残骸も回収する）
    expect(storage.entries.size).toBe(0);
  });

  // 旧実装が書いた固定キー `DAYOPT_QUERY_CLIENT` は所有者不明。移行時に必ず回収する。
  it('旧 version の所有者不明 blob は復元せず削除する', async () => {
    const storage = createMemoryStorage();
    storage.entries.set('DAYOPT_QUERY_CLIENT', 'legacy-blob');

    const persister = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    const restored = await persister.restoreClient();

    expect(restored).toBeUndefined();
    expect(storage.entries.has('DAYOPT_QUERY_CLIENT')).toBe(false);
  });

  // user が解決できないのは「未認証」だけでなく、オフラインで session の解決が上限まで
  // 掛かった場合も含む。ここで消すと正当なユーザーが自分の cache を失うので、
  // 復元を諦めるだけにする（他人の blob の回収は eviction と sign-out が担当する）。
  it('user が解決できない時は復元せず、保存済み blob も消さない', async () => {
    const storage = createMemoryStorage();
    const persisterA = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    await persisterA.persistClient(persistedClient('a'));

    const unresolved = createUserScopedQueryPersister({
      resolveUserId: async () => null,
      storage,
    });
    const restored = await unresolved.restoreClient();

    expect(restored).toBeUndefined();
    expect(storage.entries.size).toBe(1);

    // 同じ user が解決できるようになれば、そのまま復元できる。
    await expect(persisterA.restoreClient()).resolves.toBeDefined();
  });

  // key が合っていても中身の所有者が違えば信用しない（key 組み立ての将来変更への保険）
  it('envelope の user id が key と食い違う blob は復元せず削除する', async () => {
    const storage = createMemoryStorage();
    const persisterA = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    await persisterA.persistClient(persistedClient('a'));

    const [key, value] = [...storage.entries.entries()][0]!;
    storage.entries.set(key, value.replace(USER_A, USER_B));

    const restored = await persisterA.restoreClient();

    expect(restored).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
  });

  it('removeClient は自分の分だけでなく全件破棄する', async () => {
    const storage = createMemoryStorage();
    await createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    }).persistClient(persistedClient('a'));
    await createUserScopedQueryPersister({
      resolveUserId: async () => USER_B,
      storage,
    }).persistClient(persistedClient('b'));
    expect(storage.entries.size).toBe(2);

    await createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    }).removeClient();

    expect(storage.entries.size).toBe(0);
  });
});

describe('clearPersistedQueryCache', () => {
  it('保存失敗の後も破棄と次の保存が動く', async () => {
    const storage = createMemoryStorage();
    const persister = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    const setItem = storage.setItem;
    storage.setItem = async () => {
      throw new Error('storage unavailable');
    };
    await persister.persistClient(persistedClient('failed'));
    await clearPersistedQueryCache(storage);
    storage.setItem = setItem;
    await persister.persistClient(persistedClient('retry'));
    expect((await persister.restoreClient())?.clientState.queries[0]?.queryHash).toBe('retry');
  });
  it('破棄前に開始した遅い保存を待ってから消し、旧blobを復活させない', async () => {
    const storage = createMemoryStorage();
    let finishWrite!: () => void;
    let signalWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const setItem = storage.setItem;
    storage.setItem = async (key, value) => {
      signalWrite();
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      await setItem(key, value);
    };
    const persister = createUserScopedQueryPersister({
      resolveUserId: async () => USER_A,
      storage,
    });
    const saving = persister.persistClient(persistedClient('a'));
    await writing;
    const clearing = clearPersistedQueryCache(storage);
    finishWrite();
    await Promise.all([saving, clearing]);
    expect(storage.entries.size).toBe(0);
  });

  it('所有者解決中に破棄された保存を、解決後に書き込まない', async () => {
    const storage = createMemoryStorage();
    let resolveOwner!: (owner: string) => void;
    const persister = createUserScopedQueryPersister({
      resolveUserId: () =>
        new Promise<string>((resolve) => {
          resolveOwner = resolve;
        }),
      storage,
    });
    const saving = persister.persistClient(persistedClient('a'));
    await clearPersistedQueryCache(storage);
    resolveOwner(USER_A);
    await saving;
    expect(storage.entries.size).toBe(0);
  });

  it('保存済みの blob を全て破棄する', async () => {
    const storage = createMemoryStorage();
    storage.entries.set('DAYOPT_QUERY_CLIENT:user-a', 'x');
    storage.entries.set('DAYOPT_QUERY_CLIENT:user-b', 'y');

    await clearPersistedQueryCache(storage);

    expect(storage.entries.size).toBe(0);
  });

  // 記憶している所有者を残すと、sign-out 後もオフライン fallback が前ユーザーを指し続ける。
  // 破棄と記憶の削除が必ず対で起きることが、fallback を安全にしている前提。
  it('記憶している cache の所有者も忘れる', async () => {
    const storage = createMemoryStorage();

    await clearPersistedQueryCache(storage);

    expect(forgetLastKnownUserId).toHaveBeenCalled();
  });
});
