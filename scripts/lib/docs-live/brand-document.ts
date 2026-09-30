/** 配布資産の生成と人間向け読取で、説明文の正本を共有する。zip は生成時点の記録。 */
export const BRAND_DOCUMENT_SOURCE = 'docs/business/brand.md';
export const BRAND_DOCUMENT_TARGETS = [
  'apps/product/public/brand/README.md',
  'apps/web/public/brand/README.md',
] as const;

/** 配布用 README は保存本文を持たない、正本への閲覧 alias。 */
export function documentSourcePath(document: string): string {
  return BRAND_DOCUMENT_TARGETS.some((target) => target === document)
    ? BRAND_DOCUMENT_SOURCE
    : document;
}
