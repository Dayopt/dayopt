import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountDeletionCoordinator,
  deleteAccountStorage,
} from './account-deletion-coordinator';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const GENERIC_DELETION_ID = '00000000-0000-4000-8000-000000000002';
const CALENDAR_DELETION_ID = '00000000-0000-4000-8000-000000000003';
const CALENDAR_LEASE_ID = '00000000-0000-4000-8000-000000000004';
const STORAGE_LEASE_ID = '00000000-0000-4000-8000-000000000005';
const SECOND_STORAGE_LEASE_ID = '00000000-0000-4000-8000-000000000006';
const BILLING_LEASE_ID = '00000000-0000-4000-8000-000000000007';
const LEASE_EXPIRES_AT = '2026-07-28T00:05:00.000Z';

type MockRpcResponse = Readonly<{
  data: unknown;
  error: unknown;
}>;

function success(data: unknown): MockRpcResponse {
  return { data, error: null };
}

function failure(code: string): MockRpcResponse {
  return { data: null, error: { code, message: 'private database error' } };
}

function claimed(leaseId: string): MockRpcResponse {
  return success([
    {
      lease_expires_at: LEASE_EXPIRES_AT,
      lease_id: leaseId,
      result: 'claimed',
    },
  ]);
}

function completed(): MockRpcResponse {
  return success([{ lease_expires_at: null, lease_id: null, result: 'completed' }]);
}

function createDb(responses: Record<string, MockRpcResponse[]>) {
  const queues = new Map(Object.entries(responses).map(([name, values]) => [name, [...values]]));
  const rpc = vi.fn((name: string, _args?: unknown) => ({
    abortSignal: vi.fn(async () => {
      const response = queues.get(name)?.shift();
      if (response === undefined) throw new Error(`Unexpected RPC: ${name}`);
      return response;
    }),
  }));

  return { db: { rpc } as never, rpc };
}

function createRuntime(responses: Record<string, MockRpcResponse[]>) {
  const { db, rpc } = createDb(responses);
  const billing = vi.fn().mockResolvedValue({ providerOutcome: 'deleted' });
  const billingQuiesce = vi.fn().mockResolvedValue(undefined);
  const calendar = vi.fn().mockResolvedValue({ status: 'completed' });
  const recoverBilling = vi.fn().mockResolvedValue({ status: 'completed' });
  const storage = vi.fn().mockResolvedValue(undefined);
  const posthogDeletion = vi.fn().mockResolvedValue(undefined);
  const coordinator = createAccountDeletionCoordinator({
    billing,
    billingQuiesce,
    calendar,
    db,
    posthogDeletion,
    recoverBilling,
    storage,
  });

  return {
    billing,
    billingQuiesce,
    calendar,
    coordinator,
    recoverBilling,
    rpc,
    storage,
    posthogDeletion,
  };
}

function activeResponses(options?: {
  billingBindingState?: 'preparing' | 'ready';
  calendarRequired?: boolean;
  stripeCustomerId?: string | null;
}) {
  return {
    begin_account_deletion_v1: [
      success([
        {
          billing_state: 'pending',
          calendar_state: 'pending',
          deletion_id: GENERIC_DELETION_ID,
          storage_state: 'pending',
        },
      ]),
    ],
    bind_billing_account_deletion_v1: [
      success([
        {
          binding_state: options?.billingBindingState ?? 'preparing',
          stripe_customer_id:
            options?.stripeCustomerId === undefined ? 'cus_bound' : options.stripeCustomerId,
        },
      ]),
    ],
    bind_calendar_account_deletion_v1: [
      success([
        {
          calendar_deletion_id: CALENDAR_DELETION_ID,
          calendar_required: options?.calendarRequired ?? true,
        },
      ]),
    ],
    claim_account_deletion_step_v1: [
      claimed(CALENDAR_LEASE_ID),
      claimed(STORAGE_LEASE_ID),
      claimed(BILLING_LEASE_ID),
    ],
    complete_account_deletion_step_v1: [success(true), success(true), success(true)],
    get_account_deletion_readiness_v1: [success([{ activated: true, active_operations: 0 }])],
    seal_account_deletion_v1: [success(true)],
    seal_billing_account_deletion_v1: [success(true)],
  };
}

