/**
 * tRPCメインルーター
 * 全APIルーターの統合とエクスポート
 */

import 'server-only';

import { activitiesRouter } from '@/features/activities/server/router';
import { createUserRouter } from '@/features/auth/server/router';
import { contactRouter } from '@/features/contact/server/router';
import { externalCalendarRouter } from '@/features/external-calendar/server/router';
import { reviewRouter } from '@/features/review/server/router';
import { billingRouter } from '@/features/settings/server/billing-router';
import { mcpConnectionsRouter } from '@/features/settings/server/mcp-connections-router';
import { userSettingsRouter } from '@/features/settings/server/router';
import { planCommandsRouter } from '@/features/timeblock/server/plan-commands-router';
import { planTemplatesRouter } from '@/features/timeblock/server/plan-templates-router';
import { plansRouter } from '@/features/timeblock/server/plans-router';
import { recordCommandsRouter } from '@/features/timeblock/server/record-commands-router';
import { recordsRouter } from '@/features/timeblock/server/records-router';
import { statisticsRouter } from '@/features/timeblock/server/router-index';
import { timeblockContextRouter } from '@/features/timeblock/server/timeblock-context-router';
import { createTRPCRouter } from '@/lib/trpc/router';

import { prepareAccountDeletionWithCompatibility } from './_composition/account-deletion-selector';

const userRouter = createUserRouter({
  beforeIdentityDeletion: prepareAccountDeletionWithCompatibility,
});

export const appRouter = createTRPCRouter({
  activities: activitiesRouter,
  billing: billingRouter,
  contact: contactRouter,
  externalCalendar: externalCalendarRouter,
  mcpConnections: mcpConnectionsRouter,
  planCommands: planCommandsRouter,
  planTemplates: planTemplatesRouter,
  recordCommands: recordCommandsRouter,
  records: recordsRouter,
  review: reviewRouter,
  plans: plansRouter,
  statistics: statisticsRouter,
  timeblockContext: timeblockContextRouter,
  user: userRouter,
  userSettings: userSettingsRouter,
});

export type AppRouter = typeof appRouter;
