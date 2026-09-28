import { OG_CARD_SIZE, resolveOgCardOptions } from '@dayopt/assets/og';
import { OgCardImage } from '@dayopt/assets/og-card-image';
import { loadOgScreenshotDataUri } from '@dayopt/assets/og-screenshot';
import { dayoptBrand } from '@dayopt/config';
import { ImageResponse } from 'next/og';
import path from 'node:path';

export const runtime = 'nodejs';

export const alt = dayoptBrand.name;
export const size = OG_CARD_SIZE;
export const contentType = 'image/png';

export default async function OgImage() {
  // Product の任意 screenshot はこの名前で置く。無い間は共通 resolver が left に戻す。
  const screenshotSrc = await loadOgScreenshotDataUri(
    '/og-screenshots/product.png',
    path.join(process.cwd(), 'public'),
  );
  const options = resolveOgCardOptions({
    category: 'product',
    screenshotAvailable: Boolean(screenshotSrc),
  });

  return new ImageResponse(
    <OgCardImage
      title="Plan your day. Track your time. Optimize your life."
      category={options.category}
      layout={options.layout}
      screenshotSrc={screenshotSrc}
    />,
    { ...size },
  );
}
