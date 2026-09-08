---
status: current
last_verified: 2026-09-08
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
store entirely. Restoring waits for the auth store to resolve the session, so an offline revisit by the
same user still hydrates from cache as before.

## Service Worker Cache Strategy

| Request            | Strategy               | Behavior                                                                     |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| Navigation         | Stale While Revalidate | Cached page first, refresh cache in the background, then `/offline` fallback |
| Static assets      | Cache First            | JS, CSS, fonts, and images use the network as fallback                       |
| Other GET requests | Network First          | Use a cached response only when the network fails                            |
| Auth and tRPC      | No Cache               | Dynamic authenticated requests bypass the Service Worker cache               |

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

It does not initialize a mutation processor or display synchronization status. It also does not
display an update-available notification: `public/sw.js` calls `self.skipWaiting()` on install, so a
new Service Worker version activates automatically and takes effect on the next page load. There is
no user-facing "update" action to trigger.

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
pnpm test -- useServiceWorker
pnpm test:e2e -- src/lib/test/e2e/pwa/pwa.spec.ts
pnpm build
```

Last updated: June 12, 2026
