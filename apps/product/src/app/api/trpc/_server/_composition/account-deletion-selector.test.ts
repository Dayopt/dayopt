import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const storageList = vi.hoisted(() => vi.fn());
const storageRemove = vi.hoisted(() => vi.fn());
const deleteLegacyBillingAccountData = vi.hoisted(() => vi.fn());
const deletePostHogAccountData = vi.hoisted(() => vi.fn());
const prepareDurable = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    rpc,
    storage: {
      from: () => ({ list: storageList, remove: storageRemove }),
    },
  }),
}));
vi.mock('@/features/settings/server/account-deletion', () => ({
  deleteLegacyBillingAccountData,
}));
vi.mock('@/lib/analytics/posthog-deletion', () => ({ deletePostHogAccountData }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError }));
vi.mock('./account-deletion-coordinator', () => ({
  prepareAccountDeletionBeforeIdentityDeletion: prepareDurable,
}));

import { prepareAccountDeletionWithCompatibility } from './account-deletion-selector';

const USER_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  storageList.mockResolvedValue({ data: [], error: null });
  storageRemove.mockResolvedValue({ data: [], error: null });
  deleteLegacyBillingAccountData.mockResolvedValue(undefined);
  deletePostHogAccountData.mockResolvedValue(undefined);
  prepareDurable.mockResolvedValue({ status: 'completed' });
});

describe('prepareAccountDeletionWithCompatibility', () => {
  it('gateがinactiveかつ処理中でなければ現行互換経路を使う', async () => {
    rpc.mockImplementation((operation: string) => {
      return operation === 'get_external_lifecycle_app_version_v2'
        ? { abortSignal: vi.fn(async () => ({ data: 1, error: null })) }
        : Promise.resolve({ data: [{ activated: false, active_operations: 0 }], error: null });
    });

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });

    expect(storageList).toHaveBeenCalledWith(USER_ID);
    expect(deleteLegacyBillingAccountData).toHaveBeenCalledWith(USER_ID);
    expect(deletePostHogAccountData).toHaveBeenCalledWith({ userId: USER_ID });
    expect(prepareDurable).not.toHaveBeenCalled();
  });

  it('既知の旧DBでは現行互換経路を使う', async () => {
    rpc.mockReturnValue({
      abortSignal: vi.fn(async () => ({ data: null, error: { code: 'PGRST202' } })),
    });

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });
    expect(deletePostHogAccountData).toHaveBeenCalledWith({ userId: USER_ID });
    expect(deleteLegacyBillingAccountData).toHaveBeenCalledWith(USER_ID);
    expect(prepareDurable).not.toHaveBeenCalled();
  });

  it('PostHog削除が失敗したら互換退会準備をfail closedにする', async () => {
    rpc.mockReturnValue({
      abortSignal: vi.fn(async () => ({ data: null, error: { code: 'PGRST202' } })),
    });
    deletePostHogAccountData.mockRejectedValue(new Error('PostHog deletion rejected'));

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).rejects.toThrow(
      'PostHog deletion rejected',
    );
    expect(deletePostHogAccountData).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('gateがactiveならdurable coordinatorだけを使う', async () => {
    rpc.mockImplementation((operation: string) => {
      return operation === 'get_external_lifecycle_app_version_v2'
        ? { abortSignal: vi.fn(async () => ({ data: 1, error: null })) }
        : Promise.resolve({ data: [{ activated: true, active_operations: 0 }], error: null });
    });

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });
    expect(prepareDurable).toHaveBeenCalledWith({ userId: USER_ID });
    expect(storageList).not.toHaveBeenCalled();
    expect(deleteLegacyBillingAccountData).not.toHaveBeenCalled();
  });

  it('inactive中に処理が残る不整合はfail closedにする', async () => {
    rpc.mockImplementation((operation: string) => {
      return operation === 'get_external_lifecycle_app_version_v2'
        ? { abortSignal: vi.fn(async () => ({ data: 1, error: null })) }
        : Promise.resolve({ data: [{ activated: false, active_operations: 1 }], error: null });
    });

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).rejects.toThrow(
      'Inactive account deletion gate has active operations',
    );
    expect(storageList).not.toHaveBeenCalled();
  });

  it('未知のreadiness failureを現行経路へ落とさない', async () => {
    rpc.mockImplementation((operation: string) => {
      return operation === 'get_external_lifecycle_app_version_v2'
        ? { abortSignal: vi.fn(async () => ({ data: 1, error: null })) }
        : Promise.resolve({ data: null, error: { code: '42501' } });
    });

    await expect(prepareAccountDeletionWithCompatibility({ userId: USER_ID })).rejects.toThrow(
      'Account deletion readiness could not be verified',
    );
    expect(storageList).not.toHaveBeenCalled();
  });
});
