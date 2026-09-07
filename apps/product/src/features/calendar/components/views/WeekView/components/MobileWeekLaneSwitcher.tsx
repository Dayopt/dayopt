'use client';

import { useTranslations } from 'next-intl';

import type { MobileWeekDisplayMode } from '@/features/calendar/stores/useCalendarDisplayModeStore';
import { cn } from '@dayopt/components';

interface MobileWeekLaneSwitcherProps {
  value: MobileWeekDisplayMode;
  onValueChange: (value: MobileWeekDisplayMode) => void;
  className?: string | undefined;
}

const OPTIONS = [
  { value: 'planned', labelKey: 'calendar.timeblock.preview.plan' },
  { value: 'recorded', labelKey: 'calendar.timeblock.preview.record' },
] as const;

/** モバイルWeekで予定と記録のどちらを表示するか切り替える。 */
export function MobileWeekLaneSwitcher({
  value,
  onValueChange,
  className,
}: MobileWeekLaneSwitcherProps) {
  const t = useTranslations();

  return (
    <div
      role="group"
      aria-label={t('calendar.mobile.weekLaneSwitcher.ariaLabel')}
      className={cn(
        'border-border-subtle bg-container grid grid-cols-2 gap-1 rounded-lg border p-1',
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const isActive = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'focus-visible:ring-ring min-h-11 rounded-lg px-4 py-2 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-state-hover hover:text-foreground',
            )}
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
