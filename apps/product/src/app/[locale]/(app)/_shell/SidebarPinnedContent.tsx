'use client';

/**
 * Sidebar の pinned 領域（スクロールに追従しない、プロフィール直上）の中身。
 *
 * MiniCalendar はカレンダーのホームでだけ表示する。workspace 外の設定では表示しない。
 */

import { MiniCalendar } from '@/components/ui/inputs/mini-calendar';
import { isCalendarViewPath, useCalendarNavigation } from '@/features/calendar';
import { usePathname } from '@dayopt/i18n/navigation';

export function SidebarPinnedContent() {
  const pathname = usePathname();
  const navigation = useCalendarNavigation();
  if (!isCalendarViewPath(pathname)) return null;

  return (
    <MiniCalendar
      selectedDate={navigation?.currentDate}
      onDateSelect={(date) => {
        if (date && navigation) navigation.navigateToDate(date, true);
      }}
      // eslint-disable-next-line tailwindcss/no-arbitrary-value -- calc expression
      className="-mx-2 w-[calc(100%+16px)] bg-transparent"
    />
  );
}