describe('Account deletion coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('active gateではCalendar、Storage、Billingを順に完了してgeneric receiptをsealする', async () => {
    const { billing, billingQuiesce, calendar, coordinator, rpc, storage, posthogDeletion } =
      createRuntime(activeResponses());

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });

    expect(calendar).toHaveBeenCalledWith({
      deletionId: CALENDAR_DELETION_ID,
      userId: USER_ID,
    });
    expect(storage).toHaveBeenCalledWith({ userId: USER_ID });
    expect(posthogDeletion).toHaveBeenCalledWith({ userId: USER_ID });
    expect(billingQuiesce).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_bound',
      userId: USER_ID,
    });
    expect(billing).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_bound',
      userId: USER_ID,
    });
    expect(rpc).toHaveBeenCalledWith('seal_billing_account_deletion_v1', {
      p_generic_deletion_id: GENERIC_DELETION_ID,
      p_provider_outcome: 'deleted',
      p_user_id: USER_ID,
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_account_deletion_readiness_v1',
      'begin_account_deletion_v1',
      'bind_billing_account_deletion_v1',
      'claim_account_deletion_step_v1',
      'bind_calendar_account_deletion_v1',
      'complete_account_deletion_step_v1',
      'claim_account_deletion_step_v1',
      'complete_account_deletion_step_v1',
      'claim_account_deletion_step_v1',
      'seal_billing_account_deletion_v1',
      'complete_account_deletion_step_v1',
      'seal_account_deletion_v1',
    ]);
  });

  it('inactive gateではdurable closing fenceが無いためfail closedにする', async () => {
    const { billing, calendar, coordinator, rpc, storage } = createRuntime({
      get_account_deletion_readiness_v1: [success([{ activated: false, active_operations: 0 }])],
    });

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_COORDINATOR_GATE_INACTIVE_FAILED',
    });
    expect(calendar).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(billing).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('inactive gateにunfinished generic operationが残る場合はlegacyへ戻さない', async () => {
    const { coordinator } = createRuntime({
      get_account_deletion_readiness_v1: [success([{ activated: false, active_operations: 1 }])],
    });

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_COORDINATOR_INACTIVE_WITH_OPERATIONS_FAILED',
    });
  });

  it('Calendar inventoryが無いsnapshotではCalendar intentを新規作成しない', async () => {
    const { calendar, coordinator } = createRuntime(activeResponses({ calendarRequired: false }));

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });
    expect(calendar).not.toHaveBeenCalled();
  });

  it('bound Customerが無ければnot_present receiptを固定する', async () => {
    const { billing, coordinator, rpc } = createRuntime(
      activeResponses({ stripeCustomerId: null }),
    );
    billing.mockResolvedValue({ providerOutcome: 'not_present' });

    await coordinator.beforeIdentityDeletion({ userId: USER_ID });

    expect(billing).toHaveBeenCalledWith({ stripeCustomerId: null, userId: USER_ID });
    expect(rpc).toHaveBeenCalledWith(
      'seal_billing_account_deletion_v1',
      expect.objectContaining({ p_provider_outcome: 'not_present' }),
    );
  });

  it('Stripe identity照合に失敗したらCalendar、Storage、Billing receiptへ進まない', async () => {
    const { billing, billingQuiesce, calendar, coordinator, rpc, storage } =
      createRuntime(activeResponses());
    billingQuiesce.mockRejectedValue(new Error('Stripe identity mismatch'));

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).rejects.toThrow(
      'Stripe identity mismatch',
    );
    expect(calendar).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(billing).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('seal_billing_account_deletion_v1', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('seal_account_deletion_v1', expect.anything());
  });

  it('外部処理後にleaseが失効したら再claimしてterminal stateを再確認する', async () => {
    const { billingQuiesce, coordinator, storage } = createRuntime({
      begin_account_deletion_v1: [
        success([
          {
            billing_state: 'completed',
            calendar_state: 'completed',
            deletion_id: GENERIC_DELETION_ID,
            storage_state: 'in_progress',
          },
        ]),
      ],
      bind_billing_account_deletion_v1: [
        success([{ binding_state: 'ready', stripe_customer_id: 'cus_bound' }]),
      ],
      claim_account_deletion_step_v1: [
        completed(),
        claimed(STORAGE_LEASE_ID),
        claimed(SECOND_STORAGE_LEASE_ID),
        completed(),
      ],
      complete_account_deletion_step_v1: [failure('AD019'), success(true)],
      get_account_deletion_readiness_v1: [success([{ activated: true, active_operations: 1 }])],
      seal_account_deletion_v1: [success(true)],
    });

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
      status: 'completed',
    });
    expect(billingQuiesce).not.toHaveBeenCalled();
    expect(storage).toHaveBeenCalledTimes(2);
  });

  it('live billing mutationとのAD019競合をretryable resultへ変換する', async () => {
    const { coordinator, recoverBilling } = createRuntime({
      begin_account_deletion_v1: [failure('AD019'), failure('AD019')],
      get_account_deletion_readiness_v1: [success([{ activated: true, active_operations: 0 }])],
    });

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
      status: 'contention',
    });
    expect(recoverBilling).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('live Customer provisioningは回収せずretryable resultを返す', async () => {
    const { coordinator, recoverBilling } = createRuntime({
      begin_account_deletion_v1: [failure('AD019')],
      get_account_deletion_readiness_v1: [success([{ activated: true, active_operations: 0 }])],
    });
    recoverBilling.mockResolvedValue({ status: 'contention' });

    await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
      status: 'contention',
    });
  });

  it.each([
    { outcome: 'deleted', stripeCustomerId: 'cus_bound' },
    { outcome: 'not_present', stripeCustomerId: null },
  ] as const)(
    'ready Billing receiptはproviderを再実行せず$outcomeとしてsealする',
    async ({ outcome, stripeCustomerId }) => {
      const { billing, billingQuiesce, coordinator, rpc } = createRuntime(
        activeResponses({
          billingBindingState: 'ready',
          stripeCustomerId,
        }),
      );

      await expect(coordinator.beforeIdentityDeletion({ userId: USER_ID })).resolves.toEqual({
        status: 'completed',
      });
      expect(billingQuiesce).not.toHaveBeenCalled();
      expect(billing).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith(
        'seal_billing_account_deletion_v1',
        expect.objectContaining({ p_provider_outcome: outcome }),
      );
    },
  );
});

