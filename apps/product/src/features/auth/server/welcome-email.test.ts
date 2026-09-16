import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendWelcomeEmail = vi.hoisted(() => vi.fn());
const getUserLocale = vi.hoisted(() => vi.fn(async () => 'ja'));
const getUserById = vi.hoisted(() => vi.fn());
const captureUnexpectedError = vi.hoisted(() => vi.fn());
const captureUnexpectedDatabaseError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
/** `.update().eq().is().select()` の戻りを差し替えるための箱 */
const claimResult = vi.hoisted(() => ({
  current: { data: [] as unknown[] | null, error: null as unknown },
}));
/** 実際に組み立てられた query を記録する（1 回保証はこの条件そのものなので固定する） */
const chain = vi.hoisted(
  () =>
    ({}) as {
      from?: string;
      update?: Record<string, unknown>;
      eq?: [string, unknown];
      is?: [string, unknown];
    },
);

vi.mock('@/lib/email/router', () => ({ sendWelcomeEmail, getUserLocale }));
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/sentry', () => ({ captureUnexpectedError, captureUnexpectedDatabaseError }));
vi.mock('@/lib/supabase/oauth', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      chain.from = table;
      return {
        update: (values: Record<string, unknown>) => {
          chain.update = values;
          return {
            eq: (column: string, value: unknown) => {
              chain.eq = [column, value];
              return {
                is: (column: string, value: unknown) => {
                  chain.is = [column, value];
                  return { select: async () => claimResult.current };
                },
              };
            },
          };
        },
      };
    },
    auth: { admin: { getUserById } },
  }),
}));

const { deliverWelcomeEmailOnce } = await import('./welcome-email');

describe('deliverWelcomeEmailOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimResult.current = { data: [], error: null };
    getUserById.mockResolvedValue({ data: { user: { email: 'a@example.test' } }, error: null });
  });

  it('初回は行を掴んで送る', async () => {
    claimResult.current = { data: [{ id: 'u1', full_name: 'Tomoya' }], error: null };

    await deliverWelcomeEmailOnce('u1');

    expect(sendWelcomeEmail).toHaveBeenCalledWith({
      email: 'a@example.test',
      userName: 'Tomoya',
      locale: 'ja',
    });
  });

  it('未送信の行だけを対象に、送る前にマークする', async () => {
    claimResult.current = { data: [{ id: 'u1', full_name: 'Tomoya' }], error: null };

    await deliverWelcomeEmailOnce('u1');

    expect(chain.from).toBe('profiles');
    expect(chain.eq).toEqual(['id', 'u1']);
    // ここが 1 通に固定している条件。外すと同じ人へ何度でも飛ぶ
    expect(chain.is).toEqual(['welcome_email_sent_at', null]);
    expect(chain.update?.welcome_email_sent_at).toEqual(expect.any(String));
  });

  it('掴めなければ送らない（2 通目を出さないことがこの関数の存在理由）', async () => {
    claimResult.current = { data: [], error: null };

    await deliverWelcomeEmailOnce('u1');

    expect(sendWelcomeEmail).not.toHaveBeenCalled();
    expect(captureUnexpectedError).not.toHaveBeenCalled();
  });

  it('掴めても宛先が引けなければ送らない', async () => {
    claimResult.current = { data: [{ id: 'u1', full_name: 'Tomoya' }], error: null };
    getUserById.mockResolvedValue({ data: { user: null }, error: null });

    await deliverWelcomeEmailOnce('u1');

    expect(sendWelcomeEmail).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('claim が失敗したら送らず Sentry へ残す', async () => {
    claimResult.current = { data: null, error: { message: 'boom' } };

    await deliverWelcomeEmailOnce('u1');

    expect(sendWelcomeEmail).not.toHaveBeenCalled();
    expect(captureUnexpectedDatabaseError).toHaveBeenCalled();
  });

  it('送信が落ちても throw しない（サインインを妨げない）', async () => {
    claimResult.current = { data: [{ id: 'u1', full_name: null }], error: null };
    sendWelcomeEmail.mockRejectedValue(new Error('resend down'));

    await expect(deliverWelcomeEmailOnce('u1')).resolves.toBeUndefined();
    expect(captureUnexpectedError).toHaveBeenCalled();
  });

  it('表示名が無ければ既定の呼びかけにする', async () => {
    claimResult.current = { data: [{ id: 'u1', full_name: null }], error: null };

    await deliverWelcomeEmailOnce('u1');

    expect(sendWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ userName: 'there' }));
  });
});
