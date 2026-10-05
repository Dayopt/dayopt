'use client';

import { useCallback, useEffect, useRef } from 'react';

interface SwipeGestureOptions {
  /** スワイプと判定する最小距離（px）。未指定時は画面幅の12%を使用 */
  threshold?: number;
  /** 垂直移動に対する水平移動の最小比率 */
  directionRatio?: number;
  /** スワイプ中のプレビュー表示を有効にするか */
  enablePreview?: boolean;
  /** 無効化 */
  disabled?: boolean;
}

/** 画面幅に基づくスワイプ閾値を計算（業界標準: 10-15%） */
const getResponsiveThreshold = (): number => {
  if (typeof window === 'undefined') return 50;
  // 画面幅の12% を閾値として使用（最小40px、最大80px）
  const calculated = Math.round(window.innerWidth * 0.12);
  return Math.min(Math.max(calculated, 40), 80);
};

interface SwipeGestureResult {
  /** スワイプ方向を検出するハンドラーを取得 */
  handlers: {
    onTouchStart: (e: React.TouchEvent | TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent | TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent | TouchEvent) => void;
  };
  /** ref を要素に設定 */
  ref: React.RefObject<HTMLElement | null>;
}

/**
 * スワイプジェスチャーを検出するフック
 *
 * モバイルの左右スワイプによる日付移動などに使う。
 * **feature 非依存なので `lib/` に置く** — 個別 feature の画面へ依存させない。
 *
 * @example
 * ```tsx
 * const { handlers, ref } = useSwipeGesture({
 *   onSwipeLeft: () => navigate('next'),
 *   onSwipeRight: () => navigate('prev'),
 * })
 *
 * return <div ref={ref} {...handlers}>...</div>
 * ```
 */
export function useSwipeGesture(
  onSwipeLeft?: () => void,
  onSwipeRight?: () => void,
  options: SwipeGestureOptions = {},
): SwipeGestureResult {
  // 閾値未指定時は画面幅ベースの相対値を使用
  const defaultThreshold = typeof window !== 'undefined' ? getResponsiveThreshold() : 50;
  // directionRatio=1.2: |dx|/|dy| が 0.83〜1.2 の狭い帯のみ dead zone。斜めスワイプの無反応感を縮小
  const { threshold = defaultThreshold, directionRatio = 1.2, disabled = false } = options;

  const ref = useRef<HTMLElement | null>(null);
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);
  const touchStartTime = useRef<number>(0);
  const isSwiping = useRef<boolean>(false);
  const swipeDirection = useRef<'left' | 'right' | null>(null);
  const swipeDistance = useRef<number>(0);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent | TouchEvent) => {
      if (disabled) return;

      const touch = 'touches' in e ? e.touches[0] : null;
      if (!touch) return;

      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      touchStartTime.current = Date.now();
      isSwiping.current = true;
      swipeDirection.current = null;
      swipeDistance.current = 0;
    },
    [disabled],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent | TouchEvent) => {
      if (!isSwiping.current || disabled) return;

      const touch = 'touches' in e ? e.touches[0] : null;
      if (!touch) return;

      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = touch.clientY - touchStartY.current;

      // 垂直スクロールが優勢な場合はスワイプをキャンセル
      if (Math.abs(deltaY) > Math.abs(deltaX) * directionRatio) {
        isSwiping.current = false;
        return;
      }

      // 水平スワイプが優勢な場合はスクロールを防止
      if (Math.abs(deltaX) > Math.abs(deltaY) * directionRatio) {
        e.preventDefault();
      }

      swipeDistance.current = deltaX;
      swipeDirection.current = deltaX > 0 ? 'right' : 'left';
    },
    [disabled, directionRatio],
  );

  const handleTouchEnd = useCallback(
    (_e: React.TouchEvent | TouchEvent) => {
      if (!isSwiping.current || disabled) return;

      const deltaX = swipeDistance.current;
      const elapsed = Date.now() - touchStartTime.current;

      // 最大時間制限（500ms以内）
      const isQuickSwipe = elapsed < 500;

      // しきい値を超えたかチェック
      if (Math.abs(deltaX) >= threshold && isQuickSwipe) {
        if (deltaX > 0 && onSwipeRight) {
          onSwipeRight();
        } else if (deltaX < 0 && onSwipeLeft) {
          onSwipeLeft();
        }
      }

      // リセット
      isSwiping.current = false;
      swipeDirection.current = null;
      swipeDistance.current = 0;
    },
    [disabled, threshold, onSwipeLeft, onSwipeRight],
  );

  // ネイティブイベントリスナー（passive: false でpreventDefaultを有効化）
  useEffect(() => {
    const element = ref.current;
    if (!element || disabled) return;

    const touchMoveHandler = (e: TouchEvent) => {
      handleTouchMove(e);
    };

    // passive: false でスクロールを防止可能に
    element.addEventListener('touchmove', touchMoveHandler, { passive: false });

    return () => {
      element.removeEventListener('touchmove', touchMoveHandler);
    };
  }, [handleTouchMove, disabled]);

  return {
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    ref,
  };
}
