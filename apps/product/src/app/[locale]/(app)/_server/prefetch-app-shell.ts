import { getDateKey } from '@/lib/date';
import { logger } from '@/lib/logger';
import { createServerHelpers, dehydrate } from '@/lib/trpc/server';
import { defaultShouldDehydrateQuery } from '@tanstack/react-query';

/** 失敗した query は hydrate せず、既存の client gate に取得・エラー表示を任せる。 */
export async function prefetchAppShell() {
  try {
    const helpers = await createServerHelpers();
    await Promise.all([
      helpers.userSettings.get.prefetch(),
      helpers.billing.getAccess.prefetch(),
      // sidebar が calendar より先に購読する一覧もここで hydrate する。
      // 内側の boundary だと既存 query の反映が effect 待ちになり、SSR のカード名が空になる。
      helpers.activities.listActivities.prefetch({ includeArchived: true }),
      helpers.activities.listCategories.prefetch({ includeArchived: true }),
    ]);
    return dehydrate(helpers.queryClient, {
      // settings row が無い時の既定 TZ はブラウザで確定する。従来の client gate を維持。
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) &&
        !(
          Array.isArray(query.queryKey[0]) &&
          query.queryKey[0][0] === 'userSettings' &&
          query.queryKey[0][1] === 'get' &&
          query.state.data === null
        ),
    });
  } catch (error) {
    logger.warn('App shell prefetch unavailable; client gates will retry', error);
    return undefined;
  }
}

/** Cookie が壊れていても描画を止めず、既存の calendar prefetch と同じ UTC fallback を使う。 */
export function resolveInitialCalendarDate(now: Date, timezone: string) {
  try {
    return getDateKey(now, timezone);
  } catch {
    return getDateKey(now, 'UTC');
  }
}
