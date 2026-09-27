import * as React from 'react';

import { cn } from '../cn';
import { DAYOPT_BRAND } from './logo-data';

export interface LogoProps extends React.ComponentProps<'div'> {
  /** Accessible name; the approved Dayopt artwork stays unchanged. */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'lockup' | 'mark' | 'wordmark';
}

const height = { sm: 20, md: 28, lg: 36 } as const;
const artwork = {
  mark: { box: '0 0 100 100', width: 100, height: 100, paths: DAYOPT_BRAND.symbol },
  lockup: { box: '0 22 389 82', width: 389, height: 82, paths: DAYOPT_BRAND.lockup },
  wordmark: {
    box: '105.753 22 279.131 82',
    width: 279.131,
    height: 82,
    paths: [DAYOPT_BRAND.lockup[2]],
  },
} as const;

/** Figma approved F. Outlined lettering needs no additional webfont. */
export function Logo({
  className,
  label = 'Dayopt',
  size = 'md',
  variant = 'lockup',
  ...props
}: LogoProps) {
  // Planの穴だけevenodd。文字の重なる輪郭（tなど）はnonzeroで埋める。
  const art = artwork[variant];
  return (
    <div
      data-slot="logo"
      role="img"
      aria-label={label}
      className={cn('text-brand-ink inline-flex shrink-0 items-center', className)}
      {...props}
    >
      <svg
        viewBox={art.box}
        width={(height[size] * art.width) / art.height}
        height={height[size]}
        focusable={false}
        aria-hidden="true"
      >
        {art.paths.map((d) => (
          <path
            key={d}
            fill="currentColor"
            fillRule={
              d === DAYOPT_BRAND.symbol[0] || d === DAYOPT_BRAND.lockup[0] ? 'evenodd' : 'nonzero'
            }
            d={d}
          />
        ))}
      </svg>
    </div>
  );
}
