/** Explicit exceptions keep future mutations denied after expiry by default. */
const managementMutations = new Set([
  'user.deleteAccount',
  'user.requestEmailChange',
  'user.deleteBlocks',
  'user.deleteAllData',
  'user.exportData',
  'user.verifyRecoveryCode',
  'contact.submit',
  // パスワード変更の通知メール。利用期間が終わった後でもパスワードは変更でき
  // （Supabase Auth 側の操作で、tRPC を通らない）、その通知だけがここで止まると
  // 「身に覚えのない変更に気づく」経路が失われる。メール変更（user.requestEmailChange）と
  // リカバリーコード（user.verifyRecoveryCode）を許可しているのと同じ、
  // アカウントの安全を保つ操作として扱う（#2629 の全経路固定で発見）。
  'email.sendPasswordChanged',
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
  'review.trackOpened',
]);

export function requiresProductAccess(path: string, type: string, oauth: boolean): boolean {
  if (oauth) return true;
  if (path === 'externalCalendar.listProviderCalendars') return true;
  if (type !== 'mutation') return false;
  return !managementMutations.has(path);
}
