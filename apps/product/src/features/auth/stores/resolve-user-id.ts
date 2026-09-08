/**
 * 認証済み user id の解決を待つ（#2619）。
 *
 * 永続化 query cache を user 単位に名前空間分けするため、`PersistQueryClientProvider` の
 * 復元処理から呼ばれる。復元は mount 直後に 1 度だけ走り、その Promise が resolve するまで
 * `isRestoring` が立つので、ここで session の読み込みを待ち合わせられる。
 *
 * この関数を lib/ 側（persister 本体）ではなく feature 側に置くのは依存方向のため
 * （`features/ -> lib/` の一方向。lib から auth store は参照しない）。
 */

import { useAuthStore } from './useAuthStore';

/**
 * 解決を諦めるまでの上限。
 *
 * store 自身が session 取得に 5s（オフラインは 30s）の timeout を持ち、超えたら
 * `loading: false` / `user: null` に落ちるので、通常はここに到達しない。到達するのは
 * store の `initialize()` がそもそも走っていない場合で、その時は「未認証」と同じ扱い
 * （復元しない）に倒す。`isRestoring` の間は query が fetch を待つため、上限を
 * store の timeout に合わせて長くすると、認証が壊れた時にアプリ全体が固まる。
 */
const RESOLUTION_TIMEOUT_MS = 10_000;

/**
 * auth store が session を読み終えるのを待って user id を返す。
 *
 * 既に解決済みなら即座に返す。未認証、または上限まで解決しなければ null。
 */
export function waitForResolvedUserId(
  timeoutMs: number = RESOLUTION_TIMEOUT_MS,
): Promise<string | null> {
  const initial = useAuthStore.getState();
  if (!initial.loading) return Promise.resolve(initial.user?.id ?? null);

  return new Promise<string | null>((resolve) => {
    let settled = false;

    // `timer` / `unsubscribe` はこの下で定義されるが、`finish` が呼ばれるのは
    // timer 発火・store 更新・末尾の取りこぼし確認のいずれかで、どれも定義後に起きる。
    const finish = (userId: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(userId);
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
