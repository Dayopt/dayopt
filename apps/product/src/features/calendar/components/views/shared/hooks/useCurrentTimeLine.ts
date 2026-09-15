/**
 * 現在時刻線のロジック
 *
 * ScrollableCalendarLayoutから抽出したカスタムフック
 */

import { useEffect, useMemo, useState } from 'react';

import { convertToTimezone } from '@/lib/date/timezone';

/** useCurrentTimeLine フックのオプション */
interface UseCurrentTimeLineOptions {
  hourHeight: number;
  showCurrentTime: boolean;
  /**
   * ユーザーの timezone。線（CurrentTimeLine）は user TZ で引くので、時刻列のバッジも
   * 同じ TZ で計算しないとブラウザ TZ と違う設定のユーザーで線とバッジがずれる
   */
  timezone: string;
}

/** useCurrentTimeLine フックの戻り値 */
interface UseCurrentTimeLineReturn {
  currentTime: Date;
  currentTimePosition: number;
  currentTimeLineColor: string | null;
}

/**
 * 現在時刻線の位置を計算するフック
 *
 * 色は常に null を返し、呼び出し側で bg-primary にフォールバックする。
 */
export const useCurrentTimeLine = ({
  hourHeight,
  showCurrentTime,
  timezone,
}: UseCurrentTimeLineOptions): UseCurrentTimeLineReturn => {
  // 現在時刻の状態（ブラウザ TZ の生時刻）
  const [rawTime, setRawTime] = useState(new Date());
  // ユーザー TZ の壁時計へ変換した値。getHours / getMinutes が user TZ を返す
  const currentTime = useMemo(() => convertToTimezone(rawTime, timezone), [rawTime, timezone]);

  // 現在時刻の位置を計算
  const currentTimePosition = useMemo(() => {
    const hours = currentTime.getHours();
    const minutes = currentTime.getMinutes();
    const totalHours = hours + minutes / 60;
    return totalHours * hourHeight;
  }, [currentTime, hourHeight]);

  // 1分ごとに現在時刻を更新
  useEffect(() => {
    if (!showCurrentTime) return;

    const updateCurrentTime = () => setRawTime(new Date());
    updateCurrentTime(); // 初回実行

    const timer = setInterval(updateCurrentTime, 60000); // 1分ごと

    return () => clearInterval(timer);
  }, [showCurrentTime]);

  return {
    currentTime,
    currentTimePosition,
    currentTimeLineColor: null,
  };
};
