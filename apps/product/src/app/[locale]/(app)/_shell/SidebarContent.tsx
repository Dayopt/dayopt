'use client';

/**
 * Sidebar Content (Composition Layer)
 *
 * Sidebar 外殻へ、現在の画面で必要なナビゲーションを差し込む。
 */

import { isCalendarViewPath } from '@/features/calendar';
import { usePathname } from '@dayopt/i18n/navigation';

import { CalendarSidebar } from './CalendarSidebar';
import { SidebarUtilities } from './SidebarUtilities';

export function SidebarContent() {
  const pathname = usePathname();
  return (
    <>
      {isCalendarViewPath(pathname) && <CalendarSidebar />}
      <SidebarUtilities />
    </>
  );
}
