'use client';

import { InstallBanner } from '@/components/shell/InstallBanner';
import { IOSInstallGuide } from '@/components/shell/IOSInstallGuide';
import { useInstallPrompt } from '@/lib/hooks/useInstallPrompt';
import { usePWAInit } from '@/lib/hooks/usePWA';
import { useServiceWorker } from '@/lib/hooks/useServiceWorker';

import { useApplyUpdateWhenSafe } from './useApplyUpdateWhenSafe';

/**
 * Service Worker プロバイダー
 *
 * Service Workerの登録・PWAインストール促進・iOS対応を提供
 *
 * Context を持たない副作用だけの component なので children を包まない。包むと
 * `dynamic(..., { ssr: false })` の chunk 到着まで app 本体の描画が止まる（#2747）。
 */
export function ServiceWorkerProvider() {
  // sw.js は install 時に skipWaiting で自動更新するが、開きっぱなしの画面には
  // 反映されない。古いと分かったら、編集を失わない瞬間に黙ってリロードする（通知は出さない）
  const { updateAvailable, latestVersion, applyUpdate } = useServiceWorker();
  useApplyUpdateWhenSafe({ updateAvailable, latestVersion, applyUpdate });

  const { shouldShowBanner, promptInstall, dismissBanner, shouldShowIOSGuide, dismissIOSGuide } =
    useInstallPrompt();

  // PWA 共通初期化（iOS workarounds, SW keep-alive等）
  usePWAInit();

  return (
    <>
      {/* インストール促進バナー */}
      {shouldShowBanner && <InstallBanner onInstall={promptInstall} onDismiss={dismissBanner} />}

      {/* iOS Safari 向けインストールガイド（Android/Chrome バナーとは排他表示） */}
      {!shouldShowBanner && shouldShowIOSGuide && <IOSInstallGuide onDismiss={dismissIOSGuide} />}
    </>
  );
}
