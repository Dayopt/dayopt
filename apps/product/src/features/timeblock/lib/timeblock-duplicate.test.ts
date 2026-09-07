import { describe, expect, it } from 'vitest';

import {
  buildTimeblockDuplicateCreateInput,
  createTimeblockDuplicateDraft,
  getTimeblockDuplicateValidationReason,
} from './timeblock-duplicate';

const now = new Date('2026-07-15T12:00:00.000Z');

function createDraft(kind: 'plan' | 'record') {
  return createTimeblockDuplicateDraft({
    sourceId: `${kind}-1`,
    kind,
    title: 'API development',
    note: 'Original note',
    startAt: new Date(kind === 'plan' ? '2026-07-15T13:00:00.000Z' : '2026-07-15T09:00:00.000Z'),
    endAt: new Date(kind === 'plan' ? '2026-07-15T14:00:00.000Z' : '2026-07-15T10:00:00.000Z'),
  });
}

describe('timeblock duplicate', () => {
  it('元のIDと関係をcreate入力へ持ち込まない', () => {
    const draft = createDraft('record');
    const input = buildTimeblockDuplicateCreateInput(draft, {
      note: ' Updated note ',
      activityId: '00000000-0000-4000-8000-0000000000a1',
      startAt: new Date('2026-07-15T10:00:00.000Z'),
      endAt: new Date('2026-07-15T11:00:00.000Z'),
    });

    // activityId が create 入力へ運ばれること。落とすと複製先で分類が無言で消える
    // （貼り付け経路で実際に起きていた同型の欠落）。
    expect(input).toEqual({
      title: 'API development',
      note: 'Updated note',
      activityId: '00000000-0000-4000-8000-0000000000a1',
      start_at: '2026-07-15T10:00:00.000Z',
      end_at: '2026-07-15T11:00:00.000Z',
    });
    expect(input).not.toHaveProperty('id');
    expect(input).not.toHaveProperty('sourceId');
    expect(input).not.toHaveProperty('planId');
  });

  it('元と同じ日時は作成要求を許可し、重複判定はcreate側へ委ねる', () => {
    const draft = createDraft('plan');

    expect(
      getTimeblockDuplicateValidationReason(
        draft,
        {
          note: '',
          startAt: new Date(draft.startAt),
          endAt: new Date(draft.endAt),
        },
        now,
      ),
    ).toBeNull();
  });

  it('Planはどの時刻へも複製でき、Recordは過去の変更先だけを許可する', () => {
    const plan = createDraft('plan');
    const record = createDraft('record');

    expect(
      getTimeblockDuplicateValidationReason(
        plan,
        {
          note: '',
          startAt: new Date('2026-07-15T10:00:00.000Z'),
          endAt: new Date('2026-07-15T11:00:00.000Z'),
        },
        now,
      ),
    ).toBeNull();
    expect(
      getTimeblockDuplicateValidationReason(
        record,
        {
          note: '',
          startAt: new Date('2026-07-15T13:00:00.000Z'),
          endAt: new Date('2026-07-15T14:00:00.000Z'),
        },
        now,
      ),
    ).toBe('recordRequiresPast');
    expect(
      getTimeblockDuplicateValidationReason(
        plan,
        {
          note: '',
          startAt: new Date('2026-07-15T15:00:00.000Z'),
          endAt: new Date('2026-07-15T16:00:00.000Z'),
        },
        now,
      ),
    ).toBeNull();
    expect(
      getTimeblockDuplicateValidationReason(
        record,
        {
          note: '',
          startAt: new Date('2026-07-15T07:00:00.000Z'),
          endAt: new Date('2026-07-15T08:00:00.000Z'),
        },
        now,
      ),
    ).toBeNull();
  });
});
