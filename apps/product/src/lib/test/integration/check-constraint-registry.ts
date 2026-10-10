/**
 * 値を列挙する CHECK 制約の登録表（#3092）。
 *
 * キーは `<schema>.<table>.<constraint>`。`check-constraint-registry.integration.test.ts` が
 * 実 DB の全制約と突き合わせ、未登録・値の不一致・削除済みの項目を失敗にする。
 *
 * source の決め方:
 * - `ts`: TS（test を除く）がその table を `.from()` で読み書きする、または値の集合を型・定数として
 *   持つ。値は TS の正本定数から渡す。正本がまだ無いものはリテラルで書き、正本を作る Issue を残す。
 * - `db`: DB 内部の状態値で、TS は値を扱わない。DB が正本で、TS の写しは作らない。
 * - `excluded`: 複合条件で、値の集合として比べられない。
 *
 * @see docs/engineering/conventions.md §正本と派生（判断と展開の分離）
 */
import { subscriptionStatuses } from '@dayopt/billing';
import { SUPPORTED_LOCALES } from '@dayopt/config';

import { CATEGORY_COLOR_NAMES } from '@/features/activities/lib/category-colors';
import { fulfillmentSchema } from '@/features/timeblock/schemas/timeblock';
import { PRODUCT_EVENT_NAMES } from '@/lib/analytics/product-events';
import type { CheckConstraintRegistry } from '@/lib/test/check-constraint-registry-diff';
import { planSources, recordSources } from '@/lib/time/timeblock';
import { timeFormats, weekStartsOnValues } from '@/lib/time/user-preference';

import { JOB_MAX_AGE_MINUTES } from '../../ops/cron-heartbeat-policy.mjs';

/** DB の `'unknown'` は、識別できない旧 client の行を残すための値（`clients.ts` の runtime allowlist には含めない）。 */
const OAUTH_CLIENT_IDS_WITH_UNKNOWN = ['claude-ai', 'chatgpt', 'cursor', 'unknown'];
// 正本は #3095 で `OAUTH_CLIENT_IDS` として作る。それまでは `OAuthClientId` の値をここに写す。
const OAUTH_CLIENT_IDS = ['claude-ai', 'chatgpt', 'cursor'];

const DB_INTERNAL = 'DB 関数の内部状態で、TS は値を扱わない';

