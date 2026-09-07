import { describe, expect, it } from 'vitest';

import type { ClipboardTimeblock } from '@/features/timeblock';

import { resolveTimeblockClipboardPaste } from './timeblock-clipboard-paste';

const plan: ClipboardTimeblock = {
  kind: 'plan',
  title: '設計',
  description: 'APIを整理する',
  duration: 60,
  startHour: 10,
  startMinute: 30,
  activityId: 'activity-dev',
};

const record: ClipboardTimeblock = {
  ...plan,
  kind: 'record',
};

describe('resolveTimeblockClipboardPaste', () => {
  it('未来にはPlanとして独立した作成入力を返す', () => {
    const result = resolveTimeblockClipboardPaste({
      copiedTimeblock: plan,
      targetDate: new Date(2026, 6, 15),
      timezone: 'Asia/Tokyo',
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toEqual({
      ok: true,
      kind: 'plan',
      input: {
        title: '設計',
        note: 'APIを整理する',
        activityId: 'activity-dev',
        start_at: '2026-07-15T01:30:00.000Z',
        end_at: '2026-07-15T02:30:00.000Z',
      },
    });
    if (result.ok) {
      expect(result.input).not.toHaveProperty('id');
      expect(result.input).not.toHaveProperty('planId');
    }
  });

  it('過去にはRecordとして独立した作成入力を返す', () => {
    const result = resolveTimeblockClipboardPaste({
      copiedTimeblock: record,
      targetDate: new Date(2026, 6, 13),
      timezone: 'Asia/Tokyo',
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toMatchObject({ ok: true, kind: 'record' });
    if (result.ok) {
      expect(result.input).not.toHaveProperty('planId');
    }
  });

  it('Planは過去へも貼り付けられる（Plan は時間軸のどこにでも置ける）', () => {
    expect(
      resolveTimeblockClipboardPaste({
        copiedTimeblock: plan,
        targetDate: new Date(2026, 6, 13),
        timezone: 'Asia/Tokyo',
        now: new Date('2026-07-14T00:00:00.000Z'),
      }),
    ).toMatchObject({ ok: true, kind: 'plan' });
  });

  it('Recordを未来へ貼り付けず理由を返す', () => {
    expect(
      resolveTimeblockClipboardPaste({
        copiedTimeblock: record,
        targetDate: new Date(2026, 6, 15),
        timezone: 'Asia/Tokyo',
        now: new Date('2026-07-14T00:00:00.000Z'),
      }),
    ).toEqual({ ok: false, reason: 'recordRequiresPast' });
  });
});
