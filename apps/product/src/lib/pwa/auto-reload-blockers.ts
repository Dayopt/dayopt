'use client';

import { useEffect } from 'react';

/**
 * 新しい deploy への自動リロードを止める登録口
 *
 * 自動リロード（`useApplyUpdateWhenSafe`）は、保存中の mutation や開いているダイアログを
 * 見て「今リロードしてよいか」を決める。それだけでは見えない未保存の入力
 * （保存を止めて画面にだけ残している下書きなど）を持つ component は、ここへ登録して止める。
 */
const blockers = new Set<symbol>();

/** 登録中のブロッカーがあるか */
export function isAutoReloadBlocked(): boolean {
  return blockers.size > 0;
}

/** `active` の間、自動リロードを止める */
export function useBlockAutoReload(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol('auto-reload-blocker');
    blockers.add(token);
    return () => {
      blockers.delete(token);
    };
  }, [active]);
}
