const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REF = /^[a-z]{20}$/;
const SHA = /^[a-f0-9]{40}$/;
const LEGACY_KEYS = [
  'sha',
  'deploymentId',
  'prNumber',
  'branchName',
  'supabaseProjectRef',
  'supabaseBranchId',
  'databaseMode',
];
const MERGED_KEYS = [...LEGACY_KEYS, 'mergedValidation', 'mergeCommitSha'];

function hasExactKeys(request, keys) {
  const actual = Object.keys(request).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateCloudRequest(request) {
  if (
    !request ||
    (!hasExactKeys(request, LEGACY_KEYS) && !hasExactKeys(request, MERGED_KEYS)) ||
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
  const result = Object.fromEntries(LEGACY_KEYS.map((key) => [key, request[key]]));
  if (hasExactKeys(request, MERGED_KEYS)) {
    if (
      typeof request.mergedValidation !== 'boolean' ||
      (request.mergedValidation
        ? !SHA.test(request.mergeCommitSha ?? '')
        : request.mergeCommitSha !== null)
    ) {
      throw new Error('Invalid Cloud Preview merge binding');
    }
    return {
      ...result,
      mergedValidation: request.mergedValidation,
      mergeCommitSha: request.mergeCommitSha,
    };
  }
  return result;
}
