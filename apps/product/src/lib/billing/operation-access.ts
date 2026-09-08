/** Explicit exceptions keep future mutations denied after expiry by default. */
const managementMutations = new Set([
  'user.deleteAccount',
  'user.requestEmailChange',
  'user.deleteBlocks',
  'user.deleteAllData',
  'user.exportData',
  'user.verifyRecoveryCode',
  'contact.submit',
  'billing.startTrial',
  'billing.createCheckoutSession',
  'billing.createPortalSession',
  'userSettings.update',
  'userSettings.updateProfile',
  'userSettings.regenerateICalToken',
  'mcpConnections.revoke',
  'externalCalendar.disconnect',
  'activities.deleteCategory',
  'activities.deleteActivity',
  'planCommands.delete',
  'recordCommands.delete',
  'planTemplates.delete',
  'review.deleteSegment',
  'review.trackOpened',
]);

export function requiresProductAccess(path: string, type: string, oauth: boolean): boolean {
  if (oauth) return true;
  if (path === 'externalCalendar.listProviderCalendars') return true;
  if (type !== 'mutation') return false;
  return !managementMutations.has(path);
}
