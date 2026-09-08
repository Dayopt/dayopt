# PWA E2E Tests

`pwa.spec.ts` verifies the PWA capabilities that remain part of the product:

- a valid web app manifest
- Service Worker registration in production builds
- cached navigation or the `/offline` fallback when the network is unavailable

The application no longer persists or replays mutations while offline. Offline mutation queue,
Background Sync, and synchronization-status UI tests do not belong in this suite.

## Run

```bash
pnpm test:e2e -- src/lib/test/e2e/pwa/pwa.spec.ts
```

Service Worker tests require a production build because `useServiceWorker` intentionally skips
registration under `next dev`:

```bash
pnpm build
pnpm --filter @dayopt/product start
pnpm test:e2e -- src/lib/test/e2e/pwa/pwa.spec.ts
```

The manifest test can run against the normal Playwright development server. The Service Worker
tests only run in CI (`process.env.CI`), where `playwright.config.ts` starts a production build with
`pnpm build && pnpm start` — the SW is not registered by the dev server. They also need a
service-role Supabase target, because the SW only mounts inside the authenticated `(app)` layout, so
the suite seeds and deletes its own test user.

## Scope Boundary

Keep these behaviors:

- manifest and home-screen installation
- Android/Chrome install prompt and iOS install guide
- static asset and navigation caching
- `/offline` fallback
- Service Worker update notification

Do not reintroduce a custom mutation queue here. Reliable offline writes require a separately
approved architecture based on a maintained synchronization engine and explicit conflict semantics.
