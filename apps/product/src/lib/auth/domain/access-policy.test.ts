import { describe, expect, it } from 'vitest';

import {
  isAuthPathAllowedWhileAuthenticated,
  isAuthProductPath,
  isProtectedProductPath,
} from './access-policy';

describe('isAuthPathAllowedWhileAuthenticated', () => {
  it.each([
    '/auth/mfa-verify',
    '/auth/confirm',
    // #1956: メール確認の結果ページ。確認リンクはログイン中の browser でも開かれるため、
    // ここから外すと「確認できたのか分からないまま /week へ飛ぶ」無言バウンスが再発する。
    '/auth/confirmed',
    '/auth/callback',
    '/auth/reset-password',
    // #2144: MFA AAL lookup失敗時の着地ページ。ここから外すと /week との無限
    // redirect ループが復活する（proxy.ts の lookupFailed / catch-all 分岐参照）。
    '/auth/session-error',
  ])('%s は認証済みでも /week へ流さない', (path) => {
    expect(isAuthProductPath(path)).toBe(true);
    expect(isAuthPathAllowedWhileAuthenticated(path)).toBe(true);
  });

  it.each(['/auth/login', '/auth/signup', '/auth/password', '/auth'])(
    '%s は認証済みなら /week へ流す',
    (path) => {
      expect(isAuthProductPath(path)).toBe(true);
      expect(isAuthPathAllowedWhileAuthenticated(path)).toBe(false);
    },
  );

  it('前方一致で誤って許可しない', () => {
    expect(isAuthPathAllowedWhileAuthenticated('/auth/confirm-evil')).toBe(false);
    expect(isAuthPathAllowedWhileAuthenticated('/auth/callback/extra')).toBe(false);
    expect(isAuthPathAllowedWhileAuthenticated('/auth/confirmed-evil')).toBe(false);
    expect(isAuthPathAllowedWhileAuthenticated('/auth/session-error-evil')).toBe(false);
  });

  // allowlist は **locale prefix を剥がした path** で比較される契約。proxy.ts が
  // getPathWithoutLocale を通してから渡しており、生の /ja/... を渡すと一致しない。
  // 「日本語だけ修正が効かない」形の回帰を防ぐため、前提を明示して固定する。
  it.each(['/ja/auth/confirmed', '/ja/auth/confirm', '/ja/auth/callback'])(
    '%s のような locale 付き path は一致しない（呼び出し側が剥がす前提）',
    (path) => {
      expect(isAuthPathAllowedWhileAuthenticated(path)).toBe(false);
    },
  );

  it('許可対象は protected path ではない（AAL 強制の対象外）', () => {
    expect(isProtectedProductPath('/auth/confirm')).toBe(false);
    expect(isProtectedProductPath('/auth/confirmed')).toBe(false);
    expect(isProtectedProductPath('/auth/reset-password')).toBe(false);
    expect(isProtectedProductPath('/auth/session-error')).toBe(false);
  });
});

describe('isProtectedProductPath', () => {
  // workspace-shell-restructure Step 1（#2190）: /calendar と /report の新設と
  // access-policy.ts への追加が同一 commit であることをこの test で固定する。
  // 分けると未認証開通と MFA gate バイパスが同時に起きる
  // （旧 docs/projects/_archive/workspace-shell-restructure/overview.md §4-5-b、
  // docs/projects 全廃に伴い #2473 で削除。git 履歴参照）。
  it.each(['/calendar', '/report'])('%s は保護対象である', (path) => {
    expect(isProtectedProductPath(path)).toBe(true);
  });

  // workspace-shell-restructure Step 6（#2181・#2195、A案裁可）: 旧URL（/day, /week,
  // /Nday）の route ファイルと workspaceViewPathPattern を削除した。旧URLは
  // proxy.ts の redirect（認可チェックより前段）が常に先に処理するため、
  // isProtectedProductPath による保護は不要になった。旧URLが未認証のまま
  // レンダリングされないことは proxy.test.ts の redirect 網羅テストが担保する。
  it.each(['/day', '/week', '/2day', '/7day'])(
    '%s（旧URL）は isProtectedProductPath の対象から外れる（redirect 層が先に処理するため）',
    (path) => {
      expect(isProtectedProductPath(path)).toBe(false);
    },
  );

  // #2637 項目 5: 廃止済み画面の path が protectedProductPaths に残っていた。
  // route が実在しないので保護してもしなくても 404 だが、prefix 一致で判定するため
  // 将来 /tags-xxx のような別 path を足した時に無言で保護対象へ入る。
  // route を新設する時は access-policy.ts への追加を同じ commit に含める（上の #2190 と同じ規約）。
  it.each(['/tasks', '/tags', '/box', '/table', '/board', '/add'])(
    '%s（廃止済み画面）は isProtectedProductPath の対象ではない',
    (path) => {
      expect(isProtectedProductPath(path)).toBe(false);
    },
  );
});
