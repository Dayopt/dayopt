import { QueryClient, dehydrate } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefetchAppShell } from './prefetch-app-shell';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  settings: vi.fn(),
  access: vi.fn(),
  activities: vi.fn(),
  categories: vi.fn(),
}));
vi.mock('@/lib/trpc/server', () => ({ createServerHelpers: mocks.create, dehydrate }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

describe('prefetchAppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activities.mockResolvedValue([{ id: 'activity', name: 'Focus' }]);
    mocks.categories.mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.create.mockResolvedValue({
      queryClient,
      activities: {
        listActivities: {
          prefetch: (input: { includeArchived: boolean }) =>
            queryClient.prefetchQuery({
              queryKey: [['activities', 'listActivities'], { input, type: 'query' }],
              queryFn: () => mocks.activities(input),
            }),
        },
        listCategories: {
          prefetch: (input: { includeArchived: boolean }) =>
            queryClient.prefetchQuery({
              queryKey: [['activities', 'listCategories'], { input, type: 'query' }],
              queryFn: () => mocks.categories(input),
            }),
        },
      },
      userSettings: {
        get: {
          prefetch: () =>
            queryClient.prefetchQuery({
              queryKey: [['userSettings', 'get']],
              queryFn: mocks.settings,
            }),
        },
      },
      billing: {
        getAccess: {
          prefetch: () =>
            queryClient.prefetchQuery({
              queryKey: [['billing', 'getAccess']],
              queryFn: mocks.access,
            }),
        },
      },
    });
  });
  it('starts both queries before either resolves and dehydrates their data', async () => {
    let resolveSettings!: (value: { timezone: string }) => void;
    mocks.settings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    mocks.access.mockResolvedValue({ state: 'active' });
    const pending = prefetchAppShell();
    await vi.waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(1));
    expect(mocks.settings).toHaveBeenCalledTimes(1);
    expect(mocks.activities).toHaveBeenCalledWith({ includeArchived: true });
    expect(mocks.categories).toHaveBeenCalledWith({ includeArchived: true });
    resolveSettings({ timezone: 'Asia/Tokyo' });
    const state = await pending;
    expect(state?.queries.map((query) => query.state.data)).toEqual([
      { timezone: 'Asia/Tokyo' },
      { state: 'active' },
      [{ id: 'activity', name: 'Focus' }],
      [],
    ]);
  });
  it('omits a failed query so its existing client gate can recover', async () => {
    mocks.settings.mockRejectedValue(new Error('unavailable'));
    mocks.access.mockResolvedValue({ state: 'active' });
    const state = await prefetchAppShell();
    expect(state?.queries).toHaveLength(3);
    expect(state?.queries[0]?.queryKey).toEqual([['billing', 'getAccess']]);
  });
  it('keeps the browser defaults gate for a missing settings row', async () => {
    mocks.settings.mockResolvedValue(null);
    mocks.access.mockResolvedValue({ state: 'active' });
    const state = await prefetchAppShell();
    expect(state?.queries).toHaveLength(3);
    expect(state?.queries[0]?.queryKey).toEqual([['billing', 'getAccess']]);
  });
  it('returns no hydration when request context is unavailable', async () => {
    mocks.create.mockRejectedValue(new Error('context unavailable'));
    expect(await prefetchAppShell()).toBeUndefined();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});
