/**
 * `waitForResolvedUserId` の待ち合わせとフォールバック（#2619）。
 *
 * 永続化 cache の復元はこの解決を待つ。早すぎる null は「復元されない」、解決しないままだと
 * `isRestoring` が下りず query が fetch を待ち続けるので、両側を固定する。
 * オフライン（session を refresh できない）でも自分の cache は復元できることも固定する。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForResolvedUserId } from './resolve-user-id';
import { useAuthStore } from './useAuthStore';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {} }) }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const store = vi.hoisted(() => ({ lastKnown: null as string | null }));
vi.mock('@/lib/tanstack-query/cache-owner', () => ({
  readLastKnownUserId: () => store.lastKnown,
  rememberLastKnownUserId: (userId: string) => {
    store.lastKnown = userId;
  },
  forgetLastKnownUserId: () => {
    store.lastKnown = null;
  },
}));

const USER = { id: 'user-a' } as never;

beforeEach(() => {
  store.lastKnown = null;
  useAuthStore.setState({ user: null, session: null, loading: true, error: null });
});

describe('waitForResolvedUserId', () => {
  it('解決済みなら即座に user id を返す', async () => {
    useAuthStore.setState({ user: USER, loading: false });

    await expect(waitForResolvedUserId()).resolves.toBe('user-a');
  });

  it('解決した所有者を記憶する', async () => {
    useAuthStore.setState({ user: USER, loading: false });

    await waitForResolvedUserId();

    expect(store.lastKnown).toBe('user-a');
  });

  it('記憶が無く未認証なら null を返す', async () => {
    useAuthStore.setState({ user: null, loading: false });

    await expect(waitForResolvedUserId()).resolves.toBeNull();
  });

  // 復元は mount 直後に走るので、通常はまだ loading 中。ここで待てることが本 fix の前提。
  it('loading 中は解決を待ち、確定した user id を返す', async () => {
    const pending = waitForResolvedUserId();

    useAuthStore.setState({ user: USER, loading: false });

    await expect(pending).resolves.toBe('user-a');
  });

  // オフラインで access token が期限切れだと refresh に失敗し、store は user: null に落ちる。
  // ここで諦めると、オフラインでこそ効いてほしい cache 復元が働かない。
  it('session を解決できなくても、記憶している所有者へフォールバックする', async () => {
    store.lastKnown = 'user-a';
    useAuthStore.setState({ user: null, loading: false });

    await expect(waitForResolvedUserId()).resolves.toBe('user-a');
  });

  it('上限まで解決しない場合も記憶している所有者へフォールバックする', async () => {
    store.lastKnown = 'user-a';
    vi.useFakeTimers();
    try {
      const pending = waitForResolvedUserId(50);
      vi.advanceTimersByTime(50);

      await expect(pending).resolves.toBe('user-a');
    } finally {
      vi.useRealTimers();
    }
  });

  // sign-out は clearPersistedQueryCache 経由で記憶も消す。消えていれば復元しない。
  it('記憶が消えていれば解決できない時に復元しない', async () => {
    store.lastKnown = null;
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
