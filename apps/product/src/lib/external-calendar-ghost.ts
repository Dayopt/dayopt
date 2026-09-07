/** カレンダー表示・レポートが共有する外部予定の選択契約。DB / feature には依存しない。 */
export const GHOST_EVENT_STATUS = 'confirmed';
export const GHOST_CONNECTION_STATUS = 'active';

/** keyset ページングの取得予算。上限到達時の扱いは各呼び出し側が決める。 */
export const GHOST_QUERY_BATCH_SIZE = 150;
export const GHOST_QUERY_MAX_BATCHES = 20;

/** 同期が取り込む窓と、レポートが数える窓の共通半径（±90 日）。 */
export const EXTERNAL_CALENDAR_WINDOW_RADIUS_MS = 90 * 24 * 60 * 60 * 1000;

export function calendarSelectionKey(connectionId: string, providerCalendarId: string): string {
  return `${connectionId} ${providerCalendarId}`;
}
