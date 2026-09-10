/**
 * Dayopt Service Worker
 *
 * オフライン対応とキャッシング戦略を提供
 *
 * バージョニング戦略:
 * - SW自体はクエリパラメータでバージョン管理（useServiceWorker.ts が
 *   `/sw.js?v=<commit sha>` で登録する）
 * - キャッシュ名にはそのバージョン文字列をそのまま含める。commit SHA は deploy ごとに
 *   変わるため、deploy のたびにキャッシュ名が自動的にローテーションし、
 *   `activate` イベントが旧バージョンのキャッシュを削除する（手動インクリメント不要）
 * - v が付かない登録（ローカル開発等）では 'dev' にフォールバックする
 */

// SW内ログ: 開発時のみ出力（本番ではno-op）
const __SW_DEBUG__ = typeof location !== 'undefined' && location.hostname === 'localhost';
const swLog = __SW_DEBUG__ ? console.log.bind(console) : () => {};

// キャッシュバージョン: 登録 URL のクエリパラメータ（commit SHA）から取得する
const CACHE_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const STATIC_CACHE_NAME = `dayopt-static-v${CACHE_VERSION}`;
const DYNAMIC_CACHE_NAME = `dayopt-dynamic-v${CACHE_VERSION}`;

// 静的アセット（ビルド時に確定するファイル）
const STATIC_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// キャッシュ対象のパターン
const CACHE_PATTERNS = {
  // 静的ファイル（長期キャッシュ）
  static: /\.(js|css|woff2?|png|jpg|jpeg|gif|svg|ico|webp|avif)$/i,
  // APIレスポンス（短期キャッシュ）
  api: /^\/api\//,
  // Next.jsの静的ファイル
  nextStatic: /^\/_next\/static\//,
};

// キャッシュしないパターン
const NO_CACHE_PATTERNS = [
  /^\/_next\/webpack-hmr/, // HMR
  /^\/api\/auth/, // 認証API
  /^\/api\/trpc/, // tRPC API（動的データ）
];

/**
 * Service Worker インストール
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE_NAME)
      .then((cache) => {
        swLog('[SW] Caching static assets');
        // addAll は 1 つでも 404 だと全体が reject し、install が完了しない。
        // すると skipWaiting に到達せず activate の旧キャッシュ削除も走らないため、
        // precache の URL が 1 つ腐っただけで SW 全体が永久に更新されなくなる
        // （実際 /icon-192.png の path 誤りで長期間この状態だった）。
        // precache は best-effort とし、個別の失敗は握って install を通す。
        return Promise.all(
          STATIC_ASSETS.map((asset) =>
            cache.add(asset).catch((error) => {
              swLog('[SW] Failed to precache:', asset, error);
            }),
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

/**
 * Service Worker アクティベート
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              // 古いキャッシュを削除
              return (
                name.startsWith('dayopt-') &&
                name !== STATIC_CACHE_NAME &&
                name !== DYNAMIC_CACHE_NAME
              );
            })
            .map((name) => {
              swLog('[SW] Deleting old cache:', name);
              return caches.delete(name);
            }),
        );
      })
      .then(() => self.clients.claim()),
  );
});

/**
 * フェッチイベントハンドラー
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 同一オリジンのみ処理
  if (url.origin !== location.origin) {
    return;
  }

  // キャッシュしないパターンをチェック
  if (NO_CACHE_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return;
  }

  // ナビゲーションリクエスト（HTMLページ）
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request, event));
    return;
  }

  // 静的アセット
  if (CACHE_PATTERNS.static.test(url.pathname) || CACHE_PATTERNS.nextStatic.test(url.pathname)) {
    event.respondWith(handleStaticRequest(request));
    return;
  }

  // その他のリクエスト
  event.respondWith(handleDynamicRequest(request));
});

/**
 * ナビゲーションリクエストの処理
 * Stale-While-Revalidate: キャッシュがあれば即返し、
 * バックグラウンドでネットワークfetchしてキャッシュを更新する
 */
async function handleNavigationRequest(request, event) {
  const cache = await caches.open(DYNAMIC_CACHE_NAME);
  const cached = await cache.match(request);

  // バックグラウンドでネットワークfetch → キャッシュ更新（次回用）
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // バックグラウンドfetchをworkerのlifetimeに結びつける
    event.waitUntil(fetchPromise);
    return cached;
  }

  // キャッシュがない場合はネットワークを待つ
  const networkResponse = await fetchPromise;
  if (networkResponse) {
    return networkResponse;
  }

  // どちらもない場合はオフラインフォールバック
  const offlineResponse = await caches.match('/offline');
  if (offlineResponse) {
    return offlineResponse;
  }
  return new Response('オフラインです', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 静的アセットの処理
 * Cache First with Network Fallback
 */
async function handleStaticRequest(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    return new Response('Resource not available', { status: 404 });
  }
}

/**
 * 動的リクエストの処理
 * Network First with Cache Fallback
 */
async function handleDynamicRequest(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok && request.method === 'GET') {
      const cache = await caches.open(DYNAMIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw error;
  }
}

/**
 * メッセージハンドラー
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('dayopt-'))
            .map((name) => caches.delete(name)),
        );
      }),
    );
  }

  // iOS Safari SW キャッシュ7日制限対策: keep-alive ping
  if (event.data && event.data.type === 'KEEP_ALIVE') {
    // SWがアクティブ状態を維持するだけで十分
    swLog('[SW] Keep-alive ping received');
  }
});
