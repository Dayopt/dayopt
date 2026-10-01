/** Only Vercel Preview builds may discover the broker route. Runtime checks are
 * additional protection, not a substitute for exclusion from Production output. */
export function productPageExtensions(env = process.env) {
  return [...(env.VERCEL_ENV === 'preview' ? ['preview.js'] : []), 'tsx', 'ts', 'jsx', 'js'];
}