export const CHECK_CONSTRAINT_REGISTRY: CheckConstraintRegistry = {
  // --- public: TS が正本 ---
  'public.plans.plans_source_check': { source: 'ts', values: planSources },
  'public.records.records_source_check': { source: 'ts', values: recordSources },
  'public.records.records_fulfillment_check': { source: 'ts', values: fulfillmentSchema.options },
  'public.categories.categories_color_valid': { source: 'ts', values: CATEGORY_COLOR_NAMES },
  'public.user_settings.user_settings_time_format_check': { source: 'ts', values: timeFormats },
  'public.user_settings.user_settings_week_starts_on_check': {
    source: 'ts',
    values: weekStartsOnValues,
  },
  // 正本は #3094 で `user-preference.ts` に作る。
  'public.user_settings.user_settings_theme_check': {
    source: 'ts',
    values: ['light', 'dark', 'system'],
  },
  'public.user_settings.user_settings_preferred_locale_check': {
    source: 'ts',
    values: SUPPORTED_LOCALES,
  },
  'public.profiles.profiles_subscription_status_check': {
    source: 'ts',
    values: subscriptionStatuses,
  },
  'public.product_events.product_events_event_name_check': {
    source: 'ts',
    values: PRODUCT_EVENT_NAMES,
  },
  'public.cron_heartbeats.cron_heartbeats_job_name_check': {
    source: 'ts',
    values: Object.keys(JOB_MAX_AGE_MINUTES),
  },
  // 正本は未作成（`stripe-webhook` の状態遷移で文字列を直書き）。#3089 の台帳で扱う。
  'public.stripe_webhook_events.stripe_webhook_events_status_check': {
    source: 'ts',
    values: ['processing', 'processed', 'failed'],
  },
  // 正本は未作成（`webhooks/resend/route.ts` の引数型）。
  'public.email_suppressions.email_suppressions_reason_check': {
    source: 'ts',
    values: ['bounce', 'complaint'],
  },
  // 正本は未作成（`oauth-server/tokens.ts` の `TokenType`）。
  'public.oauth_tokens.oauth_tokens_token_type_check': {
    source: 'ts',
    values: ['access', 'refresh'],
  },
  'public.oauth_tokens.oauth_tokens_client_id_check': {
    source: 'ts',
    values: OAUTH_CLIENT_IDS_WITH_UNKNOWN,
  },
  'public.oauth_authorization_codes.oauth_authorization_codes_client_id_check': {
    source: 'ts',
    values: OAUTH_CLIENT_IDS_WITH_UNKNOWN,
  },
  'public.oauth_connections.oauth_connections_client_id_check': {
    source: 'ts',
    values: OAUTH_CLIENT_IDS_WITH_UNKNOWN,
  },
  'public.mcp_mutation_receipts.mcp_mutation_receipts_client_id_check': {
    source: 'ts',
    values: OAUTH_CLIENT_IDS,
  },
  'public.mcp_mutation_control.mcp_mutation_control_enabled_clients_valid': {
    source: 'ts',
    values: OAUTH_CLIENT_IDS,
  },
  // 正本は未作成（`env.ts` の `MCP_OAUTH_ENVIRONMENT` の z.enum）。
  'public.mcp_environment_identity.mcp_environment_identity_environment_check': {
    source: 'ts',
    values: ['production', 'preview', 'integration'],
  },

  // --- public: DB が正本 ---
  'public.calendar_connections.calendar_connections_status_check': {
    source: 'db',
    reason: 'TS は calendar_connections を RPC 経由でのみ扱い、status の値を持たない',
  },
  'public.mcp_mutation_receipts.mcp_mutation_receipts_resource_type_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'public.mcp_mutation_receipts.mcp_mutation_receipts_digest_version_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'public.undo_receipt_effects.undo_receipt_effects_effect_kind_valid': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'public.undo_receipt_field_changes.undo_receipt_field_changes_field_name_allowlist': {
    source: 'db',
    reason: DB_INTERNAL,
  },

  // --- private: DB が正本 ---
  'private.timeblock_transaction_states.timeblock_transaction_states_mode_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.account_deletion_operations.account_deletion_operations_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.account_deletion_steps.account_deletion_steps_step_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.account_deletion_steps.account_deletion_steps_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.billing_mutation_claims.billing_mutation_claims_mutation_kind_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.billing_mutation_claims.billing_mutation_claims_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.billing_mutation_claims.billing_mutation_claims_state_shape': {
    source: 'excluded',
    reason: 'state と terminal_reason などの組み合わせ条件',
  },
  'private.billing_account_deletion_bindings.billing_account_deletion_bindings_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.billing_account_deletion_bindings.billing_account_deletion_bindings_provider_outcome_check':
    { source: 'db', reason: DB_INTERNAL },
  'private.billing_customer_provisioning.billing_customer_provisioning_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_authority_fences.calendar_authority_fences_scope_kind_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_authority_fences.calendar_authority_fences_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_revoke_operations.calendar_revoke_operations_account_deletion_item_kind_check':
    { source: 'db', reason: DB_INTERNAL },
  'private.calendar_revoke_operations.calendar_revoke_operations_operation_kind_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_revoke_operations.calendar_revoke_operations_state_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_revoke_operations.calendar_revoke_operations_initial_result_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_revoke_operations.calendar_revoke_operations_provider_attempt_outcome_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_revoke_operations.calendar_revoke_operations_provider_attempt_reason_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.calendar_authority_command_receipts.calendar_authority_command_receipts_command_kind_check':
    { source: 'db', reason: DB_INTERNAL },
  'private.integration_security_events.integration_security_events_event_kind_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
  'private.legacy_oauth_bind_observations.legacy_oauth_bind_observations_source_table_check': {
    source: 'db',
    reason: DB_INTERNAL,
  },
};
