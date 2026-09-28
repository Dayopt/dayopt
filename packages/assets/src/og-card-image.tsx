import * as React from 'react';

import { DAYOPT_BRAND } from './brand';
import { LogoArtwork } from './logo-artwork';
import {
  OG_CARD_SIZE,
  getOgCategoryLabel,
  resolveOgCardOptions,
  type OgCategory,
  type OgLayout,
} from './og';

export interface OgCardImageProps {
  title: string;
  category: OgCategory;
  layout?: OgLayout | undefined;
  screenshotSrc?: string | undefined;
}

const COLORS = {
  background: '#f7f5f1',
  foreground: DAYOPT_BRAND.primary,
  surface: DAYOPT_BRAND.reverse,
  border: '#e4e1d9',
} as const;

function CategoryTag({ category }: { category: OgCategory }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 999,
        color: COLORS.foreground,
        fontSize: 16,
        fontWeight: 500,
        padding: '9px 18px',
      }}
    >
      {getOgCategoryLabel(category)}
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
  const fontSize = compact
    ? title.length > 75
      ? 36
      : title.length > 45
        ? 42
        : 48
    : title.length > 75
      ? 42
      : title.length > 48
        ? 48
        : 56;

  return (
    <div
      style={{
        color: COLORS.foreground,
        display: '-webkit-box',
        fontSize,
        fontWeight: 500,
        letterSpacing: '-0.03em',
        lineHeight: 1.16,
        maxWidth: centered ? 980 : '100%',
        overflow: 'hidden',
        textAlign: centered ? 'center' : 'left',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 3,
      }}
    >
      {title}
    </div>
  );
}

function CardHeader({ category }: { category: OgCategory }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
      }}
    >
      <LogoArtwork variant="lockup" width={190} height={40} color={COLORS.foreground} />
      <CategoryTag category={category} />
    </div>
  );
}

export function OgCardImage({ title, category, layout, screenshotSrc }: OgCardImageProps) {
  const resolvedLayout = resolveOgCardOptions({
    category,
    layout,
    screenshotAvailable: Boolean(screenshotSrc),
  }).layout;

  return (
    <React.Fragment>
      <div
        style={{
          width: OG_CARD_SIZE.width,
          height: OG_CARD_SIZE.height,
          boxSizing: 'border-box',
          display: 'flex',
          backgroundColor: COLORS.background,
          color: COLORS.foreground,
          fontFamily: 'Arial, sans-serif',
          padding: 64,
        }}
      >
        {resolvedLayout === 'center' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 42,
              width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              <LogoArtwork variant="lockup" width={190} height={40} color={COLORS.foreground} />
              <CategoryTag category={category} />
            </div>
            <Title title={title} centered />
          </div>
        ) : resolvedLayout === 'screenshot' && screenshotSrc ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 42, width: '100%' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 34,
                width: '46%',
              }}
            >
              <div style={{ display: 'flex' }}>
                <LogoArtwork variant="lockup" width={190} height={40} color={COLORS.foreground} />
              </div>
              <div style={{ display: 'flex' }}>
                <CategoryTag category={category} />
              </div>
              <Title title={title} compact />
            </div>
            <div
              style={{
                display: 'flex',
                width: '54%',
                height: 360,
                overflow: 'hidden',
                backgroundColor: COLORS.surface,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 20,
              }}
            >
              <img
                src={screenshotSrc}
                alt=""
                width={560}
                height={360}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              width: '100%',
            }}
          >
            <CardHeader category={category} />
            <Title title={title} />
          </div>
        )}
      </div>
    </React.Fragment>
  );
}
