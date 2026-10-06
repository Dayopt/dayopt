import { describe, expect, it } from 'vitest';
import { createCloudIntent, validateCloudIntent } from './preview-cloud-intent.mjs';
const request = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_test123',
  prNumber: 2949,
  branchName: 'codex/test',
  databaseMode: 'shared',
  supabaseProjectRef: 'tilwaprottpyhlfoggbb',
  supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
};
const env = {
  GITHUB_REPOSITORY: 'Dayopt/dayopt',
  GITHUB_REF: 'refs/heads/integration',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_REF: 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration',
  GITHUB_RUN_ID: '36405214644',
  GITHUB_RUN_ATTEMPT: '1',
};
const make = () => createCloudIntent({ request, env });
describe('Cloud Preview durable intent', () => {
  it('binds separate planned identities to an exact source run, attempt, candidate and database', () => {
    const a = make();
    const b = make();
    expect(a).toMatchObject({ request, sourceRunId: 36405214644, sourceAttempt: 1 });
    expect(a.schemaVersion).toBe(2);
    expect(new Set([a.runId, ...Object.values(a.userIds)]).size).toBe(4);
    expect(a.runId).not.toBe(b.runId);
    expect(a.userIds.desktop).not.toBe(b.userIds.desktop);
    expect(validateCloudIntent(a)).toEqual(a);
    expect(JSON.stringify(a)).not.toMatch(/password|secret|token|email/i);
  });
  it.each([
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'fork/dayopt' },
    { GITHUB_RUN_ID: '1;echo TOKEN' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_SHA: 'old' },
    { GITHUB_WORKFLOW_REF: 'Dayopt/dayopt/.github/workflows/other.yml@refs/heads/integration' },
  ])('refuses unsupported producer context: %j', (override) => {
    expect(() => createCloudIntent({ request, env: { ...env, ...override } })).toThrow();
  });
  it('rejects extra data and seed or duplicated identity before recovery', () => {
    const a = make();
    expect(() => validateCloudIntent({ ...a, token: 'PRIVATE' })).toThrow();
    expect(() =>
      validateCloudIntent({ ...a, request: { ...request, token: 'PRIVATE' } }),
    ).toThrow();
    expect(() =>
      validateCloudIntent({ ...a, userIds: { desktop: a.runId, mobile: a.userIds.mobile } }),
    ).toThrow();
    expect(() =>
      validateCloudIntent({
        ...a,
        userIds: { desktop: '00000000-0000-0000-0000-000000000001', mobile: a.userIds.mobile },
      }),
    ).toThrow();
    expect(() =>
      validateCloudIntent({
        ...a,
        request: { ...request, supabaseProjectRef: 'yvglwblxrnrenfifsnje' },
      }),
    ).toThrow();
  });
  it('keeps schema v1 recovery artifacts valid without adding an unplanned identity', () => {
    const current = make();
    const previous = validateCloudIntent({
      ...current,
      schemaVersion: 1,
      userIds: { desktop: current.userIds.desktop, mobile: current.userIds.mobile },
    });
    expect(previous).toMatchObject({
      schemaVersion: 1,
      userIds: { desktop: current.userIds.desktop, mobile: current.userIds.mobile },
    });
    expect(previous.userIds).not.toHaveProperty('accountDeletion');
    expect(() => validateCloudIntent({ ...previous, userIds: current.userIds })).toThrow();
  });
  it('keeps retries separate even for the same workflow run', () => {
    const a = make();
    const b = createCloudIntent({ request, env: { ...env, GITHUB_RUN_ATTEMPT: '2' } });
    expect(b.sourceRunId).toBe(a.sourceRunId);
    expect(b.sourceAttempt).toBe(2);
    expect(b.runId).not.toBe(a.runId);
    expect(b.userIds.desktop).not.toBe(a.userIds.desktop);
  });
  it('preserves an exact merged Integration binding in the recovery intent', () => {
    const mergeRequest = {
      ...request,
      mergedValidation: true,
      mergeCommitSha: 'c'.repeat(40),
    };
    const mergedIntent = createCloudIntent({ request: mergeRequest, env });
    expect(validateCloudIntent(mergedIntent)).toEqual(mergedIntent);
    expect(() =>
      validateCloudIntent({
        ...mergedIntent,
        request: { ...mergeRequest, mergeCommitSha: 'short' },
      }),
    ).toThrow();
  });
});
