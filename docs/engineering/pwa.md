---
status: current
last_verified: 2026-09-14
code: apps/product/src/lib/pwa
---

# PWA Architecture

Dayopt の PWA は、ホーム画面へのインストール、静的キャッシュ、オフライン時の読み取り
フォールバックを提供する。オフライン中の書き込み保存・再送は提供しない。

## Supported Capabilities

| Capability                                        | Implementation                                          |
| ------------------------------------------------- | ------------------------------------------------------- |
| Web App Manifest                                  | `public/manifest.json`                                  |
| Service Worker registration and automatic updates | `src/lib/hooks/useServiceWorker.ts`                     |
| Static and navigation cache                       | `public/sw.js`                                          |
| Offline fallback page                             | `src/app/offline/page.tsx`                              |
| Android/Chrome install prompt                     | `src/lib/pwa/install-prompt.ts`, `InstallBanner.tsx`    |
| iOS install guide and workarounds                 | `src/lib/pwa/ios-workarounds.ts`, `IOSInstallGuide.tsx` |
| Query cache persistence                           | `src/lib/tanstack-query/persist-storage.ts`             |

Query cache persistence only restores previously fetched data. It does not persist, queue, or replay
mutations.

The persisted cache is scoped to the signed-in user. Each blob is stored under a key derived from the
authenticated user id and carries that id inside it, so a blob written by one account is never restored
for another. Restoring also deletes any blob that belongs to someone else, and signing out clears the
store entirely.

Restoring waits for the auth store to resolve the session. Offline that resolution can fail, because an
expired access token cannot be refreshed without a network. The cache owner is therefore remembered in
`localStorage` and used as a fallback, so an offline revisit by the same user still hydrates from cache.
Signing out clears that remembered owner in the same call that clears the store, which is what keeps the
fallback from ever pointing at a previous account.

## Service Worker Cache Strategy

| Request            | Strategy      | Behavior                                                                    |
| ------------------ | ------------- | --------------------------------------------------------------------------- |
| Navigation         | Network First | Network page first and refresh the cache, then cached page, then `/offline` |
| Static assets      | Cache First   | JS, CSS, fonts, and images use the network as fallback                      |
| Other GET requests | Network First | Use a cached response only when the network fails                           |
| Auth and tRPC      | No Cache      | Dynamic authenticated requests bypass the Service Worker cache              |

Cache names carry the deploying commit SHA (`dayopt-static-v<sha>`, `dayopt-dynamic-v<sha>`), passed
in as a query string when the page registers the worker (`/sw.js?v=<sha>`, see
`useServiceWorker.ts`). Every deploy therefore rotates the cache names automatically, and `activate`
deletes every `dayopt-` cache that does not match the current version. A registration without a `v`
query param (local development) falls back to `dayopt-static-vdev` / `dayopt-dynamic-vdev`.

The Service Worker has no Background Sync handler and does not access an IndexedDB mutation queue.

## Installation

### Android and Chrome

`useInstallPrompt` captures `beforeinstallprompt` and displays `InstallBanner`. Dismissing the banner
suppresses it for seven days.

### iOS Safari

Safari does not emit `beforeinstallprompt`. `IOSInstallGuide` explains the Share to Add to Home Screen
flow. `usePWAInit` also applies the iOS viewport, navigation, external-link, and Service Worker
keep-alive workarounds.

## Runtime Composition

`ServiceWorkerProvider` owns only:

- Service Worker registration
- install prompt and iOS install guide
- iOS PWA initialization

It does not initialize a mutation processor or display synchronization status.

`public/sw.js` calls `self.skipWaiting()` on install, so a new Service Worker version activates
automatically as soon as it is detected — but that does not reach pages already open.

### Applying a new deploy without a prompt

Dayopt has no update banner. A page that is older than the serving deploy reloads itself at a moment
when no edit can be lost.

