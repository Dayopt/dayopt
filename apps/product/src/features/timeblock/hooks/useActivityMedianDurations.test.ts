import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActivityMedianDurations } from './useActivityMedianDurations';

const query = vi.hoisted(() => ({
  data: undefined as undefined | { medianMinutes: Record<string, number> },
  isPending: true,
}));
const fetchStats = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trpc', () => ({
  api: {
    statistics: { getActivityStats: { useQuery: () => query } },
    useUtils: () => ({ statistics: { getActivityStats: { fetch: fetchStats } } }),
  },
}));

describe('useActivityMedianDurations', () => {
  beforeEach(() => {
    query.data = undefined;
    query.isPending = true;
    fetchStats.mockReset();
  });

  it('表示は待たず、即時作成の解決だけが統計取得を待つ', async () => {
    let release!: (value: { medianMinutes: Record<string, number> }) => void;
    fetchStats.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => useActivityMedianDurations());
    expect(result.current.isPending).toBe(true);
    expect(result.current.getMedianMinutes('activity-1')).toBeNull();
    expect(fetchStats).not.toHaveBeenCalled();
    const duration = result.current.resolveMedianMinutes('activity-1');
    release({ medianMinutes: { 'activity-1': 45 } });
    await expect(duration).resolves.toBe(45);
    expect(fetchStats).toHaveBeenCalledTimes(1);
  });

  it('統計取得失敗は既定長へフォールバックできる値を返す', async () => {
    fetchStats.mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(() => useActivityMedianDurations());
    await expect(result.current.resolveMedianMinutes('activity-1')).resolves.toBeNull();
  });
});
