/**
 * TanStack Query キャッシュ永続化ストレージ（IndexedDB）
 *
 * タブを閉じて再度開いた際にキャッシュデータを即座に復元し、
 * バックグラウンドで最新データを再フェッチするためのストレージアダプター。
 *
 * @design
 * - IndexedDB を使用（5MB制限のある localStorage より大容量）
 * - データは単一 blob としてシリアライズ（tRPCと同じ superjson を使用）
 * - SSR 環境では no-op として動作（IndexedDB は Window API）
 * - バージョンバスター: APP_VERSION でデプロイ時にキャッシュを自動破棄
 * - **blob は認証済み user id で名前空間を分ける**（#2619）
 *
 * @security #2619
 * 以前は `DAYOPT_QUERY_CLIENT` 固定キー 1 本に書いており、blob に所有者の情報が無く、
 * sign-out のどの経路もこれを消さなかった。共有端末で A がログアウトした後に B がログインすると、
 * `staleTime`（5 分）内の query は refetch されずに復元され、B の画面に A の予定が出た。
 *
 * 対策は 2 層:
 *
 * 1. **key と envelope の両方に user id を持たせる。** 別の principal の blob は復元しない
 * 2. **復元時に他人の blob をその場で削除する。** ログアウトせずタブを閉じた場合など、
 *    sign-out 経路を通らなかった残骸をディスクに残さない
 *
 * sign-out での明示的な破棄は `clearPersistedQueryCache()` が担う（呼び出し側は
 * `useLogout` / auth store の `SIGNED_OUT` / QueryCacheAuthBoundary）。
 */

import type { PersistedClient, Persister } from '@tanstack/query-persist-client-core';
import superjson from 'superjson';

import { logger } from '@/lib/logger';

import { forgetLastKnownUserId } from './cache-owner';

const DB_NAME = 'dayopt-query-cache';
const STORE_NAME = 'cache';
/**
 * key の prefix。実際の key は `${CACHE_KEY_PREFIX}:${userId}`。
 *
 * prefix 単体（旧実装の固定キー）は誰のものとも判定できないため、復元時に他人の blob として
 * 掃除される。旧 version からの移行で残る blob もここで回収される。
 */
const CACHE_KEY_PREFIX = 'DAYOPT_QUERY_CLIENT';
const DB_VERSION = 1;

function cacheKeyFor(userId: string): string {
  return `${CACHE_KEY_PREFIX}:${userId}`;
}

/**
 * 永続化 blob の入れ物。key だけでなく中身にも所有者を持たせる。
 *
 * key の一致だけに頼ると、key の組み立てを将来変えた時に「別人の blob を読んでいる」ことを
 * 検出できない。両方を突き合わせる。
 */
type PersistedClientEnvelope = {
  userId: string;
  client: PersistedClient;
};

function isEnvelope(value: unknown): value is PersistedClientEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { userId?: unknown }).userId === 'string' &&
    typeof (value as { client?: unknown }).client === 'object' &&
    (value as { client?: unknown }).client !== null
  );
}

/**
 * 永続化先の最小インターフェース。
 *
 * 本番は IndexedDB 実装、テストは in-memory 実装を注入する（IndexedDB の fake を入れずに
 * user 束縛のロジックそのものを検証するため）。
 */
export type QueryCacheStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  /** 保存済みの全 key。他人の blob を掃除するために使う。 */
  keys: () => Promise<string[]>;
  /** 全件破棄（sign-out 用）。 */
  clear: () => Promise<void>;
};

/** IndexedDB の接続を開いて返す */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event) => {
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

/** `IDBRequest` を Promise 化する（transaction 完了時に接続を閉じる） */
function runRequest<T>(
  mode: IDBTransactionMode,
  execute: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = execute(tx.objectStore(STORE_NAME));

        request.onsuccess = (event) => {
          resolve((event.target as IDBRequest<T>).result);
        };

        request.onerror = (event) => {
          reject((event.target as IDBRequest).error);
        };

        tx.oncomplete = () => db.close();
      }),
  );
}

/** IndexedDB を使う本番の永続化先。SSR / IndexedDB 非対応環境では no-op。 */
const indexedDbQueryCacheStorage: QueryCacheStorage = {
  getItem: async (key) => {
    const result = await runRequest<string | undefined>('readonly', (store) => store.get(key));
    return result ?? null;
  },
  setItem: async (key, value) => {
    await runRequest('readwrite', (store) => store.put(value, key));
  },
  removeItem: async (key) => {
    await runRequest('readwrite', (store) => store.delete(key));
  },
  keys: async () => {
    const result = await runRequest<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return result.filter((key): key is string => typeof key === 'string');
  },
  clear: async () => {
    await runRequest('readwrite', (store) => store.clear());
  },
};

/** ブラウザで IndexedDB が使えるか（SSR では false） */
function isStorageAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

