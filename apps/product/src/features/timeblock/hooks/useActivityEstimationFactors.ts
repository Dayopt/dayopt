'use client';

/**
 * 作成時フィードフォワード用の activity 別見積もり係数を引く hook。
 *
 * 係数は**activity 単位で draft の長さに依存しない**ので、query は 1 回だけ引いて
 * 掛け算は client の pure 関数（`projectActualMinutes`）で行う。draft の時間を
 * 動かすたびに query を撃つ必要は無く、debounce も要らない。
 *
 * #2694: 新名へ切り替える。古いclient向けのprocedure aliasはserverに残し、
 * 配信確認後に撤去する。集計の意味と取得頻度は変更しない。
 */

import { useMemo } from 'react';

import { CACHE_5_MINUTES } from '@/lib/date';
import { api } from '@/lib/trpc';

import { projectActualMinutes } from '../domain/activity-estimation-factor';

interface ActivityEstimationProjection {
  /** draft の予定時間に係数を掛けた実時間（分、5 分刻み）。 */
  minutes: number;
  /** 中央値の元になった Plan 件数。`n >= 3` が保証されている。 */
  sampleCount: number;
}

interface ActivityEstimationFactors {
  /** 条件を満たさない場合は null。呼び出し側は null で何も描画しない。 */
  project: (activityId: string | null, draftMinutes: number) => ActivityEstimationProjection | null;
}

export function useActivityEstimationFactors(): ActivityEstimationFactors {
  // 意図的に isError をハンドリングしない（`test` skill の
  // 「UI を描画する全 useQuery は ErrorState 必須」に対する明示的な例外）。
  // これは受動的なヒントで、取れなかった事実をユーザーに見せる価値が無く、
  // ErrorState を出すと ADR-026 の「静かに教える」トーンを壊す。
  // 失敗時は data が undefined のまま project() が null を返し、何も描画されない。
  const { data } = api.statistics.getActivityEstimationFactors.useQuery(undefined, {
    staleTime: CACHE_5_MINUTES,
  });

  const factorsByActivityId = useMemo(
    () => new Map((data ?? []).map((entry) => [entry.activityId, entry])),
    [data],
  );

  return useMemo(
    () => ({
      project(activityId, draftMinutes) {
        // Number.isFinite を先に見る。`NaN <= 0` は false なので、`<= 0` だけだと
        // Invalid Date 由来の NaN を素通りさせ「NaN 分」を描画してしまう。
        // Inspector は時刻入力が壊れている間も draft の値をそのまま渡してくる。
        if (activityId == null || !Number.isFinite(draftMinutes) || draftMinutes <= 0) return null;
        const entry = factorsByActivityId.get(activityId);
        if (!entry) return null;
        return {
          minutes: projectActualMinutes(entry.factor, draftMinutes),
          sampleCount: entry.sampleCount,
        };
      },
    }),
    [factorsByActivityId],
  );
}
