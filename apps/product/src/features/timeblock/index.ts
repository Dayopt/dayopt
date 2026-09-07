/**
 * Timeblock Feature - Public API
 *
 * docs: docs/product/specs/plan-record.md
 *
 * この barrel export は外部から参照される公開インターフェースを定義する。
 * 内部モジュールへの直接参照（deep import）は避け、ここからのみ import すること。
 */

// =============================================================================
// Types
// =============================================================================
export type { ClipboardTimeblock } from './lib/timeblock-clipboard';
export type { CalendarEvent } from './types/calendar-event';
export type { PlanEvent, PlanEventStatus } from './types/plan-event';
export type { RecordEvent } from './types/record-event';

// =============================================================================
// Hooks
// =============================================================================
export { usePlanTemplateMutations, useTimeblockWriteMutations } from './hooks';

// =============================================================================
// Stores
// =============================================================================
export { useTimeblockInspectorStore } from './stores/useTimeblockInspectorStore';

// =============================================================================
// Lib (actual-time overlay)
// =============================================================================
export { computeActualTimeDiffOverlay, formatDiffMinutes } from './lib/actual-time-overlay';
export { TIMEBLOCK_INSPECTOR_SLOT_KEY } from './lib/inspector-slot';
export { TIMEBLOCK_PARAM, serializeTimeblockParam } from './lib/inspector-url';
export { timeblockTintColor } from './lib/timeblock-tint';

// =============================================================================
// Domain (時間モデル — 純粋関数、DB/tRPC/React 非依存)
// =============================================================================
export { isPlanRecordDrop, resolveTimeblockDestination } from './domain/timeblock-destination';
export type { TimeblockDestination } from './domain/timeblock-destination';
// テンプレート（型）— 保存する組成を「生きた日」から取り出す（#2567）
export { deriveTemplateBlocksFromDay } from './domain/plan-template-compose';

// =============================================================================
// Lib (iCal export)
// =============================================================================
export { plansToICal } from './lib/plan-to-ical';

// =============================================================================
// Lib (timeblock menu items — 右クリック / Inspector メニュー共通の項目定義)
// =============================================================================
export { createClipboardTimeblock } from './lib/timeblock-clipboard';
export { createTimeblockDuplicateDraft } from './lib/timeblock-duplicate';
export { collectTimeblockLaneItems, hasTimeblockLaneConflict } from './lib/timeblock-lane-conflict';
export { getTimeblockMenuItems } from './lib/timeblock-menu-items';

// =============================================================================
// Components (Inspector fields — 他 feature から再利用可能な入力 row)
// =============================================================================
export { ActivityFieldRow } from './components/inspector/fields/ActivityFieldRow';
export { DateTimeSection } from './components/inspector/fields/DateTimeSection';
export { TimeConflictAlert } from './components/inspector/fields/TimeConflictAlert';

// ここにないものはfeature内部専用

export { aggregate, overlappingRecords, toDerivedBlock } from './domain/derived-model';
export type { DerivedBlock } from './domain/derived-model';
