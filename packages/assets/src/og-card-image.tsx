import * as React from 'react';

import { DAYOPT_BRAND } from './brand';
import { LogoArtwork } from './logo-artwork';
import { OG_CARD_SIZE, resolveOgCardOptions, type OgCategory, type OgLayout } from './og';
import { composeOgTitle } from './og-title';

export interface OgCardImageProps {
  title: string;
  category: OgCategory;
  categoryLabel: string;
  layout?: OgLayout | undefined;
  screenshotSrc?: string | undefined;
}

const COLORS = {
  background: '#f7f5f1',
  foreground: DAYOPT_BRAND.primary,
  surface: '#f3f0ea',
  border: '#e9e5dd',
} as const;

// Light calendar category tokens, converted to sRGB for Satori (no CSS variables/OKLCH).
// Mirror --category-{blue,green,amber} and their -tint values in foundations/tokens/colors.css.
const CALENDAR_COLORS = {
  blue: { border: '#0099f0', tint: '#c7eaff' },
  green: { border: '#31aa40', tint: '#d1eed1' },
  amber: { border: '#c77e00', tint: '#f6e2c0' },
} as const;

/** A quiet week: outlined plans and filled records can exist independently or side by side. */
function WeekStudy({ subdued }: { subdued: boolean }) {
  const blocks = [
    { day: 0, y: 184, height: 108, kind: 'plan', color: 'blue' },
    { day: 0, y: 198, height: 124, kind: 'record', color: 'blue' },
    { day: 0, y: 456, height: 64, kind: 'record', color: 'green' },
    { day: 1, y: 176, height: 60, kind: 'record', color: 'green' },
    { day: 1, y: 360, height: 92, kind: 'plan', color: 'amber' },
    { day: 2, y: 292, height: 132, kind: 'plan', color: 'blue' },
    { day: 2, y: 310, height: 100, kind: 'record', color: 'blue' },
  ] as const;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        display: 'flex',
        right: 0,
        top: 0,
        width: 600,
        height: OG_CARD_SIZE.height,
        opacity: subdued ? 0.45 : 1,
        pointerEvents: 'none',
      }}
    >
      <svg viewBox="0 0 600 630" width={600} height={630} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient
            id="og-week-horizontal"
            x1="0"
            y1="0"
            x2="600"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={COLORS.foreground} stopOpacity="0" />
            <stop offset="0.2" stopColor={COLORS.foreground} stopOpacity="0.055" />
            <stop offset="1" stopColor={COLORS.foreground} stopOpacity="0.055" />
          </linearGradient>
          <linearGradient
            id="og-week-vertical"
            x1="0"
            y1="0"
            x2="0"
            y2="630"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={COLORS.foreground} stopOpacity="0.015" />
            <stop offset="0.3" stopColor={COLORS.foreground} stopOpacity="0.055" />
            <stop offset="0.75" stopColor={COLORS.foreground} stopOpacity="0.055" />
            <stop offset="1" stopColor={COLORS.foreground} stopOpacity="0.015" />
          </linearGradient>
        </defs>
        {Array.from({ length: 8 }, (_, index) => (
          <path
            key={index}
            d={`M0 ${68 + index * 72}H600`}
            stroke="url(#og-week-horizontal)"
            opacity={index === 0 || index === 7 ? 0.4 : 1}
          />
        ))}
        {Array.from({ length: 4 }, (_, day) => (
          <path
            key={day}
            d={`M${day * 200} 0V630`}
            stroke="url(#og-week-vertical)"
            opacity={day === 0 ? 0.3 : 1}
          />
        ))}
        {blocks.map(({ day, y, height, kind, color }, index) => (
          <rect
            key={index}
            x={26 + day * 200 + (kind === 'record' ? 78 : 0)}
            y={y}
            width={68}
            height={height}
            rx={8}
            fill={kind === 'record' ? CALENDAR_COLORS[color].tint : COLORS.background}
            stroke={kind === 'plan' ? CALENDAR_COLORS[color].border : 'none'}
            strokeWidth={1.25}
          />
        ))}
      </svg>
    </div>
  );
}

function CategoryTag({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 999,
        color: COLORS.foreground,
        fontSize: 20,
        fontWeight: 600,
        height: 44,
        padding: '0 22px',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </div>
  );
}

function CardHeader({ categoryLabel }: { categoryLabel: string }) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        width: '100%',
        height: 44,
      }}
    >
      <LogoArtwork variant="lockup" width={190} height={40} color={COLORS.foreground} />
      <CategoryTag label={categoryLabel} />
    </div>
  );
}

function Title({
  title,
  centered,
  compact,
}: {
  title: string;
  centered?: boolean;
  compact?: boolean;
}) {
  const width = compact ? 440 : centered ? 1008 : 552;
  const composition = composeOgTitle(title, width, compact);
  const { lines, fontSize, japanese } =
    !compact && !centered && composition.fontSize < 38
      ? composeOgTitle(title, width, true)
      : composition;

  return (
    <div
      style={{
        color: COLORS.foreground,
        display: 'flex',
        flexDirection: 'column',
        alignItems: centered ? 'center' : 'flex-start',
        width,
        fontSize,
        fontWeight: 600,
        letterSpacing: japanese ? '-0.025em' : '-0.03em',
        lineHeight: japanese ? 1.35 : 1.1,
        textAlign: centered ? 'center' : 'left',
      }}
    >
      {lines.map((line, index) => (
        <div key={index} style={{ display: 'flex', whiteSpace: 'pre' }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export function OgCardImage({
  title,
  category,
  categoryLabel,
  layout,
  screenshotSrc,
}: OgCardImageProps): React.ReactElement {
  const resolvedLayout = resolveOgCardOptions({
    category,
    layout,
    screenshotAvailable: Boolean(screenshotSrc),
  }).layout;

  return (
    <div
      style={{
        position: 'relative',
        width: OG_CARD_SIZE.width,
        height: OG_CARD_SIZE.height,
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontFamily: 'Dayopt OG Latin, Dayopt OG Japanese',
        padding: '52px 64px',
      }}
    >
      {resolvedLayout !== 'screenshot' ? <WeekStudy subdued={resolvedLayout === 'center'} /> : null}

      {resolvedLayout === 'center' ? (
        <div
          style={{
            position: 'absolute',
            top: 20,
            right: 20,
            bottom: 20,
            left: 20,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 22,
          }}
        />
      ) : null}

      <CardHeader categoryLabel={categoryLabel} />

      {resolvedLayout === 'screenshot' && screenshotSrc ? (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            gap: 48,
            width: '100%',
            paddingTop: 32,
            paddingBottom: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              width: 440,
              flexShrink: 0,
            }}
          >
            <Title title={title} compact />
          </div>
          <div
            style={{
              display: 'flex',
              width: 584,
              flexShrink: 0,
              height: 344,
              overflow: 'hidden',
              backgroundColor: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 20,
            }}
          >
            <img
              src={screenshotSrc}
              alt=""
              width={584}
              height={344}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        </div>
      ) : (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: resolvedLayout === 'center' ? 'center' : 'flex-start',
            justifyContent: 'center',
            flex: 1,
            width: '100%',
            paddingBottom: 24,
          }}
        >
          <Title title={title} centered={resolvedLayout === 'center'} />
        </div>
      )}
    </div>
  );
}
