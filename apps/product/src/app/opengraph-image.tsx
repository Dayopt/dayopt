import { DAYOPT_BRAND } from '@dayopt/components/brand';
import { ImageResponse } from 'next/og';

import { dayoptBrand, dayoptDomains } from '@dayopt/config';
import { OG_COLORS } from '@dayopt/foundations/og-colors';

export const runtime = 'edge';

export const alt = dayoptBrand.name;
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: `linear-gradient(135deg, ${OG_COLORS.backgroundDark} 0%, ${OG_COLORS.backgroundMid} 40%, ${OG_COLORS.background} 100%)`,
        // Satori に font データを渡していないため実描画は Satori 既定の書体になる。
        // 指定は将来 font を埋め込む時の宣言として product の書体に合わせておく。
        fontFamily: 'Source Sans 3, system-ui, sans-serif',
      }}
    >
      {/* Decorative circles */}
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

      <div style={{ display: 'flex', marginBottom: 32 }}>
        <svg width={389} height={82} viewBox="0 22 389 82" xmlns="http://www.w3.org/2000/svg">
          {DAYOPT_BRAND.lockup.map((d) => (
            <path
              key={d}
              d={d}
              fill={DAYOPT_BRAND.reverse}
              fillRule={d === DAYOPT_BRAND.lockup[0] ? 'evenodd' : 'nonzero'}
            />
          ))}
        </svg>
      </div>

      {/* Tagline */}
      <div
        style={{
          fontSize: 24,
          color: OG_COLORS.muted,
          fontWeight: 400,
          letterSpacing: '-0.01em',
        }}
      >
        Plan your day. Track your time. Optimize your life.
      </div>

      {/* Subtle bottom bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 14,
            color: OG_COLORS.mutedSubtle,
            letterSpacing: '0.05em',
          }}
        >
          {dayoptDomains.marketing}
        </div>
      </div>
    </div>,
    { ...size },
  );
}
