/**
 * 永続化 query cache の所有者を解決する（#2619）。
 *
 * cache を user 単位に名前空間分けするため、`PersistQueryClientProvider` の復元処理から
 * 呼ばれる。復元は mount 直後に 1 度だけ走り、その Promise が resolve するまで
 * `isRestoring` が立つので、ここで session の読み込みを待ち合わせられる。
 *
 * この関数を lib/ 側（persister 本体）ではなく feature 側に置くのは依存方向のため
 * （`features/ -> lib/` の一方向。lib から auth store は参照しない）。
 */

import { logger } from '@/lib/logger';
import { readLastKnownUserId, rememberLastKnownUserId } from '@/lib/tanstack-query/cache-owner';

import { useAuthStore } from './useAuthStore';

/**
 * 解決を諦めるまでの上限。
 *
 * `isRestoring` の間は query が fetch を待つため、store 側の timeout（オフライン時 30s）に
 * 合わせて長くすると、認証が詰まった時にアプリ全体が待たされる。ここで打ち切っても
 * `lastKnownUserId` のフォールバックがあるので、cache の復元自体は諦めずに済む。
 */
const RESOLUTION_TIMEOUT_MS = 10_000;

/**
 * 現在の session から所有者を解決できなかった時のフォールバック。
 *
 * **なぜ必要か**: オフラインで PWA を開くと、access token が期限切れなら auth-js は
 * refresh を試みて失敗し、store は `user: null` に落ちる。ここで諦めると、オフラインでこそ
 * 効いてほしい cache 復元が働かない（`docs/engineering/pwa.md` が謳う挙動が崩れる）。
 *
 * **なぜ安全か**: この値は sign-out の全経路で `forgetLastKnownUserId()` により消える。
 * 残っているのは「ログアウトせずに離れた」場合だけで、その端末には当人の session が
 * まだ載っている。別人がログインするにはネットワークが要り、その時は store が新しい user を
 * 解決するので、フォールバックではなく実際の user id が使われる（そして別人の blob は
 * persister 側の eviction で消える）。つまり、この経路で他人の cache が復元されることはない。
 */
function resolveFallbackUserId(): string | null {
  const stored = readLastKnownUserId();
  if (stored) {
    logger.warn('[AuthResolve] falling back to the last known cache owner');
  }
  return stored;
}

/**
 * auth store が session を読み終えるのを待って、cache の所有者となる user id を返す。
 *
 * 既に解決済みなら即座に返す。解決できなければ最後に確定した所有者へフォールバックし、
 * それも無ければ null（＝復元しない）。
 */
export function waitForResolvedUserId(
  timeoutMs: number = RESOLUTION_TIMEOUT_MS,
): Promise<string | null> {
  const settle = (userId: string | null): string | null => {
    if (userId) {
      rememberLastKnownUserId(userId);
      return userId;
    }
    return resolveFallbackUserId();
  };

  const initial = useAuthStore.getState();
  if (!initial.loading) return Promise.resolve(settle(initial.user?.id ?? null));

  return new Promise<string | null>((resolve) => {
    let settled = false;

    // `timer` / `unsubscribe` はこの下で定義されるが、`finish` が呼ばれるのは
    // timer 発火・store 更新・末尾の取りこぼし確認のいずれかで、どれも定義後に起きる。
    const finish = (userId: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(settle(userId));
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const unsubscribe = useAuthStore.subscribe((state) => {
      if (!state.loading) finish(state.user?.id ?? null);
    });

    // subscribe を張るまでの間に解決していた場合の取りこぼしを拾う。
    const current = useAuthStore.getState();
    if (!current.loading) finish(current.user?.id ?? null);
  });
}
