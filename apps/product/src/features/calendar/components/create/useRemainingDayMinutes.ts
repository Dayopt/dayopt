'use client';

/**
 * 作成パネル用の「その日の残り時間」。
 *
 * パネルはグリッドの props を持たない（モバイルでは Drawer がグリッドを覆う）ので、
 * `useInlineCreate` の重なり判定と同じ経路で tRPC cache から予定を読む。
 * cache の変化に live 追随しないのは `hasConflict` と同じ受容範囲。
 *
 * pending selection は cache に入らない（`createPlan.mutate` はアクティビティ選択後、
 * `clearPendingSelection` の後に走る）ので、選択分を二重に引くことはない。
 * 将来 optimistic insert を clear より前に入れると、一瞬だけ選択分が余計に引かれる。
 */

import { useMemo } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { collectTimeblockLaneItems } from '@/features/timeblock';
import { getDateKey } from '@/lib/date';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

import { computeRemainingDayMinutes } from '../../lib/remaining-day-minutes';
import type { PendingSelection } from '../../stores/useInlineCreateStore';

/**
 * 選択日の残り時間（分）。選択が無ければ `null`。
 */
export function useRemainingDayMinutes(selection: PendingSelection | null): number | null {
  const queryClient = useQueryClient();
  const timezone = useUserPreferences((s) => s.timezone);

  return useMemo(() => {
    if (!selection) return null;

    const { date, startHour, startMinute, endHour, endMinute } = selection;
    const selectionMinutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);

    return computeRemainingDayMinutes({
      plans: collectTimeblockLaneItems(queryClient, 'plans').map((item) => ({
        start: item.start_at,
        end: item.end_at,
      })),
      // date は壁時計 Date。timezone を渡すと instant として再解釈され日がずれる（#2017 同型）
      dateKey: getDateKey(date),
      timezone,
      selectionMinutes,
    });
  }, [queryClient, selection, timezone]);
}
