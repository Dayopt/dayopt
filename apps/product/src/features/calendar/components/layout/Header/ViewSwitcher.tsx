'use client';

import { useCallback, useEffect, useRef } from 'react';

import { Check, ChevronDown, LayoutTemplate } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCalendarSettings } from '@/features/calendar/hooks/useCalendarSettings';
import type { UserSettings } from '@/features/calendar/stores/userSettings';
import { useUpdateUserSettings } from '@/lib/hooks/useUpdateUserSettings';
import { useUserPreferences } from '@/lib/hooks/useUserPreferences';
import type { ShortcutDef } from '@/lib/keyboard/shortcut-registry';
import { registerShortcuts } from '@/lib/keyboard/shortcut-registry';
import { useShellStore } from '@/lib/stores/useShellStore';
import {
  buttonVariants,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dayopt/components';
import { getMultiDayCount, type CalendarViewType } from '../../../types/calendar.types';

/** ViewSwitcher コンポーネントのプロパティ */
interface ViewSwitcherProps {
  currentView: CalendarViewType;
  onChange: (view: CalendarViewType) => void;
  onSettingsChange?: ((settings: Partial<UserSettings>) => void) | undefined;
  /**
   * 「この並びを型として保存」（#2567）。表示中の日の盤面を型にする導線で、
   * 保存対象の日が一意に決まる日ビューでだけ出す。渡さなければ項目自体が出ない。
   */
  onSaveAsTemplate?: (() => void) | undefined;
  /** 保存できる並びが無い（空の日）時に項目を無効化する */
  saveAsTemplateDisabled?: boolean | undefined;
  className?: string;
}

/** ビュー選択オプションの定義 */
interface MainViewOption {
  value: CalendarViewType;
  count: number;
  shortcut: string;
}

const MAIN_VIEW_OPTIONS: MainViewOption[] = [
  { value: 'day', count: 1, shortcut: '1' },
  { value: '2day', count: 2, shortcut: '2' },
  { value: '3day', count: 3, shortcut: '3' },
  { value: '4day', count: 4, shortcut: '4' },
  { value: '5day', count: 5, shortcut: '5' },
  { value: '6day', count: 6, shortcut: '6' },
  { value: '7day', count: 7, shortcut: '7' },
];

const DENSITY_OPTIONS = ['compact', 'default', 'spacious'] as const;

/**
 * ビュー切り替えドロップダウン（1〜7日のビューを直接表示）
 *
 * メニュー構造:
 * - 1日 / 2日 / ... / 7日
 * - 週表示設定（週末表示 / 週番号 / 密度 / 一般設定）
 */
export function ViewSwitcher({
  currentView,
  onChange,
  onSettingsChange,
  onSaveAsTemplate,
  saveAsTemplateDisabled = false,
  className,
}: ViewSwitcherProps) {
  const t = useTranslations();
  const showWeekends = useCalendarSettings((s) => s.showWeekends);
  const showWeekNumbers = useUserPreferences((s) => s.showWeekNumbers);
  const hourHeightDensity = useCalendarSettings((s) => s.hourHeightDensity);
  const updateSettings = useUpdateUserSettings();

  const persistSettings = useCallback(
    (
      settings: Partial<
        Pick<UserSettings, 'showWeekends' | 'showWeekNumbers' | 'hourHeightDensity'>
      >,
    ) => {
      if (onSettingsChange) {
        onSettingsChange(settings);
      } else {
        updateSettings.mutate(settings);
      }
    },
    [onSettingsChange, updateSettings],
  );

  const currentLabel =
    currentView === 'day'
      ? t('calendar.views.day')
      : currentView === 'week'
        ? t('calendar.views.week')
        : t('calendar.views.multiday', { count: getMultiDayCount(currentView) });

  const getMainViewLabel = (option: MainViewOption): string =>
    option.count === 1
      ? t('calendar.views.day')
      : t('calendar.views.multiday', { count: option.count });

  const handleSelect = useCallback(
    (value: CalendarViewType) => {
      onChange(value);
    },
    [onChange],
  );

  const handleToggleWeekends = useCallback(() => {
    persistSettings({ showWeekends: !showWeekends });
  }, [showWeekends, persistSettings]);

  const handleToggleWeekNumbers = useCallback(() => {
    persistSettings({ showWeekNumbers: !showWeekNumbers });
  }, [showWeekNumbers, persistSettings]);

  // キーボードショートカット: 1〜7
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const shortcuts: ShortcutDef[] = [
      // 1 → Day View
      {
        key: '1',
        description: '1日表示に切り替え（1）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('day');
        },
      },
      {
        key: '2',
        description: '2日表示に切り替え（2）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('2day');
        },
      },
      {
        key: '3',
        description: '3日表示に切り替え（3）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('3day');
        },
      },
      {
        key: '4',
        description: '4日表示に切り替え（4）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('4day');
        },
      },
      {
        key: '5',
        description: '5日表示に切り替え（5）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('5day');
        },
      },
      {
        key: '6',
        description: '6日表示に切り替え（6）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('6day');
        },
      },
      {
        key: '7',
        description: '7日表示に切り替え（7）',
        handler: (e) => {
          e.preventDefault();
          onChangeRef.current('7day');
        },
      },
    ];

    return registerShortcuts(shortcuts);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'justify-start gap-0 text-sm',
          className,
        )}
      >
        <span>{currentLabel}</span>
        <ChevronDown className="ml-2 size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={8} className="min-w-48">
        {/* メインビュー */}
        {MAIN_VIEW_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => handleSelect(option.value)}
            className="flex items-center justify-between gap-2"
          >
            <span>{getMainViewLabel(option)}</span>
            <div className="flex items-center gap-2">
              {currentView === option.value && <Check className="text-primary size-4" />}
              {currentView !== option.value && <span className="w-4" />}
              <span className="bg-surface-container text-muted-foreground rounded-lg px-2 py-1 font-mono text-xs">
                {option.shortcut}
              </span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuCheckboxItem checked={showWeekends} onCheckedChange={handleToggleWeekends}>
          {t('calendar.views.showWeekends')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showWeekNumbers}
          onCheckedChange={handleToggleWeekNumbers}
        >
          {t('calendar.views.showWeekNumbers')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />

        <span className="text-muted-foreground px-2 py-1 text-xs font-medium">
          {t('calendar.views.density')}
        </span>

        {DENSITY_OPTIONS.map((d) => (
          <DropdownMenuCheckboxItem
            key={d}
            checked={hourHeightDensity === d}
            onCheckedChange={() => persistSettings({ hourHeightDensity: d })}
          >
            {t(`calendar.views.density_${d}`)}
          </DropdownMenuCheckboxItem>
        ))}

        {onSaveAsTemplate && currentView === 'day' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onSaveAsTemplate}
              disabled={saveAsTemplateDisabled}
              className="gap-2"
            >
              <LayoutTemplate className="size-4" />
              {t('calendar.templates.saveLabel')}
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => useShellStore.getState().openSettings('display')}>
          {t('calendar.views.generalSettings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
