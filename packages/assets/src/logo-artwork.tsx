import * as React from 'react';

import { DAYOPT_BRAND } from './brand';

export type LogoArtworkVariant = 'lockup' | 'mark' | 'wordmark';

interface LogoArtworkProps {
  variant: LogoArtworkVariant;
  width: number;
  height: number;
  color?: string;
}

const artwork = {
  mark: { box: '0 0 100 100', paths: DAYOPT_BRAND.symbol },
  lockup: { box: '0 22 389 82', paths: DAYOPT_BRAND.lockup },
  wordmark: { box: '105.753 22 279.131 82', paths: [DAYOPT_BRAND.lockup[2]] },
} as const;

/** Vector artwork shared by the UI logo and server-rendered social images. */
export function LogoArtwork({ variant, width, height, color = 'currentColor' }: LogoArtworkProps) {
  const art = artwork[variant];

  return (
    <React.Fragment>
      <svg
        viewBox={art.box}
        width={width}
        height={height}
        focusable={false}
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
      >
        {art.paths.map((d) => (
          <path
            key={d}
            fill={color}
            fillRule={
              d === DAYOPT_BRAND.symbol[0] || d === DAYOPT_BRAND.lockup[0] ? 'evenodd' : 'nonzero'
            }
            d={d}
          />
        ))}
      </svg>
    </React.Fragment>
  );
}
