import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockRefreshSession = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      refreshSession: mockRefreshSession,
    },
  }),
}));

const mockSignOut = vi.fn().mockResolvedValue(undefined);
let mockSession: { user: { id: string } } | null = { user: { id: 'user-1' } };

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ session: mockSession, signOut: mockSignOut }),
}));

vi.mock('@/lib/auth/session-config', () => ({
  SESSION_CONFIG: {
    idleTimeout: 60,
  },
  SESSION_SECURITY: {
    timeoutWarning: 30,
    logoutRedirect: '/auth/login',
    timeoutRedirect: '/auth/login?reason=timeout',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { useSessionMonitor } from './useSessionMonitor';

describe('useSessionMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: 'user-1' } };
    mockSignOut.mockResolvedValue(undefined);
    mockRefreshSession.mockResolvedValue({ error: null });
  });

  describe('初期状態', () => {
    it('セッションがある場合、初回チェック後も有効な状態を維持する', async () => {
      // 初期値trueだけで通さず、storeを参照するmicrotaskの判定まで確認する。
      const { result } = renderHook(() => useSessionMonitor());
      await act(async () => {});

      expect(result.current.isSessionValid).toBe(true);
      expect(result.current.showTimeoutWarning).toBe(false);
    });

    it('全てのプロパティが返される', () => {
      const { result } = renderHook(() => useSessionMonitor());

      expect(result.current).toHaveProperty('isSessionValid');
      expect(result.current).toHaveProperty('showTimeoutWarning');
      expect(result.current).toHaveProperty('remainingTime');
      expect(result.current).toHaveProperty('idleTime');
      expect(typeof result.current.extendSession).toBe('function');
      expect(typeof result.current.logout).toBe('function');
    });

    it('remainingTimeはidleTimeoutで初期化される', () => {
      const { result } = renderHook(() => useSessionMonitor());
      expect(result.current.remainingTime).toBeLessThanOrEqual(60);
      expect(result.current.remainingTime).toBeGreaterThanOrEqual(0);
    });

    it('idleTimeは0以上の数値', () => {
      const { result } = renderHook(() => useSessionMonitor());
      expect(result.current.idleTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extendSession', () => {
    it('Supabaseのセッション更新を呼ぶ', async () => {
      const { result } = renderHook(() => useSessionMonitor());

      await act(async () => {
        await result.current.extendSession();
      });

      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    });

    it('更新失敗時にlogger.errorが呼ばれる', async () => {
      mockRefreshSession.mockResolvedValue({ error: new Error('failed') });
      const { logger } = await import('@/lib/logger');

      const { result } = renderHook(() => useSessionMonitor());

      await act(async () => {
        await result.current.extendSession();
      });

      expect(logger.error).toHaveBeenCalled();
    });

    it('例外が発生してもクラッシュしない', async () => {
      mockRefreshSession.mockRejectedValue(new Error('network'));
      const { logger } = await import('@/lib/logger');

      const { result } = renderHook(() => useSessionMonitor());

      await act(async () => {
        await result.current.extendSession();
      });

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('logoutを呼ぶとリダイレクトされる', async () => {
      // 遷移だけでなく意図したstore actionが実際に呼ばれたことを確認する。
      const { result } = renderHook(() => useSessionMonitor());

      await act(async () => {
        await result.current.logout();
      });

      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/auth/login');
    });

    it('signOutエラーでもリダイレクトする', async () => {
      // 別の例外で通らないよう、注入したrejectとcatchの対応も確認する。
      mockSignOut.mockRejectedValueOnce(new Error('fail'));
      const { logger } = await import('@/lib/logger');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useSessionMonitor());

      await act(async () => {
        await result.current.logout();
      });

      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        '[SessionMonitor] Logout error:',
        expect.objectContaining({ message: 'fail' }),
      );
      expect(mockPush).toHaveBeenCalledWith('/auth/login');
      spy.mockRestore();
    });
  });
});
