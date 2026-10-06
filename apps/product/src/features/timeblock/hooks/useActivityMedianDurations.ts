'use client';

/**
 * アクティビティ別の「記録の長さの中央値」を引く hook。
 *
 * 作成パネルのアクティビティ一覧に目安として添え、サイドバータップの既定長にも使う。
 * 集計の定義は `domain/plan-template-duration.ts` が正本（直近 4 週・`n >= 3`・
 * 5 分丸め・`auto_migrated` 除外）で、テンプレート適用が着せる長さと同じ値。
 *
 * query はサイドバー（`ActivityFilterList`）が非同期で引いている
 * `statistics.getActivityStats` をそのまま共有する。この機能のための追加クエリは無い。
 */

import { useCallback, useMemo } from 'react';

import { CACHE_5_MINUTES } from '@/lib/date';
import { api } from '@/lib/trpc';

interface ActivityMedianDurations {
  /** activityId → 中央値（分）。`n >= 3` のアクティビティだけが入る */
  medianByActivityId: ReadonlyMap<string, number>;
  /** 未取得と中央値なしを区別し、即時作成だけは共有 query の完了を待つ */
  isPending: boolean;
  resolveMedianMinutes: (activityId: string) => Promise<number | null>;
  /** 中央値が無いアクティビティは null。呼び出し側が既定長へフォールバックする */
  getMedianMinutes: (activityId: string | null) => number | null;
}

export function useActivityMedianDurations(): ActivityMedianDurations {
  // 意図的に isError をハンドリングしない（`useActivityEstimationFactors` と同じ理由）。
  // これは受動的なヒントで、取れなかった事実をユーザーに見せる価値が無い。
  // 失敗時は data が undefined のまま Map が空になり、目安は出ず既定長で作られる。
  const utils = api.useUtils();
  const { data, isPending } = api.statistics.getActivityStats.useQuery(undefined, {
    staleTime: CACHE_5_MINUTES,
  });

  const medianByActivityId = useMemo(
    () => new Map(Object.entries(data?.medianMinutes ?? {})),
    [data],
  );

  const resolveMedianMinutes = useCallback(
    async (activityId: string) => {
      try {
        // fetchQuery は既存の取得中 query を共有する。表示やヒントは待たせない。
        const stats = await utils.statistics.getActivityStats.fetch(undefined, {
          staleTime: CACHE_5_MINUTES,
        });
        return stats.medianMinutes[activityId] ?? null;
      } catch {
        // 取得失敗時は従来どおり設定の長さへフォールバックする。
        return null;
      }
    },
    [utils],
  );

  return useMemo(
    () => ({
      medianByActivityId,
      isPending,
      resolveMedianMinutes,
      getMedianMinutes: (activityId) =>
        activityId == null ? null : (medianByActivityId.get(activityId) ?? null),
    }),
    [medianByActivityId, isPending, resolveMedianMinutes],
  );
}
