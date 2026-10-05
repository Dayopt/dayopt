import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTimeblockRecordMutations } from './useTimeblockRecordMutations';
import { useTimeblockWriteMutations } from './useTimeblockWriteMutations';

const mocks = vi.hoisted(() => ({
  commands: {} as Record<string, (input: unknown) => Promise<unknown>>,
  client: undefined as QueryClient | undefined,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  const commands = (lane: string) =>
    Object.fromEntries(
      ['create', 'update', 'delete', 'restore', 'record', 'confirmDay'].map((name) => [
        name,
        {
          useMutation: (options: Record<string, unknown>) =>
            useMutation({
              ...options,
              mutationFn: (input: unknown) => mocks.commands[`${lane}.${name}`]!(input),
            }),
        },
      ]),
    );
  const utils = (lane: string) => ({
    invalidate: () => mocks.client?.invalidateQueries({ queryKey: [[lane]] }),
    list: { invalidate: () => mocks.client?.invalidateQueries({ queryKey: [[lane, 'list']] }) },
    getById: {
      setData: ({ id }: { id: string }, value: unknown) =>
        mocks.client?.setQueryData([[lane, 'getById'], { type: 'query', input: { id } }], value),
    },
  });
  return {
    api: {
      useUtils: () => ({ plans: utils('plans'), records: utils('records') }),
      planCommands: commands('plans'),
      recordCommands: commands('records'),
    },
  };
});

const plansKey = [['plans', 'list'], { type: 'query' }] as const;
const recordsKey = [['records', 'list'], { type: 'query' }] as const;
function row(id: string) {
  return {
    id,
    title: id,
    note: null,
    activity_id: null,
    start_at: '2026-09-01T09:00:00.000Z',
    end_at: '2026-09-01T10:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000001Z',
    deleted_at: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.commands = {};
  mocks.client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
});
afterEach(() => mocks.client?.clear());
function setup() {
  const queryClient = mocks.client!;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    queryClient,
    ...renderHook(() => ({ ...useTimeblockWriteMutations(), ...useTimeblockRecordMutations() }), {
      wrapper,
    }),
  };
}
const creation = { title: 'pending', start_at: row('a').start_at, end_at: row('a').end_at };

