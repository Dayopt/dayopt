/**
 * 最後に確定した query cache の所有者（#2619）。
 *
 * cache そのものに属する情報なので `lib/tanstack-query/` に置く。auth feature 側
 * （`resolve-user-id.ts`）と lib 側（`persist-storage.ts`）の両方から使うため、
 * `features/ -> lib/` の依存方向を守れるのはこの位置だけ。
 *
 * 値は user id のみ。それ自体は秘密ではなく、同じ id は cache の IndexedDB key にも現れる。
 */

import { logger } from '@/lib/logger';

const LAST_KNOWN_USER_ID_KEY = 'dayopt.query-cache.last-user-id';

/** 覚えている所有者を読む。 */
export function readLastKnownUserId(): string | null {
  try {
    return window.localStorage.getItem(LAST_KNOWN_USER_ID_KEY);
  } catch (error) {
    // Safari の private mode 等で localStorage が例外を投げることがある。
    logger.warn('[QueryPersist] failed to read last known user id:', error);
    return null;
  }
}

/** 所有者が確定した時に覚える。 */
export function rememberLastKnownUserId(userId: string): void {
  try {
    window.localStorage.setItem(LAST_KNOWN_USER_ID_KEY, userId);
  } catch (error) {
    logger.warn('[QueryPersist] failed to remember last known user id:', error);
  }
}

/**
 * 覚えている所有者を忘れる。**sign-out の全経路から呼ぶこと。**
 *
 * これを消し忘れると、ログアウト後もオフライン fallback が前ユーザーを指し続ける。
 * 実際の cache 破棄（`clearPersistedQueryCache`）と必ず対で呼ぶ。
 */
export function forgetLastKnownUserId(): void {
  try {
    window.localStorage.removeItem(LAST_KNOWN_USER_ID_KEY);
  } catch (error) {
    logger.warn('[QueryPersist] failed to forget last known user id:', error);
  }
}
