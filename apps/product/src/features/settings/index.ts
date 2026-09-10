/**
 * Settings Feature - Public API
 *
 * docs: docs/product/specs/settings.md
 *
 * ユーザー設定（カレンダー設定、タイムゾーン、日付フォーマットなど）の管理。
 * client / shared consumer はここから、server consumer は `./server` から import すること。
 * それより深い内部モジュールへの直接参照（deep import）は避ける。
 *
 * ## このfeatureは通常featureではなく cross-cutting composition
 *
 * - ESLint feature DAG から除外されている（`apps/product/eslint.config.mjs` 参照）
 * - 他 feature のUI storeをdeep importするのはcompositionの責務として許容される例外運用
 * - 自身の domain は持たない（business rule は calendar / billing 等が持つ）
 * - `userSettingsRouter` / `billingRouter` は settings UI からの書き込み入口として
 *   server を同居（billing は launch 後に独立 feature 化を検討）
 *
 * 詳細: AGENTS.md / `pr-cross-review` skill の Composition Feature セクション
 */

// =============================================================================
// Constants
// =============================================================================
export { SETTINGS_CATEGORIES } from './constants';

// =============================================================================
// Components (for Composition Layer / routing pages)
// =============================================================================
export { MobileAccountOverview } from './components/MobileAccountOverview';
export { SettingsContent, isValidCategory } from './components/SettingsContent';
export { UserSettingsInitializer } from './components/UserSettingsInitializer';

// =============================================================================
// Hooks
// =============================================================================
export { usePaymentErrorDialog } from './hooks/usePaymentErrorDialog';
export { useStableBillingOperation } from './hooks/useStableBillingOperation';
export { useTrialEndedDialog } from './hooks/useTrialEndedDialog';
export { useUserSettings } from './hooks/useUserSettings';

// =============================================================================
// Dialogs
// =============================================================================
export { PaymentErrorDialog } from './components/PaymentErrorDialog';
export { TrialEndedDialog } from './components/TrialEndedDialog';

// =============================================================================
// Utils
// =============================================================================
export { getBillingOperationErrorPresentation } from './lib/billing-operation';
export {
  BILLING_POLL_INTERVAL_MS,
  BILLING_POLL_MAX_DURATION_MS,
  hasBillingPollTimedOut,
  shouldContinueBillingPoll,
} from './lib/billing-poll';
export { reportBillingReturnPollTimeout } from './lib/billing-poll-observability';

// =============================================================================
// Stores (Composition Layer 向け)
// =============================================================================
export { useBillingPollStore } from './stores/useBillingPollStore';

// タイムゾーン等のserver stateはuseUserPreferences経由でquery cacheから取得する。

// ここにないものはfeature内部専用
