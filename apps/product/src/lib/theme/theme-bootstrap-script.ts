/**
 * 初回描画前にテーマ class を付ける inline script。
 *
 * ThemeProvider は hydration 後の useEffect で `dark` / `light` を付けるため、
 * それまでの SSR HTML は light のまま描画される。ダークテーマの人はページを
 * 開くたびに白い画面が一瞬（dev では数秒）見えていた（2026-09-14 UI レビュー）。
 * ThemeProvider が localStorage の `theme` に書く値と、system 時は
 * prefers-color-scheme を読んで、React が動く前に同じ判定で class を付ける。
 * Provider 側は mount 後に付け直すので、判定がずれても Provider が勝つ。
 */

type StoredTheme = 'light' | 'dark' | 'system' | null;

/** inline script と同じ判定。テストで両者を突き合わせる */
export function resolveInitialTheme(stored: StoredTheme, prefersDark: boolean): 'light' | 'dark' {
  if (stored === 'dark') return 'dark';
  if (stored === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

export const THEME_BOOTSTRAP_SCRIPT = [
  '(function(){try{',
  "var t=localStorage.getItem('theme');",
  "var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);",
  "document.documentElement.classList.add(d?'dark':'light');",
  '}catch(e){}})();',
].join('');
