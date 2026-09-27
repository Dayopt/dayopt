import { DAYOPT_BRAND } from '@dayopt/components/brand';
import { dayoptBrand, dayoptDomains } from '@dayopt/config';
import { OG_COLORS } from '@dayopt/foundations/og-colors';
import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

import { captureUnexpectedWebError } from '@web/platform/observability/capture-unexpected-error';
import {
  getClientIp,
  hashRateLimitIdentifier,
  ogImageGlobalRateLimit,
  ogImageRateLimit,
} from '@web/platform/security/rate-limit';

import { OG_FALLBACK_IMAGE_BASE64 } from './og-fallback-image.generated';

export const maxDuration = 25;

/**
 * runtime は既定(Node.js Fluid Compute)。以前は `runtime = 'edge'` を明示していたが、
 * 2026-09-03 に同一 Vercel Preview 環境で Edge / Node を実測比較して外した(#2520)。
 *
 * 測り方: 同じ branch の連続する 2 commit の Preview へ、1 リクエストずつ交互に
 * (奇数/偶数ラウンドで A/B の順序も反転して)cache buster 付きで叩き、全件 cache MISS
 * = 実際に function が走る経路の TTFB を取った。各 195 サンプル。
 *
 * | 指標 | Edge  | Node  |
 * | ---- | ----- | ----- |
 * | p50  | 0.890 | 0.252 |
 * | p95  | 1.000 | 0.360 |
 * | p99  | 1.204 | 0.445 |
 *
 * 外れ値(>2s)は Edge / Node ともちょうど 1 件ずつ(0.51%)。それを除くと Node の最大値
 * 0.447s が Edge の最小値 0.852s を下回り、分布が完全に分離する。
 *
 * 出力の同一性も確認済み: PNG のバイト列は一致しない(エンコーダが違うため Node 版は
 * 約 30% 小さい)が、raw RGBA へ展開したピクセル差は平均 0.2/255、maxΔ>8 の画素は
 * 0.43% のみで、その分布は文字の輪郭(アンチエイリアス差)と背景グラデーションの
 * 量子化差に限られる。グリフ内部は完全一致で、フォント fallback もレイアウトずれも無い。
 * cache 契約 3 種(成功/fallback/reject)と oversized query の 400 応答は sha256 まで一致。
 *
 * Active CPU は未計測(Vercel の runtime-logs API は live tail 専用で履歴を返さない)。
 * ただし Upstash 2 往復は両 runtime で同一なので、TTFB の差 0.64s はほぼ Satori の
 * ラスタライズと PNG エンコード = CPU 側の差と考えてよい。
 */

/**
 * 成功レスポンスの正規cache契約。長寿命(内容はpost frontmatterから決定的に導出される)。
 * `s-maxage` を明示しないとVercel Edge NetworkでCDNキャッシュされる保証が無く、
 * hero画像の全アクセスが毎回この関数とUpstash 2往復を経由してしまう。
 */
const OG_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';
/** global quota超過時・limiter障害時のfallbackはすぐ回復させたいので短命にする。 */
const OG_IMAGE_FALLBACK_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';
/** reject応答はCDN/共有cacheに載せない。 */
const NO_STORE_HEADERS: HeadersInit = { 'Cache-Control': 'no-store' };

/**
 * 各 query field の描画前 upper bound。
 *
 * 400 で reject せず truncate するのは、本 route が blog 記事の hero 画像
 * (`page.tsx` の `heroImage`、cover 画像未設定時に `priority` 付き `<Image>` で
 * 直接配信される)としても使われており、既に公開・SNSシェア済みのリンクを
 * 壊さないため。上限は Satori layout コストを頭打ちにする目的で足りる。
 *
 * title は line-clamp を持たないため、630px canvas を溢れさせない実用的な値に
 * 絞る(既存blog記事のtitleは概算100字以下、決定ログは無し)。
 */
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 60;
const MAX_AUTHOR_LENGTH = 100;
const MAX_DATE_LENGTH = 40;
/** query string 全体がこれを超えたら、truncateでは吸収しない明らかな異常として reject する。 */
const MAX_QUERY_STRING_LENGTH = 4_096;
/** Upstash障害中のcapture floodを抑えるサンプリング窓。低頻度な他routeのcapture方針とは前提が違う(hero画像として高頻度に叩かれる)。 */
const RATE_LIMIT_FAILURE_CAPTURE_WINDOW_MS = 60_000;
let lastRateLimitFailureCaptureAt = 0;

