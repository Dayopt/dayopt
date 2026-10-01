import { LogoArtwork } from '@dayopt/assets/logo-artwork';
import * as React from 'react';

import { cn } from '../cn';

export interface LogoProps extends React.ComponentProps<'div'> {
  /** Accessible name; the approved Dayopt artwork stays unchanged. */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'lockup' | 'mark' | 'wordmark';
}

const height = { sm: 20, md: 28, lg: 36 } as const;
const artwork = {
  mark: { width: 100, height: 100 },
  lockup: { width: 389, height: 82 },
  wordmark: {
    width: 279.131,
    height: 82,
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
      <LogoArtwork
        variant={variant}
        width={(height[size] * art.width) / art.height}
        height={height[size]}
      />
    </div>
  );
}
