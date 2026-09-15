import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const createServiceRoleClient = vi.hoisted(() => vi.fn(() => ({ rpc })));
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
// authority-config.ts の GOOGLE_OAUTH_CLIENT_ID_PATTERN を満たす組み合わせ。
// project key を解決できない環境を試すテストは個別に undefined へ落とす。
const TEST_PROJECT_NUMBER = vi.hoisted(() => '123456789012');
const envMock = vi.hoisted(
  () =>
    ({
      GOOGLE_CALENDAR_CLIENT_ID: `${TEST_PROJECT_NUMBER}-abc123.apps.googleusercontent.com`,
      GOOGLE_CALENDAR_PROJECT_NUMBER: TEST_PROJECT_NUMBER,
    }) as {
      GOOGLE_CALENDAR_CLIENT_ID?: string | undefined;
      GOOGLE_CALENDAR_PROJECT_NUMBER?: string | undefined;
    },
);

vi.mock('@/env', () => ({ env: envMock }));
vi.mock('@/lib/supabase/oauth', () => ({ createServiceRoleClient }));
vi.mock('@/lib/logger', () => ({
  logger: { log: vi.fn(), error: vi.fn(), warn: loggerWarn, info: loggerInfo, debug: vi.fn() },
}));

import {
  dispatchCalendarAccountDeletionSettle,
  SETTLE_WORST_CASE_MS,
} from './_composition/settle-dispatcher';

const FAR_DEADLINE = 10 ** 15;