describe('timeblock real mutation lifecycle', () => {
  it.each(['plans', 'records'] as const)(
    'keeps completed %s creation when an earlier Plan fails',
    async (lane) => {
      const first = deferred<ReturnType<typeof row>>();
      const second = deferred<ReturnType<typeof row>>();
      mocks.commands['plans.create'] = () => first.promise;
      mocks.commands[`${lane}.create`] = (input) =>
        (input as { title: string }).title === 'first' ? first.promise : second.promise;
      const { queryClient, result } = setup();
      queryClient.setQueryData(plansKey, []);
      queryClient.setQueryData(recordsKey, []);
      const a = result.current.createPlan
        .mutateAsync({ ...creation, title: 'first' })
        .catch((error: unknown) => error);
      await waitFor(() => expect(queryClient.getQueryData<unknown[]>(plansKey)).toHaveLength(1));
      const b = (
        lane === 'plans' ? result.current.createPlan : result.current.createRecord
      ).mutateAsync({ ...creation, title: 'second' });
      const key = lane === 'plans' ? plansKey : recordsKey;
      await waitFor(() =>
        expect(queryClient.getQueryData<unknown[]>(key)).toHaveLength(lane === 'plans' ? 2 : 1),
      );
      await act(async () => {
        second.resolve(row('b'));
        await b;
      });
      await act(async () => {
        first.reject(new Error('failed'));
        await a;
      });
      expect(queryClient.getQueryData(key)).toEqual([row('b')]);
      expect(
        queryClient
          .getQueryData<ReturnType<typeof row>[]>(plansKey)
          ?.some((item) => item.id.startsWith('temp-')),
      ).toBe(false);
    },
  );

  it('keeps a committed deletion while rolling back another deletion', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.commands['plans.delete'] = (input) =>
      (input as { id: string }).id === 'a' ? first.promise : second.promise;
    const { queryClient, result } = setup();
    queryClient.setQueryData(plansKey, [row('a'), row('b')]);
    const a = result.current.deletePlan
      .mutateAsync({ id: 'a', expectedUpdatedAt: row('a').updated_at })
      .catch((error: unknown) => error);
    await waitFor(() => expect(queryClient.getQueryData(plansKey)).toEqual([row('b')]));
    const b = result.current.deletePlan.mutateAsync({
      id: 'b',
      expectedUpdatedAt: row('b').updated_at,
    });
    await waitFor(() => expect(queryClient.getQueryData(plansKey)).toEqual([]));
    await act(async () => {
      second.resolve({});
      await b;
    });
    await act(async () => {
      first.reject(new Error('failed'));
      await a;
    });
    expect(queryClient.getQueryData(plansKey)).toEqual([row('a')]);
  });

  it.each(['both fail', 'same value succeeds'] as const)(
    'rebases same-row updates: %s',
    async (outcome) => {
      const first = deferred<ReturnType<typeof row>>();
      const second = deferred<ReturnType<typeof row>>();
      let calls = 0;
      mocks.commands['plans.update'] = () => (++calls === 1 ? first.promise : second.promise);
      const { queryClient, result } = setup();
      queryClient.setQueryData(plansKey, [row('a')]);
      const a = result.current.updatePlan
        .mutateAsync({
          id: 'a',
          expectedUpdatedAt: row('a').updated_at,
          data: { title: 'changed' },
        })
        .catch((error: unknown) => error);
      await waitFor(() =>
        expect(queryClient.getQueryData<ReturnType<typeof row>[]>(plansKey)?.[0]?.title).toBe(
          'changed',
        ),
      );
      const b = result.current.updatePlan
        .mutateAsync({
          id: 'a',
          expectedUpdatedAt: row('a').updated_at,
          data: outcome === 'both fail' ? { note: 'pending note' } : { title: 'changed' },
        })
        .catch((error: unknown) => error);
      await waitFor(() => expect(calls).toBe(2));
      await act(async () => {
        first.reject(new Error('failed a'));
        await a;
      });
      expect(queryClient.getQueryData<ReturnType<typeof row>[]>(plansKey)?.[0]).toEqual(
        outcome === 'both fail'
          ? { ...row('a'), note: 'pending note' }
          : { ...row('a'), title: 'changed' },
      );
      const committed = {
        ...row('a'),
        title: 'changed',
        updated_at: '2026-09-01T00:00:00.000002Z',
      };
      await act(async () => {
        if (outcome === 'both fail') second.reject(new Error('failed b'));
        else second.resolve(committed);
        await b;
      });
      expect(queryClient.getQueryData(plansKey)).toEqual([
        outcome === 'both fail' ? row('a') : committed,
      ]);
    },
  );

  it.each(['success', 'error'] as const)(
    'ignores an old %s callback after clearing an initially empty cache',
    async (outcome) => {
      const response = deferred<ReturnType<typeof row>>();
      mocks.commands['plans.create'] = () => response.promise;
      const { queryClient, result } = setup();
      const request = result.current.createPlan
        .mutateAsync(creation)
        .catch((error: unknown) => error);
      await waitFor(() =>
        expect(queryClient.getMutationCache().getAll()[0]?.state.context).toBeDefined(),
      );
      queryClient.clear();
      queryClient.setQueryData(plansKey, []);
      await act(async () => {
        if (outcome === 'success') response.resolve(row('old-user'));
        else response.reject(new Error('failed'));
        await request;
      });
      expect(queryClient.getQueryData(plansKey)).toEqual([]);
      expect(queryClient.getQueriesData({ queryKey: [['plans', 'getById']] })).toEqual([]);
    },
  );
  it('does not attach a waiting onMutate to a replacement cache', async () => {
    const cancellation = deferred<void>();
    const response = deferred<ReturnType<typeof row>>();
    const command = vi.fn(() => response.promise);
    mocks.commands['plans.create'] = command;
    const { queryClient, result } = setup();
    const cancel = vi
      .spyOn(queryClient, 'cancelQueries')
      .mockImplementation(() => cancellation.promise);
    const request = result.current.createPlan
      .mutateAsync(creation)
      .catch((error: unknown) => error);
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    queryClient.clear();
    queryClient.setQueryData(plansKey, []);
    await act(async () => {
      cancellation.resolve();
      response.resolve(row('old-user'));
      await request;
    });
    expect(command).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(plansKey)).toEqual([]);
    expect(queryClient.getQueriesData({ queryKey: [['plans', 'getById']] })).toEqual([]);
  });
  it.each(['record', 'confirmDay'] as const)(
    'does not rewind a committed Record when %s fails',
    async (command) => {
      const first = deferred<unknown>();
      const second = deferred<ReturnType<typeof row>>();
      mocks.commands[`plans.${command}`] = () => first.promise;
      mocks.commands['records.create'] = () => second.promise;
      const { queryClient, result } = setup();
      queryClient.setQueryData(recordsKey, []);
      const a = (
        command === 'record'
          ? result.current.recordPlan.mutateAsync({
              id: 'plan-a',
              expectedUpdatedAt: row('a').updated_at,
            })
          : result.current.confirmDay.mutateAsync({
              start_at: creation.start_at,
              end_at: creation.end_at,
            })
      ).catch((error: unknown) => error);
      await waitFor(() =>
        expect(
          queryClient
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.context !== undefined),
        ).toBe(true),
      );
      const b = result.current.createRecord.mutateAsync(creation);
      await waitFor(() => expect(queryClient.getQueryData<unknown[]>(recordsKey)).toHaveLength(1));
      await act(async () => {
        second.resolve(row('b'));
        await b;
      });
      await act(async () => {
        first.reject(new Error('failed'));
        await a;
      });
      expect(queryClient.getQueryData(recordsKey)).toEqual([row('b')]);
    },
  );

  it('rebases a pending activity move onto the original row when an earlier title edit fails', async () => {
    const first = deferred<ReturnType<typeof row>>();
    const second = deferred<ReturnType<typeof row>>();
    let calls = 0;
    mocks.commands['plans.update'] = () => (++calls === 1 ? first.promise : second.promise);
    const { queryClient, result } = setup();
    const destination = [
      ['plans', 'list'],
      { type: 'query', input: { activityId: 'activity-b' } },
    ] as const;
    queryClient.setQueryData(plansKey, [row('a')]);
    queryClient.setQueryData(destination, []);
    const a = result.current.updatePlan
      .mutateAsync({
        id: 'a',
        expectedUpdatedAt: row('a').updated_at,
        data: { title: 'failed title' },
      })
      .catch((error: unknown) => error);
    await waitFor(() =>
      expect(queryClient.getQueryData<ReturnType<typeof row>[]>(plansKey)?.[0]?.title).toBe(
        'failed title',
      ),
    );
    const b = result.current.updatePlan
      .mutateAsync({
        id: 'a',
        expectedUpdatedAt: row('a').updated_at,
        data: { activityId: 'activity-b', note: 'pending note' },
      })
      .catch((error: unknown) => error);
    await waitFor(() => expect(queryClient.getQueryData<unknown[]>(destination)).toHaveLength(1));
    await act(async () => {
      first.reject(new Error('failed a'));
      await a;
    });
    const rebased = { ...row('a'), activity_id: 'activity-b', note: 'pending note' };
    expect(queryClient.getQueryData(plansKey)).toEqual([rebased]);
    expect(queryClient.getQueryData(destination)).toEqual([rebased]);
    await act(async () => {
      second.reject(new Error('failed b'));
      await b;
    });
    expect(queryClient.getQueryData(plansKey)).toEqual([row('a')]);
    expect(queryClient.getQueryData(destination)).toEqual([]);
  });
  it('preserves an already committed same-value update and its raw version when the earlier edit fails', async () => {
    const first = deferred<ReturnType<typeof row>>();
    const second = deferred<ReturnType<typeof row>>();
    let calls = 0;
    mocks.commands['plans.update'] = () => (++calls === 1 ? first.promise : second.promise);
    const { queryClient, result } = setup();
    queryClient.setQueryData(plansKey, [row('a')]);
    const input = { id: 'a', expectedUpdatedAt: row('a').updated_at, data: { title: 'changed' } };
    const a = result.current.updatePlan.mutateAsync(input).catch((error: unknown) => error);
    await waitFor(() =>
      expect(queryClient.getQueryData<ReturnType<typeof row>[]>(plansKey)?.[0]?.title).toBe(
        'changed',
      ),
    );
    const b = result.current.updatePlan.mutateAsync(input);
    await waitFor(() => expect(calls).toBe(2));
    const committed = { ...row('a'), title: 'changed', updated_at: '2026-09-01T00:00:00.000002Z' };
    await act(async () => {
      second.resolve(committed);
      await b;
    });
    await act(async () => {
      first.reject(new Error('failed'));
      await a;
    });
    expect(queryClient.getQueryData(plansKey)).toEqual([committed]);
  });
  it('keeps the server row instead of its temporary predecessor when replaying a limited list', async () => {
    const first = deferred<ReturnType<typeof row>>();
    const second = deferred<ReturnType<typeof row>>();
    mocks.commands['records.create'] = () => first.promise;
    mocks.commands['plans.create'] = () => second.promise;
    const { queryClient, result } = setup();
    const limitedKey = [['plans', 'list'], { type: 'query', input: { limit: 1 } }] as const;
    queryClient.setQueryData(limitedKey, [row('old')]);
    queryClient.setQueryData(recordsKey, []);
    const a = result.current.createRecord.mutateAsync(creation).catch((error: unknown) => error);
    await waitFor(() => expect(queryClient.getQueryData<unknown[]>(recordsKey)).toHaveLength(1));
    const b = result.current.createPlan.mutateAsync({
      ...creation,
      start_at: '2026-09-01T08:00:00.000Z',
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ReturnType<typeof row>[]>(limitedKey)?.[0]?.id.startsWith('temp-'),
      ).toBe(true),
    );
    const committed = { ...row('b'), start_at: '2026-09-01T08:00:00.000Z' };
    await act(async () => {
      second.resolve(committed);
      await b;
    });
    expect(queryClient.getQueryData(limitedKey)).toEqual([committed]);
    await act(async () => {
      first.reject(new Error('failed'));
      await a;
    });
    expect(queryClient.getQueryData(limitedKey)).toEqual([committed]);
  });
});
