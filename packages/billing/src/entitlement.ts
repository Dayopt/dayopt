import type { DayoptPlanId } from './plans';

/** Legacy identifiers kept for internal caller compatibility. Never use this map for
 * authorization: trial/subscription access is defined by resolveBillingAccess.
 */
export const entitlementKeys = {
  externalCalendarSync: 'external_calendar_sync',
  mcpApi: 'mcp_api',
  reportLongRange: 'report_long_range',
  estimationFullHistory: 'estimation_full_history',
} as const;

export type EntitlementKey = (typeof entitlementKeys)[keyof typeof entitlementKeys];

export const planEntitlements = {
  free: [],
  pro: [
    entitlementKeys.externalCalendarSync,
    entitlementKeys.mcpApi,
    entitlementKeys.reportLongRange,
    entitlementKeys.estimationFullHistory,
  ],
} as const satisfies Record<DayoptPlanId, readonly EntitlementKey[]>;

export function canUseEntitlement(planId: DayoptPlanId, entitlement: EntitlementKey): boolean {
  return (planEntitlements[planId] as readonly EntitlementKey[]).includes(entitlement);
}
