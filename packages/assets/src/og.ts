export const OG_CATEGORIES = ['product', 'docs', 'journal', 'release'] as const;
export const OG_LAYOUTS = ['center', 'left', 'screenshot'] as const;

export type OgCategory = (typeof OG_CATEGORIES)[number];
export type OgLayout = (typeof OG_LAYOUTS)[number];

export const OG_CARD_SIZE = {
  width: 1200,
  height: 630,
} as const;

const DEFAULT_LAYOUTS: Record<OgCategory, OgLayout> = {
  docs: 'center',
  journal: 'left',
  release: 'left',
  product: 'screenshot',
};

const LEGACY_TYPE_CATEGORIES: Record<string, OgCategory> = {
  blog: 'journal',
  docs: 'docs',
  release: 'release',
};

export interface ResolvedOgCardOptions {
  category: OgCategory;
  layout: OgLayout;
}

function parseCategory(value: string | null | undefined): OgCategory | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'documentation') return 'docs';
  if (normalized === 'blog') return 'journal';
  return OG_CATEGORIES.find((category) => category === normalized);
}

function parseLayout(value: string | null | undefined): OgLayout | undefined {
  const normalized = value?.trim().toLowerCase();
  return OG_LAYOUTS.find((layout) => layout === normalized);
}

export function resolveOgCardOptions(
  input: {
    category?: string | null | undefined;
    legacyType?: string | null | undefined;
    layout?: string | null | undefined;
    screenshotAvailable?: boolean | undefined;
  } = {},
): ResolvedOgCardOptions {
  const legacyType = input.legacyType?.trim().toLowerCase();
  const category =
    parseCategory(input.category) ??
    (legacyType ? LEGACY_TYPE_CATEGORIES[legacyType] : undefined) ??
    'product';
  const requestedLayout = parseLayout(input.layout) ?? DEFAULT_LAYOUTS[category];
  const layout =
    requestedLayout === 'screenshot' && !input.screenshotAvailable ? 'left' : requestedLayout;

  return {
    category,
    layout,
  };
}

/**
 * Return a path relative to `public/og-screenshots`, rejecting URLs, traversal, and non-raster
 * formats before any file-system access takes place.
 */
export function resolveOgScreenshotFilename(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = /^(?:\/?og-screenshots)\/(.+)$/i.exec(trimmed);
  if (!match?.[1]) return null;

  const segments = match[1].split('/');
  if (
    segments.some(
      (segment) =>
        segment === '.' || segment === '..' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(segment),
    )
  ) {
    return null;
  }

  const filename = segments.at(-1);
  if (!filename || !/\.(?:png|jpe?g|webp)$/i.test(filename)) return null;

  return segments.join('/');
}
