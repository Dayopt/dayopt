import { describe, expect, it } from 'vitest';

import {
  doesTimeModelListQueryIncludeRow,
  useTimeblockWriteMutations,
} from './useTimeblockWriteMutations';

const row = {
  id: 'record-1',
  title: 'Deep Work',
  note: 'Focus',

  activity_id: 'activity-1',
  start_at: '2026-07-10T01:00:00.000Z',
  end_at: '2026-07-10T02:00:00.000Z',
  created_at: '2026-07-10T00:00:00.000Z',
  updated_at: '2026-07-10T00:00:00.000Z',
  deleted_at: null,
};

function listKey(input: Record<string, unknown>, lane: 'plans' | 'records' = 'records') {
  return [[lane, 'list'], { input, type: 'query' }];
}

describe('useTimeblockWriteMutations', () => {
  it('Plan と Record の作成・編集 mutation をまとめる hook を提供する', () => {
    expect(useTimeblockWriteMutations).toBeTypeOf('function');
  });

  it('操作対象のID配列に一致する行だけを対象にする', () => {
    expect(
      doesTimeModelListQueryIncludeRow(listKey({ ids: ['record-1'] }, 'plans'), row, 'plans'),
    ).toBe(true);
    expect(
      doesTimeModelListQueryIncludeRow(listKey({ ids: ['plan-2'] }, 'plans'), row, 'plans'),
    ).toBe(false);
    expect(doesTimeModelListQueryIncludeRow(listKey({ ids: [] }, 'plans'), row, 'plans')).toBe(
      false,
    );
  });

  it('表示期間と重なる行だけを対象にする（offset付きcreateは除外）', () => {
    expect(
      doesTimeModelListQueryIncludeRow(
        listKey({
          startDate: '2026-07-10T09:30:00+09:00',
          endDate: '2026-07-10T11:30:00+09:00',
        }),
        row,
        'records',
      ),
    ).toBe(true);
    expect(
      doesTimeModelListQueryIncludeRow(
        listKey({
          startDate: '2026-07-11T00:00:00+09:00',
          endDate: '2026-07-12T00:00:00+09:00',
        }),
        row,
        'records',
      ),
    ).toBe(false);
    expect(doesTimeModelListQueryIncludeRow(listKey({ offset: 10 }), row, 'records')).toBe(false);
  });

  it('activity filterは行から判定する', () => {
    expect(
      doesTimeModelListQueryIncludeRow(listKey({ activityId: 'activity-1' }), row, 'records'),
    ).toBe(true);
    expect(
      doesTimeModelListQueryIncludeRow(listKey({ activityId: 'activity-2' }), row, 'records'),
    ).toBe(false);
  });

  it('アクティビティ名を解決できないsearch cacheは楽観更新の一致対象にしない', () => {
    expect(doesTimeModelListQueryIncludeRow(listKey({ search: 'focus' }), row, 'records')).toBe(
      false,
    );
    expect(
      doesTimeModelListQueryIncludeRow(listKey({ search: 'deep work' }), row, 'records', 'update'),
    ).toBe(false);
  });
});
