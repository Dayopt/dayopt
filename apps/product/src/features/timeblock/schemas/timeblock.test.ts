import { describe, expect, it } from 'vitest';

import { createRecordSchema, planFilterSchema, recordFilterSchema } from './timeblock';

const planId = '11111111-1111-4111-8111-111111111111';

describe('timeblock relation filters', () => {
  it('廃止したskip入力を拒否する', () => {
    expect(planFilterSchema.safeParse({ includeSkipped: false }).success).toBe(false);
  });

  it('Record作成契約に予定参照を受理しない', () => {
    const base = {
      title: 'Record',
      start_at: '2026-09-07T09:00:00.000Z',
      end_at: '2026-09-07T10:00:00.000Z',
    };
    expect(createRecordSchema.safeParse({ ...base, planId: planId }).success).toBe(false);
    expect(createRecordSchema.safeParse({ ...base, planId: null }).success).toBe(false);
  });

  it('UUID配列を受け入れる', () => {
    expect(planFilterSchema.safeParse({ ids: [planId] }).success).toBe(true);
    expect(recordFilterSchema.safeParse({ planIds: [planId] }).success).toBe(false);
  });

  it('UUIDではないIDを拒否する', () => {
    expect(planFilterSchema.safeParse({ ids: ['not-a-uuid'] }).success).toBe(false);
    expect(recordFilterSchema.safeParse({ planIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('100件を超えるID配列を拒否する', () => {
    const tooManyIds = Array.from({ length: 101 }, () => planId);

    expect(planFilterSchema.safeParse({ ids: tooManyIds }).success).toBe(false);
    expect(recordFilterSchema.safeParse({ planIds: tooManyIds }).success).toBe(false);
  });
});
