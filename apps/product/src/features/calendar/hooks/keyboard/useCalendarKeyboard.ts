import { useEffect, useRef } from 'react';

import type { ShortcutDef } from '@/lib/keyboard/shortcut-registry';
import { registerShortcuts } from '@/lib/keyboard/shortcut-registry';
import type { CalendarViewType } from '../../types/calendar.types';

/** useCalendarKeyboard フックのプロパティ */
interface UseCalendarKeyboardProps {
  viewType: CalendarViewType;
  onNavigate: (direction: 'prev' | 'next' | 'today') => void;
  onViewChange: (view: CalendarViewType) => void;
}

/**
 * カレンダーのキーボードショートカットを提供するフック
 *
 * ショートカット一覧:
 * - Cmd/Ctrl + ←/→: 前後ナビゲーション
 * - Cmd/Ctrl + T: 今日へ移動
 * - Cmd/Ctrl + 1: Day View
 * - Cmd/Ctrl + 3: 3-Day View
 * - Cmd/Ctrl + 5: 5-Day View
 * - Cmd/Ctrl + 7: 7-Day View
 *
 * Cmd/Ctrl + W（週末表示切り替え）は useWeekendToggleShortcut が持つ。ここにも
 * 登録していた時期があり、registry が二重登録の警告を dev で毎回出していた
 */
export const useCalendarKeyboard = ({ onNavigate, onViewChange }: UseCalendarKeyboardProps) => {
  const onNavigateRef = useRef(onNavigate);
  const onViewChangeRef = useRef(onViewChange);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
    onViewChangeRef.current = onViewChange;
  }, [onNavigate, onViewChange]);

  useEffect(() => {
    const shortcuts: ShortcutDef[] = [
      {
        key: 'Cmd+ArrowLeft',
        description: '前の期間へナビゲーション',
        handler: (e) => {
          e.preventDefault();
          onNavigateRef.current('prev');
        },
      },
      {
        key: 'Cmd+ArrowRight',
        description: '次の期間へナビゲーション',
        handler: (e) => {
          e.preventDefault();
          onNavigateRef.current('next');
        },
      },
      {
        key: 'Cmd+T',
        description: '今日へ移動',
        handler: (e) => {
          e.preventDefault();
          onNavigateRef.current('today');
        },
      },
      {
        key: 'Cmd+1',
        description: 'Day View に切り替え',
        handler: (e) => {
          e.preventDefault();
          onViewChangeRef.current('day');
        },
      },
      {
        key: 'Cmd+3',
        description: '3-Day View に切り替え',
        handler: (e) => {
          e.preventDefault();
          onViewChangeRef.current('3day');
        },
      },
      {
        key: 'Cmd+5',
        description: '5-Day View に切り替え',
        handler: (e) => {
          e.preventDefault();
          onViewChangeRef.current('5day');
        },
      },
      {
        key: 'Cmd+7',
        description: '7-Day View に切り替え',
        handler: (e) => {
          e.preventDefault();
          onViewChangeRef.current('7day');
        },
      },
    ];

    return registerShortcuts(shortcuts);
  }, []);
};