`useServiceWorker` decides whether the open page is stale by comparing commit SHAs. The page knows its
own SHA from `getBuildSha()` in `src/lib/app-info.ts`. It learns the deployed SHA in two ways:

- **`controllerchange`**: another tab loaded the new deploy and its Service Worker took control. The new
  worker's `scriptURL` carries `?v=<sha>`. When that matches the page's own SHA, the page is the one that
  started the new worker and nothing happens. Comparing is what keeps a freshly loaded page from being
  told to reload.
- **Tab return**: on `visibilitychange` to visible or `focus`, at most once a minute, the page fetches
  `/api/health/version`. That route returns the build SHA without touching the database. A periodic
  `registration.update()` alone cannot find a new deploy, because the page keeps polling its own
  `/sw.js?v=<old sha>` URL.

`useApplyUpdateWhenSafe`, next to `ServiceWorkerProvider`, reloads the page once the page is stale,
visible, and safe. Safe means no mutation is in flight, the Inspector holds no create-mode or duplicate
draft, no modal or sheet is open, and no input has focus. When the page is not safe it does nothing and
checks again on the next tab return. It never reloads the instant the page becomes safe, because the user
was just interacting. A `sessionStorage` flag (`dayopt:auto-update-reloaded`) records the target SHA, so
a delayed CDN rollout cannot cause a reload loop.

Navigation requests are Network First, so the first load after a promote already renders the new HTML.

### ChunkLoadError recovery

When a deploy rotates the `_next/static` chunk hashes, a tab that is still open on the previous build
can fail to fetch a chunk it needs (`ChunkLoadError`, `Failed to fetch dynamically imported module`,
`Importing a module script failed`). `src/lib/pwa/chunk-load-recovery.ts` detects these errors and
reloads the page once, guarded by a `sessionStorage` flag
(`dayopt:chunk-reload-attempted`) so a single tab retries at most once per incident. The four route
error boundaries (`error.tsx`, `global-error.tsx`, `[locale]/error.tsx`, `[locale]/(app)/error.tsx`)
call `attemptChunkLoadRecovery` before reporting to Sentry, so the first occurrence reloads silently
and only a repeat failure (the flag already set) is captured and shown to the user.

The feature-scoped class `ErrorBoundary` (`components/ui/feedback/error-boundary.tsx`) deliberately
does **not** auto-reload. It wraps the calendar workspace, where the Inspector and inline-create
panel hold unsaved edits in stores without `persist`; an unprompted reload would discard them
silently. There the user sees the normal fallback UI and decides whether to reload. Auto-recovery is
limited to route boundaries, where the page is already dead and no draft is reachable.

## Offline Writes Decision

On June 12, 2026, Q4 of the codebase refactoring plan chose to remove the custom offline mutation
engine. The deleted implementation attempted to combine an IndexedDB queue, mutation deduplication,
Background Sync, and dynamic tRPC replay without complete conflict or end-to-end coverage.

Offline writes may be reconsidered only through a separate product and architecture plan that:

1. adopts a maintained synchronization engine rather than a custom queue;
2. defines conflict resolution and ordering semantics;
3. provides production-like integration and end-to-end coverage;
4. includes an explicit migration path for local pending data.

Until those conditions are met, failed or unavailable mutations follow the normal online error path.

## Files

```text
src/lib/pwa/
├── build-staleness.ts
├── chunk-load-recovery.ts
├── install-prompt.ts
└── ios-workarounds.ts

src/lib/hooks/
├── useInstallPrompt.ts
├── usePWA.ts
└── useServiceWorker.ts

src/lib/components/shell/
├── InstallBanner.tsx
└── IOSInstallGuide.tsx

public/
├── manifest.json
└── sw.js
```

## Verification

```bash
pnpm test -- useServiceWorker build-staleness useApplyUpdateWhenSafe
pnpm test:e2e -- src/lib/test/e2e/pwa/pwa.spec.ts
pnpm build
```

Last updated: June 12, 2026
