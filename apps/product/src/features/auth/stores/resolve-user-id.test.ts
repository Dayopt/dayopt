/**
 * `waitForResolvedUserId` の待ち合わせ挙動（#2619）。
 *
 * 永続化 cache の復元はこの解決を待つ。早すぎる null は「復元されない」、
 * 解決しないままだと `isRestoring` が下りず query が fetch を待ち続けるので、
 * 両側（解決する／打ち切る）を固定する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForResolvedUserId } from './resolve-user-id';
import { useAuthStore } from './useAuthStore';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {} }) }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const USER = { id: 'user-a' } as never;

beforeEach(() => {
  useAuthStore.setState({ user: null, session: null, loading: true, error: null });
});

describe('waitForResolvedUserId', () => {
  it('解決済みなら即座に user id を返す', async () => {
    useAuthStore.setState({ user: USER, loading: false });

    await expect(waitForResolvedUserId()).resolves.toBe('user-a');
  });

  it('解決済みで未認証なら null を返す', async () => {
    useAuthStore.setState({ user: null, loading: false });

    await expect(waitForResolvedUserId()).resolves.toBeNull();
  });

  // 復元は mount 直後に走るので、通常はまだ loading 中。ここで待てることが本 fix の前提。
  it('loading 中は解決を待ち、確定した user id を返す', async () => {
    const pending = waitForResolvedUserId();

    useAuthStore.setState({ user: USER, loading: false });

    await expect(pending).resolves.toBe('user-a');
  });

  it('上限まで解決しなければ null で打ち切る（復元を諦めて query を進ませる）', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForResolvedUserId(50);
      vi.advanceTimersByTime(50);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