/**
 * マーケティングサイトの OG 画像
 *
 * apps/product/src/app/opengraph-image.tsx と同じ顔にする。SNS のフィードで
 * ブログ記事とプロダクトのリンクが別ブランドに見えないようにするため、
 * 地色・グロー・ロゴタイルの構成を揃え、色は @dayopt/foundations/og-colors
 * だけを参照する。
 *
 * 以前は白地 + 絵文字タイル + type 別の配色（blog=emerald / release=violet /
 * docs=blue）で、ブランドの紺と無関係な3色が出ていた。type による色分けは廃止し、
 * ラベル文字だけで種別を示す。
 */

/** 種別ラベル。色は変えない（アクセントは紺1色） */
const TYPE_LABELS: Record<string, string> = {
  blog: 'Blog Post',
  docs: 'Documentation',
  release: 'Release Notes',
  default: dayoptBrand.name,
};

const ALLOWED_TYPES: ReadonlySet<string> = new Set(Object.keys(TYPE_LABELS));

/** サロゲートペアを`slice`で分断しない(絵文字混じりのtitle等で文字化けさせない)。 */
function truncate(value: string | null, maxLength: number): string {
  if (!value) return '';
  return Array.from(value).slice(0, maxLength).join('');
}

/**
 * IPv6は/128(フルアドレス)のままidentifierにすると、攻撃者が/64割り当て内の
 * 2^64通りのアドレスを使い分けてIP単位のrate limitを素通りできる(#1978と同じ
 * 理由)。/64プレフィックスまで丸めてから hash する。IPv4はそのまま。
 */
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

/**
 * Upstash障害中、request単位でSentry captureすると無制限にquotaを焼く
 * (低頻度なcontact/csp-reportと違い、本routeはblog記事のhero画像として
 * 高頻度に叩かれる)。時間窓で1件だけcaptureする。
 */
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

