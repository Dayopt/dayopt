import { describe, expect, it } from 'vitest';
import { requiresProductAccess } from './operation-access';

describe('single-plan operation boundary', () => {
  it.each([
    'planCommands.create',
    'recordCommands.update',
    'activities.restoreActivity',
    'review.createSegment',
    'externalCalendar.syncNow',
    'future.newMutation',
    'user.futureImport',
  ])('requires access for %s', (path) =>
    expect(requiresProductAccess(path, 'mutation', false)).toBe(true),
  );
  it.each([
    'planCommands.delete',
    'recordCommands.delete',
    'activities.deleteCategory',
    'review.deleteSegment',
    'billing.startTrial',
    'billing.createCheckoutSession',
    'mcpConnections.revoke',
    'externalCalendar.disconnect',
    'userSettings.update',
    'user.deleteAccount',
    'user.exportData',
    'user.verifyRecoveryCode',
  ])('preserves management/deletion for %s', (path) =>
    expect(requiresProductAccess(path, 'mutation', false)).toBe(false),
  );
  it('keeps all saved report ranges readable, but blocks provider reads and MCP', () => {
    expect(requiresProductAccess('review.getReportPeriod', 'query', false)).toBe(false);
    expect(requiresProductAccess('externalCalendar.listEvents', 'query', false)).toBe(false);
    expect(requiresProductAccess('externalCalendar.listProviderCalendars', 'query', false)).toBe(
      true,
    );
    expect(requiresProductAccess('plans.list', 'query', true)).toBe(true);
    expect(requiresProductAccess('planCommands.delete', 'mutation', true)).toBe(true);
  });
});
