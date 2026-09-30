import type { LearnData } from './data.ts';

const PLACEHOLDER =
  /(<script type="application\/json" id="learn-data">)\s*__LEARN_DATA__\s*(<\/script>)/;

/** template だけが executable。正本の JSON は script を閉じられないよう escape する。 */
export function buildLearnHtml(
  template: string,
  data: LearnData,
  links?: { documentBase: string },
): string {
  if (!PLACEHOLDER.test(template)) throw new Error('template に learn-data の placeholder が無い');
  const json = JSON.stringify(links ? { ...data, ...links } : data).replace(/</g, '\\u003c');
  return template.replace(
    PLACEHOLDER,
    (_match, open: string, close: string) => open + json + close,
  );
}