function mockLifecycleAndStatus(): void {
  rpc.mockImplementation((operation: string) => {
    if (operation === 'get_external_lifecycle_app_version_v2') {
      return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
    }
    return { abortSignal: vi.fn(async () => ({ data: [], error: null })) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.GOOGLE_CALENDAR_CLIENT_ID = `${TEST_PROJECT_NUMBER}-abc123.apps.googleusercontent.com`;
  envMock.GOOGLE_CALENDAR_PROJECT_NUMBER = TEST_PROJECT_NUMBER;
  mockLifecycleAndStatus();
});

describe('dispatchCalendarAccountDeletionSettle', () => {
  it('旧DBでは処理をskipしたと報告する', async () => {
    rpc.mockReturnValue({
      abortSignal: vi.fn(async () => ({ data: null, error: { code: 'PGRST202' } })),
    });

    await expect(
      dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE }),
    ).resolves.toMatchObject({ normalized: 0, inFlight: 0, other: 0, skipped: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('project key を解決できない環境では skip して 0 件を返す', async () => {
    envMock.GOOGLE_CALENDAR_PROJECT_NUMBER = undefined;

    const summary = await dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE });

    expect(summary).toMatchObject({ normalized: 0, inFlight: 0, other: 0, skipped: true });
    expect(rpc).not.toHaveBeenCalledWith(
      'list_expired_calendar_account_deletion_intents_v1',
      expect.anything(),
    );
  });

  it('候補ごとに1トランザクションで順次処理し、戻り値ごとに件数を分ける。1件の失敗は他候補の処理を止めない', async () => {
    const candidates = [
      { user_id: 'user-1', deletion_id: 'del-1' },
      { user_id: 'user-2', deletion_id: 'del-2' },
      { user_id: 'user-3', deletion_id: 'del-3' },
    ];
    const normalizeCalls: Array<Record<string, unknown> | undefined> = [];
    rpc.mockImplementation((operation: string, args?: Record<string, unknown>) => {
      if (operation === 'get_external_lifecycle_app_version_v2') {
        return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
      }
      if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
        return { abortSignal: vi.fn(async () => ({ data: candidates, error: null })) };
      }
      if (operation === 'normalize_calendar_account_deletion_intent_v1') {
        normalizeCalls.push(args);
        const index = normalizeCalls.length;
        if (index === 1) {
          return { abortSignal: vi.fn(async () => ({ data: 'normalized', error: null })) };
        }
        if (index === 2) {
          return { abortSignal: vi.fn(async () => Promise.reject(new Error('boom'))) };
        }
        return { abortSignal: vi.fn(async () => ({ data: 'in_flight', error: null })) };
      }
      return { abortSignal: vi.fn(async () => ({ data: null, error: null })) };
    });

    // 候補2件目が例外を投げるため dispatch 全体は最終的に reject するが、候補3件目まで
    // 処理が続いていることを normalizeCalls の件数で確認する（1件の失敗が他候補を止めない）。
    await expect(
      dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE }),
    ).rejects.toMatchObject({ name: 'CalendarAccountDeletionSettleError' });

    expect(normalizeCalls).toHaveLength(3);
    expect(normalizeCalls[0]).toMatchObject({ p_user_id: 'user-1', p_deletion_id: 'del-1' });
    expect(normalizeCalls[2]).toMatchObject({ p_user_id: 'user-3', p_deletion_id: 'del-3' });
  });

  it('deadline を割ったら残り候補を打ち切り、次回 run へ繰り越す', async () => {
    const candidates = [
      { user_id: 'user-1', deletion_id: 'del-1' },
      { user_id: 'user-2', deletion_id: 'del-2' },
    ];
    const normalizeCalls: Array<Record<string, unknown> | undefined> = [];
    const almostNow = Date.now() + 1;
    rpc.mockImplementation((operation: string, args?: Record<string, unknown>) => {
      if (operation === 'get_external_lifecycle_app_version_v2') {
        return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
      }
      if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
        return { abortSignal: vi.fn(async () => ({ data: candidates, error: null })) };
      }
      if (operation === 'normalize_calendar_account_deletion_intent_v1') {
        normalizeCalls.push(args);
        return { abortSignal: vi.fn(async () => ({ data: 'normalized', error: null })) };
      }
      return { abortSignal: vi.fn(async () => ({ data: null, error: null })) };
    });

    const summary = await dispatchCalendarAccountDeletionSettle({ deadlineAt: almostNow });

    // deadline がほぼ現在時刻なので、1件目の候補評価時点で既に予算を割っており
    // normalize は 1 回も呼ばれない（0 件処理、次回 run へ全件繰り越し）。
    expect(normalizeCalls).toHaveLength(0);
    expect(summary.normalized).toBe(0);
  });

  it('Calendar authority project が未 activation（CA010）なら失敗にせず 0 件の完了を返す', async () => {
    rpc.mockImplementation((operation: string) => {
      if (operation === 'get_external_lifecycle_app_version_v2') {
        return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
      }
      if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
        return {
          abortSignal: vi.fn(async () => ({
            data: null,
            error: { code: 'CA010', message: 'Calendar authority project is not active' },
          })),
        };
      }
      return { abortSignal: vi.fn(async () => ({ data: 'normalized', error: null })) };
    });

    const summary = await dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE });

    expect(summary).toMatchObject({ normalized: 0, inFlight: 0, other: 0, skipped: false });
    expect(rpc).toHaveBeenCalledWith(
      'list_expired_calendar_account_deletion_intents_v1',
      expect.anything(),
    );
    expect(rpc).not.toHaveBeenCalledWith(
      'normalize_calendar_account_deletion_intent_v1',
      expect.anything(),
    );
  });

  it('候補が0件ならnormalizeを呼ばず0件のまま完了する', async () => {
    const summary = await dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE });

    expect(summary).toMatchObject({ normalized: 0, inFlight: 0, other: 0, skipped: false });
  });

  it('ログと返却値はaggregateだけでuser IDを含まない', async () => {
    const candidates = [{ user_id: 'user-1', deletion_id: 'del-1' }];
    rpc.mockImplementation((operation: string) => {
      if (operation === 'get_external_lifecycle_app_version_v2') {
        return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
      }
      if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
        return { abortSignal: vi.fn(async () => ({ data: candidates, error: null })) };
      }
      if (operation === 'normalize_calendar_account_deletion_intent_v1') {
        return { abortSignal: vi.fn(async () => ({ data: 'normalized', error: null })) };
      }
      return { abortSignal: vi.fn(async () => ({ data: null, error: null })) };
    });

    const summary = await dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE });

    const serialized = JSON.stringify({ summary, log: loggerInfo.mock.calls });
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('del-1');
  });

  // route.ts の TIME_BUDGET_MS(50s) / maxDuration(60s) の予算不等式は
  // route.test.ts が SETTLE_WORST_CASE_MS を写して固定する。ここでは値自体の
  // 妥当性（現実的な RPC timeout で構成されていること）だけ確認する。
  it('SETTLE_WORST_CASE_MS は list 1 本 + normalize 最大件数分から導出される', () => {
    expect(SETTLE_WORST_CASE_MS).toBeGreaterThan(0);
    expect(SETTLE_WORST_CASE_MS).toBeLessThan(50_000);
  });

  // DAYOPT-V（#2305）: 原因の code/message が CalendarAccountDeletionSettleError へ載ることを
  // stage ごとに固定する。route.ts はこれを errorCode/errorMessage として Sentry へ伝搬する。
  describe('CalendarAccountDeletionSettleError への cause 伝搬', () => {
    it('list RPC の error は code/message を cause として持つ', async () => {
      rpc.mockImplementation((operation: string) => {
        if (operation === 'get_external_lifecycle_app_version_v2') {
          return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
        }
        if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
          return {
            abortSignal: vi.fn(async () => ({
              data: null,
              error: { code: '57014', message: 'canceling statement due to statement timeout' },
            })),
          };
        }
        return { abortSignal: vi.fn(async () => ({ data: [], error: null })) };
      });

      await expect(
        dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE }),
      ).rejects.toMatchObject({
        name: 'CalendarAccountDeletionSettleError',
        code: 'ACCOUNT_DELETION_SETTLE_LIST_FAILED',
        causeCode: '57014',
        causeMessage: 'canceling statement due to statement timeout',
      });
    });

    it('normalize RPC の error は code/message を cause として持つ', async () => {
      const candidates = [{ user_id: 'user-1', deletion_id: 'del-1' }];
      rpc.mockImplementation((operation: string) => {
        if (operation === 'get_external_lifecycle_app_version_v2') {
          return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
        }
        if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
          return { abortSignal: vi.fn(async () => ({ data: candidates, error: null })) };
        }
        if (operation === 'normalize_calendar_account_deletion_intent_v1') {
          return {
            abortSignal: vi.fn(async () => ({
              data: null,
              error: {
                code: '55P03',
                message: 'could not obtain lock on row in relation "timeblock_supported_writer_v1"',
              },
            })),
          };
        }
        return { abortSignal: vi.fn(async () => ({ data: null, error: null })) };
      });

      await expect(
        dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE }),
      ).rejects.toMatchObject({
        name: 'CalendarAccountDeletionSettleError',
        code: 'ACCOUNT_DELETION_SETTLE_NORMALIZE_FAILED',
        causeCode: '55P03',
      });
    });

    it('未分類の例外（abortSignal タイムアウト等）は message だけを cause として引き継ぐ', async () => {
      const candidates = [{ user_id: 'user-1', deletion_id: 'del-1' }];
      rpc.mockImplementation((operation: string) => {
        if (operation === 'get_external_lifecycle_app_version_v2') {
          return { abortSignal: vi.fn(async () => ({ data: 1, error: null })) };
        }
        if (operation === 'list_expired_calendar_account_deletion_intents_v1') {
          return { abortSignal: vi.fn(async () => ({ data: candidates, error: null })) };
        }
        if (operation === 'normalize_calendar_account_deletion_intent_v1') {
          return {
            abortSignal: vi.fn(async () => Promise.reject(new Error('The operation was aborted'))),
          };
        }
        return { abortSignal: vi.fn(async () => ({ data: null, error: null })) };
      });

      await expect(
        dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE }),
      ).rejects.toMatchObject({
        name: 'CalendarAccountDeletionSettleError',
        code: 'ACCOUNT_DELETION_SETTLE_NORMALIZE_FAILED',
        causeCode: undefined,
        causeMessage: 'The operation was aborted',
      });
    });
  });
});

it.each([
  'list_expired_calendar_account_deletion_intents_v1',
  'normalize_calendar_account_deletion_intent_v1',
])('必要RPC %s が欠ければ完了として扱わない', async (missing) => {
  rpc.mockImplementation((operation: string) => ({
    abortSignal: vi.fn(async () => {
      if (operation === missing) return { data: null, error: { code: 'PGRST202' } };
      if (operation === 'get_external_lifecycle_app_version_v2') return { data: 1, error: null };
      if (operation === 'list_expired_calendar_account_deletion_intents_v1')
        return { data: [{ user_id: 'user-1', deletion_id: 'del-1' }], error: null };
      return { data: 'normalized', error: null };
    }),
  }));
  const result = await dispatchCalendarAccountDeletionSettle({ deadlineAt: FAR_DEADLINE });
  expect(rpc).toHaveBeenCalledWith(missing, expect.anything());
  expect(result).toMatchObject({ skipped: true, normalized: 0 });
});
