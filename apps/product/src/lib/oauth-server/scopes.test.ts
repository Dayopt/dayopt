import { describe, expect, it } from 'vitest';

import {
  ADVERTISED_SCOPES,
  SUPPORTED_SCOPES,
  hasWriteScope,
  isSupportedScope,
  resolveGrantableScopes,
} from './scopes';

// #2271 scope追加（PR #2267 クロスレビュー、behavior-verifier指摘の移送）。
// `isWriteScope`/`hasWriteScope` は prefix 構造判定ではなく `WRITE_SCOPES` 配列への
// enum 判定になっているため、SUPPORTED_SCOPES に write:/delete: prefix の scope を
// 追加しても WRITE_SCOPES へ足し忘れれば型エラーにならず applyDurableWriteGate を
// 静かにすり抜ける。`WRITE_SCOPES` を直接 import せず、公開 API である hasWriteScope
// 経由で「SUPPORTED_SCOPES 中の write:/delete: prefix 全量が write scope として
// 検出されるか」を assert することで、新規 scope 追加時にもこの test が自動で対象に
// 含まれる（ハードコードした scope 名の列挙に依存しない）。
describe('WRITE_SCOPES 網羅性 invariant', () => {
  const writePrefixedScopes = SUPPORTED_SCOPES.filter(
    (scope) => scope.startsWith('write:') || scope.startsWith('delete:'),
  );
  const readOnlyScopes = SUPPORTED_SCOPES.filter(
    (scope) => !scope.startsWith('write:') && !scope.startsWith('delete:'),
  );

  it('前提: SUPPORTED_SCOPES に write:/delete: prefix の scope が存在する', () => {
    expect(writePrefixedScopes.length).toBeGreaterThan(0);
  });

  it.each(writePrefixedScopes)('%s は hasWriteScope から write scope として検出される', (scope) => {
    expect(isSupportedScope(scope)).toBe(true);
    expect(hasWriteScope([scope])).toBe(true);
  });

  it.each(readOnlyScopes)('%s は hasWriteScope から write scope として検出されない', (scope) => {
    expect(hasWriteScope([scope])).toBe(false);
  });
});

// #1754 write closed beta。広告を全 scope へ広げたので、gate が閉じている client の
// consent が grant RPC（42501 / DM003）で失敗しないよう、付与側で降格する。
describe('resolveGrantableScopes', () => {
  const requestedWithWrite = [
    'read:entries',
    'read:activities',
    'write:plans',
    'delete:records',
  ] as const;

  it('write gate が開いている client には要求どおり write を付与する', () => {
    expect(resolveGrantableScopes(requestedWithWrite, true)).toEqual([...requestedWithWrite]);
  });

  it('write gate が閉じている client では write / delete を落として read だけ付与する', () => {
    expect(resolveGrantableScopes(requestedWithWrite, false)).toEqual([
      'read:entries',
      'read:activities',
    ]);
  });

  it('read のみの要求は gate の状態に関わらずそのまま付与する', () => {
    const readOnly = ['read:entries', 'read:stats'] as const;
    expect(resolveGrantableScopes(readOnly, false)).toEqual([...readOnly]);
    expect(resolveGrantableScopes(readOnly, true)).toEqual([...readOnly]);
  });

  it('広告済み scope 全量を要求されても gate 閉なら write scope は 1 つも残らない', () => {
    const granted = resolveGrantableScopes(ADVERTISED_SCOPES, false);
    expect(hasWriteScope(granted)).toBe(false);
    expect(granted.length).toBeGreaterThan(0);
  });
});
