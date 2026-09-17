import { useMemo } from 'react';

import { isTodayWallDateInTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';

/**
 * 指定された日付が「ユーザーの calendar timezone での今日」かどうかを判定するフック
 *
 * date-fns の `isToday` はブラウザのローカル TZ で判定するため、ユーザーが
 * OS TZ と異なる timezone を設定している場合に highlight が 1 日ずれる。
 * カレンダーは取得・表示の両方を `useUserPreferences.timezone` で揃えるため、
 * このフックも同じ timezone を参照する。
 */
export function useIsToday(date: Date): boolean {
  const timezone = useUserPreferences((s) => s.timezone);
  return useMemo(() => isTodayWallDateInTimezone(date, timezone), [date, timezone]);
}
