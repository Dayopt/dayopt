/**
 * オープンリダイレクト防止ユーティリティ
 *
 * 認証コールバック等で使用する `next` パラメータを検証し、
 * 外部サイトへのリダイレクトを防止する。
 *
 * @see OWASP - Unvalidated Redirects and Forwards
 */

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@dayopt/config';

/**
 * リダイレクト先パスを検証し、安全な相対パスのみ許可する。
 *
 * 拒否されるパターン:
 * - 絶対URL (`https://evil.com`)
 * - プロトコル相対URL (`//evil.com`)
 * - エンコードされたバイパス (`%2F%2Fevil.com`)
 * - raw / encoded backslash (`/%5C%5Cevil.com`)
 */
export function getSafeRedirectPath(next: string | null, fallback = '/calendar'): string {
  if (!next) return fallback;

  // 相対パスでない、またはプロトコル相対URL
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  if (next.includes('\\')) return fallback;

  // エンコードされたバイパスを検出
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  if (decoded.startsWith('//') || decoded.includes('://') || decoded.includes('\\')) {
    return fallback;
  }

  const appOrigin = 'https://app.dayopt.app';
  try {
    const parsed = new URL(decoded, appOrigin);
    if (parsed.origin !== appOrigin) return fallback;
  } catch {
    return fallback;
  }

  return next;
}

/**
 * 安全性を検証したリダイレクト先へ locale を一度だけ付ける。
 *
 * 認証切れ時の戻り先は `window.location.pathname` 由来なので、`/ja/settings` のように
 * 既に locale を含む場合がある。そこへ現在 locale を無条件に足すと `/ja/ja/settings`
 * になり、ログイン成功後に 404 へ遷移する。
 */
export function getSafeLocalizedRedirectPath(
  next: string | null,
  locale: string,
  fallback = '/calendar',
): string {
  const safePath = getSafeRedirectPath(next, fallback);
  const hasLocalePrefix = SUPPORTED_LOCALES.some(
    (supportedLocale) =>
      safePath === `/${supportedLocale}` ||
      safePath.startsWith(`/${supportedLocale}/`) ||
      safePath.startsWith(`/${supportedLocale}?`) ||
      safePath.startsWith(`/${supportedLocale}#`),
  );
  if (hasLocalePrefix) return safePath;

  const safeLocale: Locale = SUPPORTED_LOCALES.includes(locale as Locale)
    ? (locale as Locale)
    : DEFAULT_LOCALE;
  return `/${safeLocale}${safePath}`;
}
