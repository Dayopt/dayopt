'use client';

import React from 'react';

import { format } from 'date-fns';
import { enUS, ja } from 'date-fns/locale';
import { useLocale } from 'next-intl';

import { isTodayInTimezone } from '@/lib/date/timezone';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import { cn } from '@dayopt/components';

import type { DateDisplayProps } from '../../../../types/date-display.types';

// 日付表示用のフォーマットユーティリティ
const useDateFormats = (
  date: Date,
  showDayName: boolean,
  showMonthYear: boolean,
  dayNameFormat: string,
  dateFormat: string,
) => {
  const locale = useLocale();
  const dateFnsLocale = locale === 'ja' ? ja : enUS;
  const dayName = showDayName
    ? format(
        date,
        dayNameFormat === 'short' ? 'EEE' : dayNameFormat === 'long' ? 'EEEE' : 'EEEEE',
        { locale: dateFnsLocale },
      )
    : undefined;

  const dateString = format(date, dateFormat, { locale: dateFnsLocale });
  const monthYear = showMonthYear
    ? format(date, locale === 'ja' ? 'yyyy年M月' : 'MMM yyyy', { locale: dateFnsLocale })
    : undefined;

  return { dayName, dateString, monthYear };
};

// スタイルクラスを生成
const generateDateClassName = (
  today: boolean,
  isSelected: boolean,
  onClick?: (date: Date) => void,
  className?: string,
) => {
  const classes = ['text-center py-2 px-1 transition-colors'];

  // ボタンの場合、デフォルトスタイルをリセット + フォーカス表示
  if (onClick) {
    classes.push(
      'border-0 bg-transparent font-inherit text-inherit outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 rounded-lg',
    );
  }

  // ホバー効果（当日以外のみ）
  if (onClick && !today) {
    classes.push('cursor-pointer hover:bg-state-hover');
  }

  // クリック可能だが当日の場合
  if (onClick && today) {
    classes.push('cursor-pointer');
  }

  // 選択状態（当日以外）
  if (isSelected && !today) {
    classes.push('bg-primary-state-selected text-primary');
  }

  if (className) {
    classes.push(className);
  }

  return cn(...classes);
};

// キーボードイベントハンドラー
const createKeyDownHandler = (onClick?: (date: Date) => void, date?: Date) => {
  if (!onClick || !date) return undefined;

  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(date);
    }
  };
};

// アクセシビリティ属性を生成
const generateAccessibilityProps = (
  onClick?: (date: Date) => void,
  dateFormat?: string,
  date?: Date,
) => {
  if (!onClick) return {};

  return {
    'aria-label': date && dateFormat ? `Select ${format(date, dateFormat)}` : undefined,
  };
};

// 月年表示コンポーネント
const MonthYearDisplay = ({ monthYear }: { monthYear?: string }) => {
  if (!monthYear) return null;

  return <div className="text-muted-foreground mb-1 text-xs">{monthYear}</div>;
};

// 日付メイン表示コンポーネント（横並び）
const DateMainDisplay = ({
  dayName,
  dateString,
  today,
}: {
  dayName?: string;
  dateString: string;
  today: boolean;
}) => (
  <div className={cn('flex items-center', today && 'gap-1')}>
    {dayName ? (
      <div
        className={cn(
          'text-base font-normal',
          today ? 'text-foreground font-medium' : 'text-muted-foreground',
        )}
      >
        {dayName}
      </div>
    ) : null}

    <div
      className={cn(
        'flex size-6 items-center justify-center rounded-full text-base font-normal',
        today && 'bg-primary text-primary-foreground font-medium',
      )}
    >
      {dateString}
    </div>
  </div>
);

/** 日付（曜日・日付・月年）を表示するコンポーネント */
export const DateDisplay = ({
  date,
  className,
  isToday: todayProp,
  isSelected = false,
  showDayName = true,
  showMonthYear = true,
  dayNameFormat = 'short',
  dateFormat = 'd',
  onClick,
  onDoubleClick,
}: DateDisplayProps) => {
  const timezone = useUserPreferences((s) => s.timezone);
  const today = todayProp ?? isTodayInTimezone(date, timezone);

  const { dayName, dateString, monthYear } = useDateFormats(
    date,
    showDayName,
    showMonthYear,
    dayNameFormat,
    dateFormat,
  );
  const dateClassName = generateDateClassName(today, isSelected, onClick, className);
  const keyDownHandler = createKeyDownHandler(onClick, date);
  const accessibilityProps = generateAccessibilityProps(onClick, dateFormat, date);

  // クリック可能な場合はbuttonとして、そうでなければdivとして扱う
  const Component = onClick ? 'button' : 'div';

  return (
    <Component
      className={dateClassName}
      onClick={() => onClick?.(date)}
      onDoubleClick={() => onDoubleClick?.(date)}
      onKeyDown={keyDownHandler}
      {...accessibilityProps}
    >
      <MonthYearDisplay {...(monthYear && { monthYear })} />
      <DateMainDisplay {...(dayName && { dayName })} dateString={dateString} today={today} />
    </Component>
  );
};
