import { dayoptBrand } from '@dayopt/config';

export const APP_NAME = dayoptBrand.name;
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown';
export const APP_RELEASES_URL = 'https://github.com/Dayopt/dayopt/releases';
/**
 * このビルドの commit SHA（先頭 8 桁）。Vercel 以外のビルドでは空文字。
 *
 * Service Worker の登録 URL（`/sw.js?v=<sha>`）と `/api/health/version` が同じ値を使い、
 * 開いているページが最新 deploy より古いかを比べる（`lib/pwa/build-staleness.ts`）。
 */
export function getBuildSha(): string {
  // 呼び出し時に読む（ビルドでは inline され定数になる。test は env を差し替えられる）
  return (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 8);
}
