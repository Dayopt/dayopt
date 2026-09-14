'use client';

import { useCallback, useEffect, useState } from 'react';

import { getBuildSha } from '@/lib/app-info';
import { logger } from '@/lib/logger';
import {
  isStaleAgainstDeployed,
  isStaleOnControllerChange,
  readServiceWorkerVersion,
} from '@/lib/pwa/build-staleness';
import { clearDayoptCaches } from '@/lib/pwa/chunk-load-recovery';

/** 配信中のビルドの版を返すエンドポイント */
const DEPLOYED_VERSION_ENDPOINT = '/api/health/version';

/** タブ復帰ごとの版確認の最短間隔。切り替えを連打しても 1 分に 1 回しか叩かない */
const DEPLOYED_VERSION_PROBE_INTERVAL_MS = 60_000;

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
   * 表示中のページが、配信中の最新ビルドより古いか。
   * 新 SW への切替（`controllerchange`）かタブ復帰時の版確認で、SHA が食い違った時だけ true。
   */
  updateAvailable: boolean;
  /** 検知した最新ビルドの版。分からなければ null（自動リロードの重複防止キーに使う） */
  latestVersion: string | null;
}

interface UseServiceWorkerResult extends ServiceWorkerState {
  /** キャッシュをクリア */
  clearCache: () => Promise<void>;
  /** 新バージョンを適用するためページをリロードする */
  applyUpdate: () => void;
}

function isDeployedVersionPayload(value: unknown): value is { commitSha: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { commitSha?: unknown }).commitSha === 'string'
  );
}

/**
 * Service Worker を管理するフック
 *
 * sw.js は install 時に skipWaiting するため新バージョンは検出後すぐ有効化されるが、
 * **開きっぱなしのページには反映されない**。このフックは「表示中のページが古い」ことを
 * `updateAvailable` で伝えるだけで、自分ではリロードしない。いつリロードしてよいかは
 * 編集中かどうかを知る呼び出し側（`useApplyUpdateWhenSafe`）が決める。
 *
 * 古さの検知経路は 2 つ:
 * - `controllerchange`: 別のタブが新しい deploy を開き、新 SW が制御を得た時。
 *   ページ自身の SHA と新 SW の SHA が同じなら（自分が新版を起動した側なら）無視する
 * - タブ復帰（`visibilitychange` / `focus`）: `/api/health/version` を叩いて SHA を比べる。
 *   sw.js の登録 URL は旧版のままなので、`reg.update()` だけでは新しい deploy を見つけられない
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
    latestVersion: null,
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
        // デプロイごとにSWを更新するためのバージョン文字列（Vercel の commit SHA）
        const buildSha = getBuildSha();
        const swUrl = buildSha ? `/sw.js?v=${buildSha}` : '/sw.js';

        const reg = await navigator.serviceWorker.register(swUrl, {
          scope: '/',
        });

        setRegistration(reg);
        setState((prev) => ({
          ...prev,
          isRegistered: true,
          isRegistering: false,
        }));

        // 定期的に更新チェック（1時間ごと）。登録 URL は自分の版のままなので、拾えるのは
        // sw.js 自体の中身が変わった時だけ。新しい deploy の検知はタブ復帰時の版確認が担う
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
      const scriptUrl = sw.controller?.scriptURL;
      if (!isStaleOnControllerChange(getBuildSha(), scriptUrl)) {
        // このページ自身が新しい deploy の SW を起動した。既に最新なので何もしない
        return;
      }
      const controllerVersion = readServiceWorkerVersion(scriptUrl);
      setState((prev) => ({
        ...prev,
        updateAvailable: true,
        latestVersion: controllerVersion ?? prev.latestVersion,
      }));
    };

    sw.addEventListener('controllerchange', handleControllerChange);
    return () => sw.removeEventListener('controllerchange', handleControllerChange);
  }, []);

  // タブ復帰時に配信中の版を確認する
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const buildSha = getBuildSha();
    if (process.env.NODE_ENV === 'development' || !buildSha) {
      // SHA を持たないビルドでは比較できない
      return;
    }

    let lastProbeAt = Date.now();
    let cancelled = false;

    const probe = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastProbeAt < DEPLOYED_VERSION_PROBE_INTERVAL_MS) return;
      lastProbeAt = now;

      try {
        const response = await fetch(DEPLOYED_VERSION_ENDPOINT, { cache: 'no-store' });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        if (cancelled || !isDeployedVersionPayload(payload)) return;
        if (!isStaleAgainstDeployed(buildSha, payload.commitSha)) return;
        setState((prev) => ({
          ...prev,
          updateAvailable: true,
          latestVersion: payload.commitSha,
        }));
      } catch {
        // オフラインや一時的な失敗。次の復帰でまた確認する
      }
    };

    const handleVisible = () => {
      void probe();
    };

    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
    };
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
