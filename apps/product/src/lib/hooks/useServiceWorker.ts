'use client';

import { useCallback, useEffect, useState } from 'react';

import { logger } from '@/lib/logger';
import { clearDayoptCaches } from '@/lib/pwa/chunk-load-recovery';

interface ServiceWorkerState {
  /** Service Workerがサポートされているか */
  isSupported: boolean;
  /** 登録済みか */
  isRegistered: boolean;
  /** 登録中か */
  isRegistering: boolean;
  /** エラー */
  error: Error | null;
  /**
   * 表示中のページを制御する Service Worker が新バージョンへ切り替わったか
   * （`controllerchange`、初回登録時の遷移は除く。#2232）。
   * true の間、現在のページは旧シェルの JS のまま動き続けている。
   */
  updateAvailable: boolean;
}

interface UseServiceWorkerResult extends ServiceWorkerState {
  /** キャッシュをクリア */
  clearCache: () => Promise<void>;
  /** 新バージョンを適用するためページをリロードする */
  applyUpdate: () => void;
}

/**
 * Service Worker を管理するフック
 *
 * sw.js は install 時に skipWaiting するため新バージョンは検出後すぐ有効化されるが、
 * **開きっぱなしのページには反映されない**。新 SW が制御を得た（`controllerchange`）
 * ことを検出し、`updateAvailable` で呼び出し側（`ServiceWorkerProvider`）に伝える。
 * 実際のリロードは `applyUpdate()` を呼ぶまで行わない（編集中データの喪失を避ける
 * ため、フックが勝手にリロードすることはない）。
 *
 * @example
 * ```tsx
 * const { isRegistered, clearCache, updateAvailable, applyUpdate } = useServiceWorker()
 * ```
 */
export function useServiceWorker(): UseServiceWorkerResult {
  const [state, setState] = useState<ServiceWorkerState>({
    isSupported: false,
    isRegistered: false,
    isRegistering: false,
    error: null,
    updateAvailable: false,
  });

  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  // Service Worker 登録
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    // 開発環境ではService Workerを登録しない（HMRとの競合を防止）
    if (process.env.NODE_ENV === 'development') {
      setState((prev) => ({ ...prev, isSupported: true }));
      return;
    }

    setState((prev) => ({ ...prev, isSupported: true, isRegistering: true }));

    const registerSW = async () => {
      try {
        // デプロイごとにSWを更新するためのバージョン文字列
        // Vercel: NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
        // フォールバック: ビルド時刻ベース
        const swVersion =
          process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ||
          process.env.NEXT_PUBLIC_BUILD_ID ||
          '';
        const swUrl = swVersion ? `/sw.js?v=${swVersion}` : '/sw.js';

        const reg = await navigator.serviceWorker.register(swUrl, {
          scope: '/',
        });

        setRegistration(reg);
        setState((prev) => ({
          ...prev,
          isRegistered: true,
          isRegistering: false,
        }));

        // 定期的に更新チェック（1時間ごと）。sw.js は install 時に skipWaiting するため、
        // 検出した新バージョンは次回リロードで自動的に有効化される（通知 UI は持たない）

        setInterval(
          () => {
            reg.update();
          },
          60 * 60 * 1000,
        );
      } catch (error) {
        logger.error('[SW] Registration failed:', error);
        setState((prev) => ({
          ...prev,
          isRegistering: false,
          error: error instanceof Error ? error : new Error('Registration failed'),
        }));
      }
    };

    // ページ読み込み完了後に登録
    if (document.readyState === 'complete') {
      registerSW();
      return;
    }

    window.addEventListener('load', registerSW);
    return () => window.removeEventListener('load', registerSW);
  }, []);

  // 新 SW への切替検出（controllerchange）
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    if (process.env.NODE_ENV === 'development') {
      return;
    }

    // クロージャに固定する（cleanup 時点で navigator.serviceWorker が
    // 差し替え・解体済みでも、登録した addEventListener と同じ参照で外せるように）
    const sw = navigator.serviceWorker;

    // 初回登録時（このページ読み込みが最初に SW の制御下に入る瞬間）は
    // controller が null → 非null へ一度だけ変わる。これは「更新」ではないので
    // 除外する（既存 controller が居る状態で始まった時だけ、以後の変化を更新として扱う）。
    let hasController = sw.controller !== null;

    const handleControllerChange = () => {
      if (!hasController) {
        // 初回登録の遷移。以後の controllerchange から更新として扱う
        hasController = true;
        return;
      }
      setState((prev) => ({ ...prev, updateAvailable: true }));
    };

    sw.addEventListener('controllerchange', handleControllerChange);
    return () => sw.removeEventListener('controllerchange', handleControllerChange);
  }, []);

  const applyUpdate = useCallback(() => {
    window.location.reload();
  }, []);

  // キャッシュクリア
  const clearCache = useCallback(async () => {
    if (!registration?.active) return;

    registration.active.postMessage({ type: 'CLEAR_CACHE' });

    // 追加でブラウザキャッシュもクリア（ChunkLoadError 復帰と共通のロジック）
    await clearDayoptCaches();
  }, [registration]);

  return {
    ...state,
    clearCache,
    applyUpdate,
  };
}
