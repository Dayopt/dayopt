import { useActivityDetailStore } from '@/lib/stores/useActivityDetailStore';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());

vi.mock('@dayopt/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/features/timeblock', () => ({
  TIMEBLOCK_PARAM: 'timeblock',
  serializeTimeblockParam: (id: string, kind: string) => `${kind}:${id}`,
}));

import { useActivityRecordJump } from './useActivityRecordJump';

function renderJump() {
  return renderHook(() => useActivityRecordJump()).result;
}

describe('useActivityRecordJump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useActivityDetailStore.getState().close();
  });

  it('記録はその日の日ビューを URL の timeblock 付きで開く（記録として開く）', () => {
    useActivityDetailStore.getState().open({ activityId: 'activity-1', name: 'Writing' });
    renderJump().current.onJumpToRecord({ id: 'rec-1', dayKey: '2026-09-01' });

    // 予定ではなく記録として開く（kind を落とすと既定の 'plan' で開き、中身が出ない）
    expect(push).toHaveBeenCalledWith('/?view=day&date=2026-09-01&timeblock=record%3Arec-1');
    expect(useActivityDetailStore.getState().isOpen).toBe(false);
  });
});