/**
 * global quota超過時・rate limit backend障害時のfallback画像バイト列。
 * `renderFallbackImage`(旧実装)はここでも毎回Satoriで1200x630をラスタライズ
 * しており、fallback自体がcompute costを発生させ続けていた(#2052)。
 * 事前生成した静的PNG(`scripts/generate-og-fallback.tsx`が出力)をbase64で
 * 埋め込み、module load時に一度だけdecodeして使い回す。以後Satori/next-ogの
 * コードパスは一切通らない。
 */
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
  // 明らかに異常なquery string全体長は、truncateでは吸収しないためrender前にreject。
  if (request.url.length > MAX_QUERY_STRING_LENGTH) {
    return new Response('Request too large', { status: 400, headers: NO_STORE_HEADERS });
  }

  // 他routeと同様、raw IPはUpstashへ残さずhashed identifierだけを渡す。
  const identifier = await hashRateLimitIdentifier(roundIpv6ToPrefix64(getClientIp(request)));

  // IP → global の順で評価する（IP単位quotaは個々のIPだけを罰し、globalはrender
  // コスト全体の天井を守る）。limiter障害時はhero画像を壊さないfallbackへdegrade
  // する(503を返すとblog記事のhero画像が読者全員から見えなくなる)。
  try {
    const ipResult = await ogImageRateLimit.limit(identifier);
    if (!ipResult.success) {
      return new Response('Too many requests', { status: 429, headers: NO_STORE_HEADERS });
    }

    const globalResult = await ogImageGlobalRateLimit.limit('global');
    if (!globalResult.success) {
      return renderFallbackImage();
    }
  } catch (error) {
    captureRateLimitFailureSampled(error);
    return renderFallbackImage();
  }

  try {
    const { searchParams } = new URL(request.url);

    const title =
      truncate(searchParams.get('title'), MAX_TITLE_LENGTH) || '守れる計画を、立てられるように。';
    const description =
      truncate(searchParams.get('description'), MAX_DESCRIPTION_LENGTH) ||
      '計画と実績を、ひとつのタイムラインに。ズレが見えるから、明日の計画がうまくなる。';
    const rawType = searchParams.get('type');
    const type = rawType && ALLOWED_TYPES.has(rawType) ? rawType : 'default';
    const category = truncate(searchParams.get('category'), MAX_CATEGORY_LENGTH);
    const author = truncate(searchParams.get('author'), MAX_AUTHOR_LENGTH);
    const date = truncate(searchParams.get('date'), MAX_DATE_LENGTH);

    const typeLabel = TYPE_LABELS[type] ?? TYPE_LABELS.default;

    return new ImageResponse(
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: `linear-gradient(135deg, ${OG_COLORS.backgroundDark} 0%, ${OG_COLORS.backgroundMid} 40%, ${OG_COLORS.background} 100%)`,
          padding: '60px',
          // Satori に font データを渡していないため実描画は Satori 既定の書体になる。
          // 指定は将来 font を埋め込む時の宣言として product の書体に合わせておく。
          fontFamily: 'Source Sans 3, system-ui, sans-serif',
        }}
      >
        {/* 装飾グロー（product の OG と同じ位置・大きさ） */}
        <div
          style={{
            position: 'absolute',
            top: -80,
            right: -80,
            width: 400,
            height: 400,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${OG_COLORS.primaryGlow15} 0%, transparent 70%)`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -120,
            left: -60,
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${OG_COLORS.primaryGlow10} 0%, transparent 70%)`,
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <svg width={237} height={50} viewBox="0 22 389 82" xmlns="http://www.w3.org/2000/svg">
            {DAYOPT_BRAND.lockup.map((d) => (
              <path
                key={d}
                d={d}
                fill={DAYOPT_BRAND.reverse}
                fillRule={d === DAYOPT_BRAND.lockup[0] ? 'evenodd' : 'nonzero'}
              />
            ))}
          </svg>
          <div style={{ fontSize: 16, color: OG_COLORS.mutedSubtle }}>{typeLabel}</div>
        </div>

        {/* 本文 */}
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <div
            style={{
              fontSize: title.length > 60 ? 48 : 56,
              fontWeight: 500,
              color: OG_COLORS.foreground,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
              marginBottom: 24,
              maxWidth: '100%',
            }}
          >
            {title}
          </div>

          {description && (
            <div
              style={{
                fontSize: 24,
                color: OG_COLORS.muted,
                lineHeight: 1.4,
                letterSpacing: '-0.01em',
                maxWidth: '90%',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {description}
            </div>
          )}
        </div>

        {/* フッター: カテゴリ / 著者 / 日付 / ドメイン */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {category && (
              <div
                style={{
                  display: 'flex',
                  backgroundColor: OG_COLORS.primaryChip,
                  color: OG_COLORS.foreground,
                  padding: '8px 16px',
                  borderRadius: 20,
                  fontSize: 14,
                  fontWeight: 500,
                  marginRight: 16,
                }}
              >
                {category}
              </div>
            )}
            {/* display:flex は Satori の要件。子が複数ある div に無いと描画が失敗する */}
            {author && (
              <div style={{ display: 'flex', color: OG_COLORS.muted, fontSize: 16 }}>
                {`By ${author}`}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center' }}>
            {date && (
              <div style={{ display: 'flex', color: OG_COLORS.muted, fontSize: 16 }}>
                {new Date(date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </div>
            )}
            {!date && (
              <div
                style={{
                  display: 'flex',
                  fontSize: 14,
                  color: OG_COLORS.mutedSubtle,
                  letterSpacing: '0.05em',
                }}
              >
                {dayoptDomains.marketing}
              </div>
            )}
          </div>
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        headers: { 'Cache-Control': OG_IMAGE_CACHE_CONTROL },
      },
    );
  } catch {
    return new Response('Failed to generate image', { status: 500, headers: NO_STORE_HEADERS });
  }
}