describe('Account deletion Storage adapter', () => {
  it('avatarsとattachmentsを再帰列挙し100件単位で削除後に空を確認する', async () => {
    const objects = new Map([
      [
        'avatars',
        new Set(
          Array.from(
            { length: 130 },
            (_, index) => `${USER_ID}/avatar-${String(index).padStart(3, '0')}.png`,
          ),
        ),
      ],
      [
        'attachments',
        new Set([`${USER_ID}/nested/receipt.pdf`, `${USER_ID}/nested/deep/report.csv`]),
      ],
    ]);
    const removedBatches: Array<{ bucket: string; paths: string[] }> = [];

    const from = vi.fn((bucket: string) => ({
      list: vi.fn(
        async (
          prefix: string,
          options: { limit: number; offset: number; sortBy: { column: string; order: string } },
        ) => {
          const children = new Map<
            string,
            { metadata: Record<string, unknown> | null; name: string }
          >();
          for (const path of objects.get(bucket) ?? []) {
            const prefixWithSlash = `${prefix}/`;
            if (!path.startsWith(prefixWithSlash)) continue;
            const remainder = path.slice(prefixWithSlash.length);
            const [name, ...rest] = remainder.split('/');
            if (!name) continue;
            children.set(name, { metadata: rest.length > 0 ? null : {}, name });
          }
          const page = [...children.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(options.offset, options.offset + options.limit);
          return { data: page, error: null };
        },
      ),
      remove: vi.fn(async (paths: string[]) => {
        removedBatches.push({ bucket, paths });
        for (const path of paths) objects.get(bucket)?.delete(path);
        return { data: [], error: null };
      }),
    }));

    await expect(
      deleteAccountStorage({ storage: { from } } as never, { userId: USER_ID }),
    ).resolves.toBeUndefined();

    expect(objects.get('avatars')).toHaveProperty('size', 0);
    expect(objects.get('attachments')).toHaveProperty('size', 0);
    expect(removedBatches.every(({ paths }) => paths.length <= 100)).toBe(true);
    expect(
      removedBatches.filter(({ bucket }) => bucket === 'avatars').map(({ paths }) => paths.length),
    ).toEqual([100, 30]);
    expect(
      removedBatches.some(({ paths }) => paths.includes(`${USER_ID}/nested/deep/report.csv`)),
    ).toBe(true);
  });

  it('Storage listのnull responseを空扱いせずfail closedにする', async () => {
    const from = vi.fn(() => ({
      list: vi.fn().mockResolvedValue({ data: null, error: null }),
      remove: vi.fn(),
    }));

    await expect(
      deleteAccountStorage({ storage: { from } } as never, { userId: USER_ID }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_COORDINATOR_STORAGE_INVENTORY_FAILED',
    });
  });
});