type CreatePersisterOptions = {
  /**
   * 現在の認証済み user id を解決する。まだ確定していなければ null を返す。
   *
   * **解決を待てる非同期であること。** `PersistQueryClientProvider` は mount 直後に 1 度だけ
   * `restoreClient` を呼び、その Promise が resolve するまで復元を待つ（`isRestoring`）。
   * この待ち合わせに乗せることで、auth store が session を読み終える前に既定 key で
   * 復元してしまう事故を防ぐ。
   */
  resolveUserId: () => Promise<string | null>;
  storage?: QueryCacheStorage;
};

/**
 * user 単位に名前空間を分けた Persister を作る。
 *
 * `PersistQueryClientProvider` に渡す persister。
 * superjson で Date 型を含むデータも正確にシリアライズ/デシリアライズする。
 *
 * @example
 * ```tsx
 * const [persister] = useState(() =>
 *   createUserScopedQueryPersister({ resolveUserId: waitForResolvedUserId }),
 * );
 * ```
 */
export function createUserScopedQueryPersister({
  resolveUserId,
  storage = indexedDbQueryCacheStorage,
}: CreatePersisterOptions): Persister {
  /** 現在の user のもの以外を全部消す。ログアウトを経ずに残った他人の blob を回収する。 */
  async function evictForeignBlobs(currentKey: string): Promise<void> {
    const keys = await storage.keys();
    await Promise.all(
      keys.filter((key) => key !== currentKey).map((key) => storage.removeItem(key)),
    );
  }

  return {
    persistClient: async (client: PersistedClient): Promise<void> => {
      if (!isStorageAvailable()) return;
      try {
        const userId = await resolveUserId();
        // 所有者が確定しない状態では書かない（誰のものとも言えない blob を作らない）。
        if (!userId) return;
        const envelope: PersistedClientEnvelope = { userId, client };
        await storage.setItem(cacheKeyFor(userId), superjson.stringify(envelope));
      } catch (error) {
        logger.warn('[QueryPersist] persistClient failed:', error);
      }
    },

    restoreClient: async (): Promise<PersistedClient | undefined> => {
      if (!isStorageAvailable()) return undefined;
      try {
        const userId = await resolveUserId();
        if (!userId) {
          // 所有者が確定しないので誰の blob も復元しない。
          //
          // **ここで storage を消さない。** この分岐は「未認証」だけでなく、session の解決が
          // 上限まで掛かった場合（オフラインで access token の refresh が試みられる等）にも
          // 入る。消してしまうと、正当なユーザーがオフラインで再訪しただけで自分の cache を
          // 失う。他人の blob の回収は「別の user が解決した時の eviction」と
          // 「sign-out での明示的な破棄」が担当する。
          return undefined;
        }

        const key = cacheKeyFor(userId);
        await evictForeignBlobs(key);

        const serialized = await storage.getItem(key);
        if (!serialized) return undefined;

        const envelope = superjson.parse<unknown>(serialized);
        if (!isEnvelope(envelope) || envelope.userId !== userId) {
          // key と中身が食い違う blob は信用しない（壊れているか、別人のもの）。
          await storage.removeItem(key);
          return undefined;
        }
        return envelope.client;
      } catch (error) {
        logger.warn('[QueryPersist] restoreClient failed:', error);
        return undefined;
      }
    },

    removeClient: async (): Promise<void> => {
      if (!isStorageAvailable()) return;
      try {
        // 現在の user の分だけでなく全件消す。sign-out 後に誰の残骸も残さない。
        await storage.clear();
      } catch (error) {
        logger.warn('[QueryPersist] removeClient failed:', error);
      }
    },
  };
}

/**
 * 永続化キャッシュを全件破棄する（#2619）。
 *
 * sign-out の各経路から呼ぶ。persister の生存とは無関係に動くよう、module 関数として提供する
 * （`useLogout` は provider の外側からも呼ばれうる）。
 */
export async function clearPersistedQueryCache(
  storage: QueryCacheStorage = indexedDbQueryCacheStorage,
): Promise<void> {
  if (!isStorageAvailable()) return;
  // 覚えている所有者も必ず対で忘れる。ここに同居させておけば、sign-out 経路が増えても
  // 「cache は消したが所有者は覚えたまま」（＝オフライン fallback が前ユーザーを指し続ける）
  // という取りこぼしが構造的に起きない。
  forgetLastKnownUserId();
  try {
    await storage.clear();
  } catch (error) {
    logger.warn('[QueryPersist] clearPersistedQueryCache failed:', error);
  }
}

/**
 * キャッシュ永続化の最大保持期間
 *
 * QueryClient のデフォルト gcTime（`query-client.ts` の `gcTime: PERSIST_MAX_AGE_MS`）と同じ値。
 * QueryClient の gcTime がこの値以上である必要がある（GC 前に復元できるよう）。
 */
export const PERSIST_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2時間

/**
 * キャッシュバスターの文字列（リリースversion変更時に変わる）
 *
 * next.config.mjs でroot package.jsonのversionをNEXT_PUBLIC_APP_VERSIONとして注入済み。
 * リリースversionが変わるとキャッシュが自動的に破棄される。
 */
export const CACHE_BUSTER = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';
