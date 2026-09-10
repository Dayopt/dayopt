import { dayoptDomains, dayoptUrls } from '@dayopt/config';

/**
 * アプリのベースURLを取得する
 * 優先順位: NEXT_PUBLIC_APP_URL > VERCEL_URL > localhost
 *
 * Metadata / sitemap / JSON-LD など、Supabase 環境変数が不要な経路でも使うため、
 * full server env validation は通さず URL に必要な値だけを直接参照する。
 */
export function getAppUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) return appUrl;

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;

  return 'http://localhost:3000';
}

/**
 * OG 画像の path（App Router の metadata file convention `app/opengraph-image.tsx`）
 *
 * `[locale]` 配下ではなく root 直下で配信されるため、next-intl の locale 解決へ渡すと
 * `/en/opengraph-image` へ rewrite されて 404 になる。`proxy.ts` の除外と metadata の
 * 参照が同じ値を見ていることを型で担保するため、ここを唯一の定義とする（#2573）。
 */
export const OG_IMAGE_PATH = '/opengraph-image';

/**
 * metadata / JSON-LD が参照する OG 画像の絶対 URL
 *
 * OG 画像を配信するのは product app 自身なので、base は product へ解決する origin で
 * なければならない。production の `NEXT_PUBLIC_APP_URL` は marketing domain を指しており
 * （2026-09-10 実測: `og:image` が `https://dayopt.app/opengraph-image` = 404）、その値を
 * そのまま使うと到達不能な URL を配る。marketing origin が来た時だけ product origin へ
 * 寄せる（#2573）。`canonical` が marketing を指す件はここでは変えない。
 */
export function getOgImageUrl(): string {
  return `${resolveOgImageOrigin(getAppUrl())}${OG_IMAGE_PATH}`;
}

function resolveOgImageOrigin(appUrl: string): string {
  try {
    const { hostname } = new URL(appUrl);
    if (hostname === dayoptDomains.marketing || hostname === dayoptDomains.www) {
      return dayoptUrls.product;
    }
  } catch {
    return dayoptUrls.product;
  }

  return appUrl;
}
