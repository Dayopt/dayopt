import { OG_CARD_SIZE, resolveOgCardOptions } from '@dayopt/assets/og';
import { OgCardImage } from '@dayopt/assets/og-card-image';
import { loadOgScreenshotDataUri } from '@dayopt/assets/og-screenshot';
import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import path from 'node:path';

import { captureUnexpectedWebError } from '@web/platform/observability/capture-unexpected-error';
import {
  getClientIp,
  hashRateLimitIdentifier,
  ogImageGlobalRateLimit,
  ogImageRateLimit,
} from '@web/platform/security/rate-limit';

import { OG_FALLBACK_IMAGE_BASE64 } from './og-fallback-image.generated';

export const runtime = 'nodejs';
export const maxDuration = 25;

/** Success keeps the existing immutable CDN cache contract. */
const OG_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';
/** Fallback should recover quickly if a quota or limiter incident clears. */
const OG_IMAGE_FALLBACK_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';
/** Rejected requests must never enter a shared cache. */
const NO_STORE_HEADERS: HeadersInit = { 'Cache-Control': 'no-store' };

const MAX_TITLE_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 60;
const MAX_QUERY_STRING_LENGTH = 4_096;
const RATE_LIMIT_FAILURE_CAPTURE_WINDOW_MS = 60_000;
let lastRateLimitFailureCaptureAt = 0;

/** Avoid splitting surrogate pairs when a long title is truncated. */
function truncate(value: string | null, maxLength: number): string {
  if (!value) return '';
  return Array.from(value).slice(0, maxLength).join('');
}

/** Round IPv6 identifiers to /64 before hashing so one prefix cannot rotate through 2^64 IPs. */
function roundIpv6ToPrefix64(ip: string): string {
  if (!ip.includes(':')) return ip;

  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const prefixGroups =
    tail === undefined
      ? headGroups.slice(0, 4)
      : [...headGroups, ...Array(Math.max(0, 4 - headGroups.length)).fill('0')].slice(0, 4);

  return prefixGroups.join(':');
}

function captureRateLimitFailureSampled(error: unknown): void {
  const now = Date.now();
  if (now - lastRateLimitFailureCaptureAt < RATE_LIMIT_FAILURE_CAPTURE_WINDOW_MS) return;
  lastRateLimitFailureCaptureAt = now;
  captureUnexpectedWebError(error, {
    feature: 'og_image',
    operation: 'check_rate_limit',
    route: '/api/og',
  });
}

const FALLBACK_IMAGE_BYTES = Uint8Array.from(atob(OG_FALLBACK_IMAGE_BASE64), (char) =>
  char.charCodeAt(0),
);

function renderFallbackImage(): Response {
  return new Response(FALLBACK_IMAGE_BYTES, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': OG_IMAGE_FALLBACK_CACHE_CONTROL,
    },
  });
}

export async function GET(request: NextRequest) {
  if (request.url.length > MAX_QUERY_STRING_LENGTH) {
    return new Response('Request too large', { status: 400, headers: NO_STORE_HEADERS });
  }

  const identifier = await hashRateLimitIdentifier(roundIpv6ToPrefix64(getClientIp(request)));

  try {
    const ipResult = await ogImageRateLimit.limit(identifier);
    if (!ipResult.success) {
      return new Response('Too many requests', { status: 429, headers: NO_STORE_HEADERS });
    }

    const globalResult = await ogImageGlobalRateLimit.limit('global');
    if (!globalResult.success) return renderFallbackImage();
  } catch (error) {
    captureRateLimitFailureSampled(error);
    return renderFallbackImage();
  }

  try {
    const { searchParams } = new URL(request.url);
    const title =
      truncate(searchParams.get('title'), MAX_TITLE_LENGTH) || '守れる計画を、立てられるように。';
    const screenshotSrc = await loadOgScreenshotDataUri(
      searchParams.get('screenshot'),
      path.join(process.cwd(), 'public'),
    );
    const options = resolveOgCardOptions({
      category: truncate(searchParams.get('category'), MAX_CATEGORY_LENGTH),
      legacyType: searchParams.get('type'),
      layout: searchParams.get('layout'),
      screenshotAvailable: Boolean(screenshotSrc),
    });

    return new ImageResponse(
      <OgCardImage
        title={title}
        category={options.category}
        layout={options.layout}
        screenshotSrc={screenshotSrc}
      />,
      {
        ...OG_CARD_SIZE,
        headers: { 'Cache-Control': OG_IMAGE_CACHE_CONTROL },
      },
    );
  } catch {
    return new Response('Failed to generate image', { status: 500, headers: NO_STORE_HEADERS });
  }
}
