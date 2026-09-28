const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REF = /^[a-z]{20}$/;
const SHA = /^[a-f0-9]{40}$/;

export function validateCloudRequest(request) {
  if (
    !request ||
    !SHA.test(request.sha ?? '') ||
    !/^dpl_[a-zA-Z0-9]+$/.test(request.deploymentId ?? '') ||
    !Number.isSafeInteger(request.prNumber) ||
    request.prNumber < 1 ||
    typeof request.branchName !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,199}$/.test(request.branchName) ||
    ['main', 'integration'].includes(request.branchName) ||
    !REF.test(request.supabaseProjectRef ?? '') ||
    request.supabaseProjectRef === 'yvglwblxrnrenfifsnje' ||
    !UUID.test(request.supabaseBranchId ?? '') ||
    !['shared', 'ephemeral'].includes(request.databaseMode)
  )
    throw new Error('Invalid Cloud Preview binding');
  const sharedRef = 'tilwaprottpyhlfoggbb';
  const sharedBranch = '4c2ed092-cba3-4f37-98e1-78f61cdf52ed';
  if (
    request.databaseMode === 'shared'
      ? request.supabaseProjectRef !== sharedRef || request.supabaseBranchId !== sharedBranch
      : request.supabaseProjectRef === sharedRef || request.supabaseBranchId === sharedBranch
  ) {
    throw new Error('Cloud Preview database mode does not match its binding');
  }
  return Object.fromEntries(
    [
      'sha',
      'deploymentId',
      'prNumber',
      'branchName',
      'supabaseProjectRef',
      'supabaseBranchId',
      'databaseMode',
    ].map((key) => [key, request[key]]),
  );
}
