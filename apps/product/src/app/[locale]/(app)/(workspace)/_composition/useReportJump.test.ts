import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());

vi.mock('@dayopt/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/features/timeblock', () => ({
  TIMEBLOCK_PARAM: 'timeblock',
  serializeTimeblockParam: (id: string, kind: string) => `${kind}:${id}`,
}));

import { useReportJump } from './useReportJump';

function renderJump() {
  return renderHook(() => useReportJump()).result;
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
});
