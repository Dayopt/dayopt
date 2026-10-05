/**
 * ワークスペースビューのルーティングユーティリティ
 *
 * URLパスが workspace の時間軸ビュー（ホーム `/`）かどうかを判定する。
 */

/**
 * ロケールを除いたパスがホームの時間軸ビューかどうかを判定
 *
 * @param pathWithoutLocale - ロケールプレフィックスを除いたパス（例: "/", "/?view=week"）
 */
export function isCalendarViewPath(pathWithoutLocale: string): boolean {
  const [pathOnly] = pathWithoutLocale.split('?');

  return pathOnly === '' || pathOnly === '/';
}
