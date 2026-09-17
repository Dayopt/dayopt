import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentTimeLine } from './useCurrentTimeLine';

describe('useCurrentTimeLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-09-14 00:30 UTC = 09:30 Asia/Tokyo
    vi.setSystemTime(new Date('2026-09-14T00:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('バッジの位置と時刻はユーザー timezone で計算する（線と同じ TZ）', () => {
    const { result } = renderHook(() =>
      useCurrentTimeLine({ hourHeight: 60, showCurrentTime: true, timezone: 'Asia/Tokyo' }),
    );

    expect(result.current.currentTime.getHours()).toBe(9);
    expect(result.current.currentTime.getMinutes()).toBe(30);
    expect(result.current.currentTimePosition).toBe(9.5 * 60);
  });

  it('timezone が変わればブラウザ TZ に関係なく位置が動く', () => {
    const { result } = renderHook(() =>
      useCurrentTimeLine({ hourHeight: 60, showCurrentTime: true, timezone: 'UTC' }),
    );

    expect(result.current.currentTime.getHours()).toBe(0);
    expect(result.current.currentTimePosition).toBe(0.5 * 60);
  });
});
