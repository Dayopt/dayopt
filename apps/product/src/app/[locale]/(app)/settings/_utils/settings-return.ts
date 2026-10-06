const LOCALE_PREFIX_PATTERN = /^\/(en|ja)(?=\/|$)/;
const SETTINGS_RETURN_FALLBACK_PATH = '/?view=day';

/**
 * PC で設定を閉じてワークスペースへ戻る時の遷移先。
 *
 * `/` はカレンダーのホーム。設定を閉じた後も同じアプリシェルへ戻る。
 */
export const DESKTOP_SETTINGS_EXIT_PATH = '/';

export function normalizeSettingsReturnPath(returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) {
    return SETTINGS_RETURN_FALLBACK_PATH;
  }

  const pathWithoutLocale = returnTo.replace(LOCALE_PREFIX_PATTERN, '') || '/';
  if (pathWithoutLocale === '/settings' || pathWithoutLocale.startsWith('/settings/')) {
    return SETTINGS_RETURN_FALLBACK_PATH;
  }

  return pathWithoutLocale;
}

export function buildSettingsReturnQuery(returnPath: string): string {
  return `?returnTo=${encodeURIComponent(returnPath)}`;
}
