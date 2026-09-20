'use client';

import { useCallback } from 'react';

import { useBillingAccess } from '@/lib/billing/BillingAccessProvider';
import { useShellStore } from '@/lib/stores/useShellStore';

/**
 * 利用権が無い時に server が `BILLING_ACCESS_ENDED` で拒否する操作を、送る前に止める。
 *
 * server 側の判定（`lib/billing/operation-access.ts`）が正で、ここはその写し。写しが無いと
 * optimistic update が一度成功して見えた後に rollback され、汎用の「失敗しました」toast だけが
 * 残って障害と区別できない。止めた時は課金設定を開く（`useActivityQuickCreate` と同じ判断:
 * 閲覧のみである旨を toast に流用しても「なぜできないか」は伝わらない）。
 *
 * server が終了後も許す操作（削除・切断・export 等、`managementMutations`）には使わない。
 */
export function useProductAccessGate(): (run: () => void) => void {
  const { canUseProduct } = useBillingAccess();
  const openSettings = useShellStore.use.openSettings();

  return useCallback(
    (run: () => void) => {
      if (!canUseProduct) {
        openSettings('billing');
        return;
      }
      run();
    },
    [canUseProduct, openSettings],
  );
}
