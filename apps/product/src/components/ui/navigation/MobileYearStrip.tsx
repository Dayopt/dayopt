'use client';

import { getMonth, getYear } from 'date-fns';
import { useTranslations } from 'next-intl';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { cn } from '@dayopt/components';

const START_YEAR = 2020;
const END_YEAR = 2050;

type StripItem =
  { type: 'year'; year: number } | { type: 'month'; year: number; month: number; label: string };

interface MobileYearStripProps {
  viewMonth: Date;
  onViewMonthChange: (newMonth: Date) => void;
  className?: string | undefined;
}

/**
 * Google Calendar準拠の横スクロール月セレクタ
 *
 * 月グリッドの下に配置。年ラベル + 12ヶ月が年をまたいで連続し、
 * 横スクロールで過去・未来の月を自由に選択できる。
 */
export const MobileYearStrip = memo<MobileYearStripProps>(
  ({ viewMonth, onViewMonthChange, className }) => {
    const tCommon = useTranslations('common');
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);
    const currentYear = getYear(viewMonth);
    const currentMonth = getMonth(viewMonth);

    const monthsShort = tCommon.raw('dates.monthsShort') as string[];

    // 全年×12ヶ月のフラットリストを生成（年ラベル挟み込み）
    const items = useMemo(() => {
      const result: StripItem[] = [];
      for (let year = START_YEAR; year <= END_YEAR; year++) {
        result.push({ type: 'year', year });
        for (let month = 0; month < 12; month++) {
          result.push({ type: 'month', year, month, label: monthsShort[month]! });
        }
      }
      return result;
    }, [monthsShort]);

    const handleMonthClick = useCallback(
      (year: number, month: number) => {
        onViewMonthChange(new Date(year, month, 1));
      },
      [onViewMonthChange],
    );

    // 選択中の月を中央にスクロール。
    //
    // **初回だけ smooth を使わない。** 2020〜2050 の帯は 24000px 超あり、初期位置から
    // 目的の月まで 5000px 前後をアニメーションさせることになる。その最中に再描画や
    // 別のスクロールが挟まると途中で打ち切られ、選択中の月が画面外のまま残る
    // （2026-09-07 実測: scrollLeft が 17 で停止し、2020 年が見えたまま）。
    // 初期配置は一瞬で決め、以後の月移動だけ滑らかにする。
    const hasPositioned = useRef(false);
    useEffect(() => {
      const el = activeRef.current;
      const container = scrollRef.current;
      if (!el || !container) return;

      const scrollTarget = el.offsetLeft - container.clientWidth / 2 + el.clientWidth / 2;
      container.scrollTo({
        left: scrollTarget,
        behavior: hasPositioned.current ? 'smooth' : 'auto',
      });
      hasPositioned.current = true;
    }, [currentYear, currentMonth]);

    return (
      <div
        ref={scrollRef}
        className={cn(
          'scrollbar-hide flex items-center overflow-x-auto overscroll-x-contain py-2',
          className,
        )}
      >
        {items.map((item) => {
          if (item.type === 'year') {
            return (
              <span
                key={`y-${item.year}`}
                className="text-muted-foreground mx-1 flex h-7 shrink-0 items-center justify-center px-2 text-xs"
              >
                {item.year}
              </span>
            );
          }

          const isActive = item.year === currentYear && item.month === currentMonth;

          return (
            <button
              key={`m-${item.year}-${item.month}`}
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => handleMonthClick(item.year, item.month)}
              className={cn(
                'mx-1 flex h-7 shrink-0 items-center justify-center rounded-full px-4 text-xs transition-colors',
                // 見た目は 28px の細いチップのまま、当たり判定だけ縦へ 44px 広げる
                // （横は px-4 で既に 44px 以上ある）。帯を太らせずに最小サイズを満たす
                // eslint-disable-next-line tailwindcss/no-arbitrary-value -- 擬似要素を描くには content が要り、空文字以外に書きようがない
                'relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[""]',
                isActive
                  ? 'border-primary text-primary-text border font-medium'
                  : 'border-border text-muted-foreground hover:text-foreground border',
              )}
              aria-current={isActive ? 'true' : undefined}
              aria-label={`${item.year}-${String(item.month + 1).padStart(2, '0')}`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    );
  },
);

MobileYearStrip.displayName = 'MobileYearStrip';
