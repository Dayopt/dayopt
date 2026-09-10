'use client';

/**
 * アクティビティ別の「記録の長さの中央値」を引く hook。
 *
 * 作成パネルのアクティビティ一覧に目安として添え、サイドバータップの既定長にも使う。
 * 集計の定義は `domain/plan-template-duration.ts` が正本（直近 4 週・`n >= 3`・
 * 5 分丸め・`auto_migrated` 除外）で、テンプレート適用が着せる長さと同じ値。
 *
 * query はサイドバー（`ActivityFilterList`）が既に引いていて SSR prefetch もされている
 * `statistics.getActivityStats` をそのまま共有する。この機能のための追加クエリは無い。
 */

import { useMemo } from 'react';

import { CACHE_5_MINUTES } from '@/lib/date';
import { api } from '@/lib/trpc';

interface ActivityMedianDurations {
  /** activityId → 中央値（分）。`n >= 3` のアクティビティだけが入る */
  medianByActivityId: ReadonlyMap<string, number>;
  /** 中央値が無いアクティビティは null。呼び出し側が既定長へフォールバックする */
  getMedianMinutes: (activityId: string | null) => number | null;
}

export function useActivityMedianDurations(): ActivityMedianDurations {
  // 意図的に isError をハンドリングしない（`useTagEstimationFactors` と同じ理由）。
  // これは受動的なヒントで、取れなかった事実をユーザーに見せる価値が無い。
  // 失敗時は data が undefined のまま Map が空になり、目安は出ず既定長で作られる。
  const { data } = api.statistics.getActivityStats.useQuery(undefined, {
    staleTime: CACHE_5_MINUTES,
  });

  const medianByActivityId = useMemo(
    () => new Map(Object.entries(data?.medianMinutes ?? {})),
    [data],
  );

  return useMemo(
    () => ({
      medianByActivityId,
      getMedianMinutes: (activityId) =>
        activityId == null ? null : (medianByActivityId.get(activityId) ?? null),
    }),
    [medianByActivityId],
  );
}
