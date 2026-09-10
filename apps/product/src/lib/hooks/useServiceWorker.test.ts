import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useServiceWorker } from './useServiceWorker';

describe('useServiceWorker', () => {
  let mockRegistration: {
    installing: ServiceWorker | null;
    waiting: ServiceWorker | null;
    active: ServiceWorker | null;
    scope: string;
    updateViaCache: ServiceWorkerUpdateViaCache;
    addEventListener: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let mockServiceWorker: Partial<ServiceWorker>;

  beforeEach(() => {
    mockServiceWorker = {
      postMessage: vi.fn(),
      state: 'activated',
      addEventListener: vi.fn(),
    };

    mockRegistration = {
      installing: null,
      waiting: null,
      active: mockServiceWorker as ServiceWorker,
      scope: '/',
      updateViaCache: 'none',
      addEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };

    // Service Worker APIのモック
    const mockNavigator = {
      serviceWorker: {
        register: vi.fn().mockResolvedValue(mockRegistration),
        controller: mockServiceWorker,
        ready: Promise.resolve(mockRegistration),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    };

    vi.stubGlobal('navigator', mockNavigator);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });

    // CI環境でバージョン付きURLにならないようenv変数をクリア
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_BUILD_ID;

    // NODE_ENV を production に設定（development だと早期returnされる）
    vi.stubEnv('NODE_ENV', 'production');

    // document.readyState のモック
    Object.defineProperty(document, 'readyState', {
      value: 'complete',
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('初期状態', () => {
    it('Service Worker がサポートされている場合、isSupported が true', async () => {
      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isSupported).toBe(true);
      });
    });

    it('登録成功後、isRegistered が true', async () => {
      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isRegistered).toBe(true);
      });
    });
  });

  describe('Service Worker 登録', () => {
    it('sw.js を登録する', async () => {
      renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js', {
          scope: '/',
        });
      });
    });

    it('commit SHA があれば ?v= 付きで登録する（キャッシュ名の deploy ごとローテーション）', async () => {
      // sw.js は登録 URL の `v` から CACHE_VERSION を導出する。ここが無言で
      // bare `/sw.js` に戻ると全 deploy が `dayopt-*-vdev` を共有し、#2688 の
      // 修正が効かなくなる
      vi.stubEnv('NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', 'abcdef1234567890');

      renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js?v=abcdef12', {
          scope: '/',
        });
      });
    });

    it('登録エラー時、error が設定される', async () => {
      const error = new Error('Registration failed');
      vi.mocked(navigator.serviceWorker.register).mockRejectedValue(error);

      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.error).toEqual(error);
        expect(result.current.isRegistered).toBe(false);
      });
    });
  });

  describe('キャッシュクリア', () => {
    it('clearCache が dayopt- プレフィックスのキャッシュを削除', async () => {
      vi.mocked(window.caches.keys).mockResolvedValue([
        'dayopt-v1',
        'dayopt-static-v1',
        'other-cache',
      ]);

      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isRegistered).toBe(true);
      });

      await act(async () => {
        await result.current.clearCache();
      });

      expect(window.caches.delete).toHaveBeenCalledWith('dayopt-v1');
      expect(window.caches.delete).toHaveBeenCalledWith('dayopt-static-v1');
      expect(window.caches.delete).not.toHaveBeenCalledWith('other-cache');
    });
  });

  describe('非対応環境', () => {
    it('Service Worker 非対応ブラウザでは isSupported が false', () => {
      // navigator.serviceWorker を undefined にする
      vi.stubGlobal('navigator', {});

      const { result } = renderHook(() => useServiceWorker());

      expect(result.current.isSupported).toBe(false);
      expect(result.current.isRegistered).toBe(false);
    });
  });

  describe('controllerchange（#2232）', () => {
    /** navigator.serviceWorker.addEventListener('controllerchange', ...) に渡されたハンドラを取り出す */
    function getControllerChangeHandler(): () => void {
      const call = vi
        .mocked(navigator.serviceWorker.addEventListener)
        .mock.calls.find(([event]) => event === 'controllerchange');
      if (!call) throw new Error('controllerchange リスナーが登録されていない');
      return call[1] as () => void;
    }

    it('既存 controller がいる状態で始まった場合、controllerchange で updateAvailable が true になる', async () => {
      // beforeEach の mockNavigator は controller = mockServiceWorker（既存 controller あり）
      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isRegistered).toBe(true);
      });
      expect(result.current.updateAvailable).toBe(false);

      act(() => {
        getControllerChangeHandler()();
      });

      expect(result.current.updateAvailable).toBe(true);
    });

    it('初回登録時（controller が null → 非null）の controllerchange では updateAvailable が false のまま', async () => {
      // controller を null にして「まだ誰も制御していない」初回登録状態を再現
      const mockNavigator = {
        serviceWorker: {
          register: vi.fn().mockResolvedValue(mockRegistration),
          controller: null,
          ready: Promise.resolve(mockRegistration),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      };
      vi.stubGlobal('navigator', mockNavigator);

      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isRegistered).toBe(true);
      });

      act(() => {
        getControllerChangeHandler()();
      });

      // 初回遷移は無視される
      expect(result.current.updateAvailable).toBe(false);

      // 2回目（本当の更新）からは検出される
      act(() => {
        getControllerChangeHandler()();
      });
      expect(result.current.updateAvailable).toBe(true);
    });

    it('applyUpdate はページをリロードする', async () => {
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
      });

      const { result } = renderHook(() => useServiceWorker());

      await waitFor(() => {
        expect(result.current.isRegistered).toBe(true);
      });

      act(() => {
        result.current.applyUpdate();
      });

      expect(reloadMock).toHaveBeenCalledOnce();
    });
  });
});
