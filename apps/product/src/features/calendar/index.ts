/**
 * Calendar Feature - Public API
 *
 * docs: docs/product/specs/calendar.md
 *
 * この barrel export は外部から参照される公開インターフェースを定義する。
 * 内部モジュールへの直接参照（deep import）は避け、ここからのみ import すること。
 */

// =============================================================================
// Main Controller
// =============================================================================
export { CalendarController } from './components/CalendarController';

// =============================================================================
// Layout Components
// =============================================================================
export { ViewSwitcherList } from './components/layout/Header/ViewSwitcherList';

// =============================================================================
// Filter
// =============================================================================
export { ActivityFilterList } from './components/activity-filter/ActivityFilterList';
export { ActivityChipRow } from './components/activity-filter/components/ActivityChipRow';
export { InlineCreatePanel } from './components/create';

// =============================================================================
// Templates（型）
// =============================================================================
export { TemplateList } from './components/templates/TemplateList';
export { toTemplateView } from './components/templates/toTemplateView';

// =============================================================================
// Types
// =============================================================================
export type {
  CalendarDisplayEvent,
  CalendarViewType,
  MultiDayViewType,
  ViewDateRange,
} from './types/calendar.types';

// =============================================================================
// Contexts
// =============================================================================
export {
  CalendarNavigationProvider,
  useCalendarNavigation,
} from './hooks/navigation/CalendarNavigationContext';

// =============================================================================
// State / settings（app composition 層からのbarrel import用）
// =============================================================================
// Note: useInlineCreateStore / useCalendarFilterStore は barrel 公開せず deep import で参照する。
// useUserPreferences は app-wide なserver stateのため @/lib/hooks/ 配下に置く。
export { useCalendarSettings } from './hooks/useCalendarSettings';
export { useCalendarNavigationStore } from './stores/useCalendarNavigationStore';
export type { UserSettings } from './stores/userSettings';
export { useTimeblockClipboardStore } from './stores/useTimeblockClipboardStore';
// =============================================================================
// Hooks
// =============================================================================

// Hooks: Cross-feature (used by composition layer in app/)
export { useCalendarData } from './components/controller/hooks/useCalendarData';
export { useCalendarHandlers } from './components/controller/hooks/useCalendarHandlers';
export { useCalendarNavigationHandlers } from './components/controller/hooks/useCalendarNavigationHandlers';
export { useCalendarEventKeyboard } from './hooks/keyboard/useCalendarTimeblockKeyboard';
export { useShortcutRegistry } from './hooks/keyboard/useShortcutRegistry';
export { useTimeblockSearchShortcut } from './hooks/keyboard/useTimeblockSearchShortcut';
export { useWeekendToggleShortcut } from './hooks/keyboard/useWeekendToggleShortcut';
export { useTimeblockContextActions } from './hooks/operations/useTimeblockContextActions';
export { useTimeblockOperations } from './hooks/operations/useTimeblockOperations';
export { CALENDAR_SHORTCUT_CATALOG } from './lib/calendar-shortcut-catalog';

// =============================================================================
// Domain（Calendar 固有の仕様ルール）
// =============================================================================
export { calculateViewDateRange } from './domain/view-range';

// =============================================================================
// Lib / Utils
// =============================================================================
export { formatCalendarDateParam, parseCalendarDateParam } from './lib/date-param';
export { buildReportPath } from './lib/panel-url';
export { isCalendarViewPath, resolveWorkspaceTab } from './lib/route-utils';
export type { WorkspaceTab } from './lib/route-utils';
export {
  buildTimeblockSearchResultPath,
  resolveTimeblockSearchResultDate,
} from './lib/timeblock-search-path';
export type { TimeblockSearchResult } from './lib/timeblock-search-results';

// ここにないものはfeature内部専用
