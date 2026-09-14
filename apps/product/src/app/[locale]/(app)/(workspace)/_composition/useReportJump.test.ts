import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());

vi.mock('@dayopt/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/features/timeblock', () => ({
  TIMEBLOCK_PARAM: 'timeblock',
  serializeTimeblockParam: (id: string, kind: string) => `${kind}:${id}`,
}));

import { useReportJump } from './useReportJump';

function renderJump(granularity: 'week' | 'month' | 'year' = 'week') {
  return renderHook(() => useReportJump({ anchorDate: '2026-09-04', granularity, weekStartsOn: 1 }))
    .result;
}

describe('useReportJump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('記録はその日の日ビューを URL の timeblock 付きで開く（記録として開く）', () => {
    renderJump().current.onJumpToRecord({ id: 'rec-1', dayKey: '2026-09-01' });

    // 予定ではなく記録として開く（kind を落とすと既定の 'plan' で開き、中身が出ない）
    expect(push).toHaveBeenCalledWith(
      '/calendar?view=day&date=2026-09-01&timeblock=record%3Arec-1',
    );
  });

  it('未変換の外部予定はその日を日ビューで開くだけ', () => {
    renderJump().current.onJumpToDay('2026-09-08');

    expect(push).toHaveBeenCalledWith('/calendar?view=day&date=2026-09-08');
  });

  it('次期間は初日を週ビューで開く', () => {
    renderJump().current.onJumpToNextPeriod();

    expect(push).toHaveBeenCalledWith('/calendar?view=week&date=2026-09-07');
  });

  it('月粒度なら翌月 1 日、年粒度なら翌年 1 月 1 日を開く', () => {
    renderJump('month').current.onJumpToNextPeriod();
    expect(push).toHaveBeenLastCalledWith('/calendar?view=week&date=2026-10-01');

    renderJump('year').current.onJumpToNextPeriod();
    expect(push).toHaveBeenLastCalledWith('/calendar?view=week&date=2027-01-01');
  });
});
