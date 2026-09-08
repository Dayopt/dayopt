/**
 * 認証主体の変化で query cache を破棄する境界（#2619）。
 *
 * sign-out が soft navigation で行われるため、memory 上の QueryClient と IndexedDB の両方を
 * 明示的に捨てないと、同じタブ・同じブラウザの次のユーザーへ前ユーザーのデータが残る。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryCacheAuthBoundary } from './QueryCacheAuthBoundary';

const clearPersistedQueryCache = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const authState = vi.hoisted(() => ({
  current: { user: null as { id: string } | null, loading: true },
}));

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: typeof authState.current) => unknown) =>
    selector(authState.current),
}));
vi.mock('@/lib/tanstack-query/persist-storage', () => ({ clearPersistedQueryCache }));

function renderBoundary() {
  const queryClient = new QueryClient();
  const clear = vi.spyOn(queryClient, 'clear');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <QueryCacheAuthBoundary />
    </QueryClientProvider>,
  );

  const rerender = () =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <QueryCacheAuthBoundary />
      </QueryClientProvider>,
    );

  return { clear, rerender };
}

function setAuth(user: { id: string } | null, loading = false) {
  authState.current = { user, loading };
}

beforeEach(() => {
  clearPersistedQueryCache.mockClear();
  setAuth(null, true);
});

describe('QueryCacheAuthBoundary', () => {
  // 初回解決（null → userId）で消すと、復元したばかりの cache を捨ててしまう。
  it('初回の user 解決では破棄しない', () => {
    const { clear, rerender } = renderBoundary();

    setAuth({ id: 'user-a' });
    rerender();

    expect(clear).not.toHaveBeenCalled();
    expect(clearPersistedQueryCache).not.toHaveBeenCalled();
  });

  it('同じ user のまま再評価されても破棄しない', () => {
    const { clear, rerender } = renderBoundary();
    setAuth({ id: 'user-a' });
    rerender();

    setAuth({ id: 'user-a' });
    rerender();

    expect(clear).not.toHaveBeenCalled();
    expect(clearPersistedQueryCache).not.toHaveBeenCalled();
  });

  it('ログアウト（user が null になる）で memory と永続 cache の両方を破棄する', () => {
    const { clear, rerender } = renderBoundary();
    setAuth({ id: 'user-a' });
    rerender();

    setAuth(null);
    rerender();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(clearPersistedQueryCache).toHaveBeenCalledTimes(1);
  });

  // ログアウトを挟まないユーザー切り替え（別タブでの sign-in 等）も同じ扱いにする。
  it('別 user へ切り替わった時も破棄する', () => {
    const { clear, rerender } = renderBoundary();
    setAuth({ id: 'user-a' });
    rerender();

    setAuth({ id: 'user-b' });
    rerender();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(clearPersistedQueryCache).toHaveBeenCalledTimes(1);
  });

  it('解決前（loading 中）の状態変化では破棄しない', () => {
    const { clear, rerender } = renderBoundary();
    setAuth({ id: 'user-a' });
    rerender();

    setAuth(null, true);
    rerender();

    expect(clear).not.toHaveBeenCalled();
    expect(clearPersistedQueryCache).not.toHaveBeenCalled();
  });
});
