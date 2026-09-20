'use client';

/**
 * 削除の取り消しトースト。
 *
 * 削除の入口はカレンダー（キーボード / 右クリック）と Inspector に分かれているが、
 * ユーザーから見れば同じ「消す」なので、戻し方も同じにする。確認ダイアログを挟まない
 * 経路ほどここが要る（可逆は速く、AGENTS.md ルール 4）。
 *
 * 復元に渡す版は **削除が返した `updated_at`**。削除前の版だと `STALE_VERSION` で弾かれる。
 */

import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { toast } from '@/lib/toast';

import type { TimeblockDestination } from '../domain/timeblock-destination';

import { useTimeblockWriteMutations } from './useTimeblockWriteMutations';

/** 削除された行のうち、復元に要る最小の形 */
interface DeletedTimeblock {
  id: string;
  updated_at: string;
}

export function useTimeblockDeleteUndo() {
  const t = useTranslations();
  const { restorePlan, restoreRecord } = useTimeblockWriteMutations();

  return useCallback(
    (kind: TimeblockDestination, deleted: DeletedTimeblock) => {
      toast.success(t('timeblock.editor.toast.deleted'), {
        action: {
          label: t('common.undo'),
          onClick: () => {
            const input = { id: deleted.id, expectedUpdatedAt: deleted.updated_at };
            const restored =
              kind === 'plan' ? restorePlan.mutateAsync(input) : restoreRecord.mutateAsync(input);
            // 失敗の知らせは restore mutation 自身の onError が出す
            void restored.catch(() => undefined);
          },
        },
      });
    },
    [restorePlan, restoreRecord, t],
  );
}
