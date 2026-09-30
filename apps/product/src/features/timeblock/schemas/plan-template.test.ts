import { describe, expect, it } from 'vitest';

import {
  applyPlanTemplateSchema,
  createPlanTemplateSchema,
  planTemplateIdSchema,
  renamePlanTemplateSchema,
} from './plan-template';

const ID = '10000000-0000-4000-8000-000000000001';
const block = { activityId: ID, title: 'Focus', anchorMinute: 0 };

describe('plan template input contracts', () => {
  it.each([0, 1439])('accepts the day boundary minute %i and normalizes text', (anchorMinute) => {
    // 守ること: 一日の先頭・末尾への錨と、名前・タイトルの前後空白除去を維持する。
    expect(
      createPlanTemplateSchema.parse({
        name: ' Daily ',
        blocks: [{ ...block, title: ' Focus ', anchorMinute }],
      }),
    ).toEqual({ name: 'Daily', blocks: [{ ...block, anchorMinute }] });
  });
  it('accepts exactly 50 blocks and maximum-length names', () => {
    // 守ること: 許可された最大件数・文字数のテンプレートを拒否しない。
    const input = {
      name: 'a'.repeat(100),
      blocks: Array.from({ length: 50 }, () => ({
        ...block,
        title: 'b'.repeat(200),
        activityId: null,
      })),
    };
    expect(createPlanTemplateSchema.parse(input)).toEqual(input);
  });
  it.each([-1, 1440, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid anchor minute %s',
    (anchorMinute) => {
      // 守ること: 日をはみ出す時刻・端数・非有限値を保存入力として受け入れない。
      expect(
        createPlanTemplateSchema.safeParse({ name: 'Daily', blocks: [{ ...block, anchorMinute }] })
          .success,
      ).toBe(false);
    },
  );
  it.each(['', '   ', 'a'.repeat(101)])('rejects invalid template name %j', (name) => {
    // 守ること: 空白だけ・空文字・上限超過の名前を正規化後に拒否する。
    expect(createPlanTemplateSchema.safeParse({ name, blocks: [block] }).success).toBe(false);
    expect(renamePlanTemplateSchema.safeParse({ templateId: ID, name }).success).toBe(false);
  });
  it.each(['', '   ', 'a'.repeat(201)])('rejects invalid block title %j', (title) => {
    // 守ること: 各ブロックにも空白・文字数の制約を適用する。
    expect(
      createPlanTemplateSchema.safeParse({ name: 'Daily', blocks: [{ ...block, title }] }).success,
    ).toBe(false);
  });
  it.each([0, 51])('rejects %i blocks', (count) => {
    // 守ること: 空テンプレートと一括作成上限を超えるブロック群を拒否する。
    expect(
      createPlanTemplateSchema.safeParse({
        name: 'Daily',
        blocks: Array.from({ length: count }, () => block),
      }).success,
    ).toBe(false);
  });
  it('rejects malformed activity identifiers', () => {
    // 守ること: null以外のアクティビティ参照はUUIDでなければ保存できない。
    expect(
      createPlanTemplateSchema.safeParse({
        name: 'Daily',
        blocks: [{ ...block, activityId: 'bad-id' }],
      }).success,
    ).toBe(false);
  });
  it.each([planTemplateIdSchema, renamePlanTemplateSchema, applyPlanTemplateSchema])(
    'rejects invalid template identifiers',
    (schema) => {
      // 守ること: 取得・改名・適用の全入力が不正なテンプレートIDを拒否する。
      expect(
        schema.safeParse({ templateId: 'bad-id', name: 'Daily', date: '2026-09-29' }).success,
      ).toBe(false);
    },
  );
  it('accepts identification, rename and apply payloads', () => {
    // 守ること: 正常なID・改名・暦日適用が利用できる。
    expect(planTemplateIdSchema.parse({ templateId: ID })).toEqual({ templateId: ID });
    expect(renamePlanTemplateSchema.parse({ templateId: ID, name: ' New ' })).toEqual({
      templateId: ID,
      name: 'New',
    });
    expect(applyPlanTemplateSchema.parse({ templateId: ID, date: '2026-09-29' })).toEqual({
      templateId: ID,
      date: '2026-09-29',
    });
  });
  it.each([
    '2026-02-30',
    '2025-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
  ])('rejects nonexistent Gregorian date %s', (date) => {
    expect(applyPlanTemplateSchema.safeParse({ templateId: ID, date }).success).toBe(false);
  });
  it.each(['2000-02-29', '2024-02-29', '0099-01-01'])('accepts valid Gregorian date %s', (date) => {
    expect(applyPlanTemplateSchema.safeParse({ templateId: ID, date }).success).toBe(true);
  });
  it.each(['2026-9-29', '2026-09-29T00:00:00Z', '', '2026/09/29'])(
    'rejects a non-date-key apply input %j',
    (date) => {
      // 守ること: 日付適用の入力にtimestampや非標準日付表現を混ぜない。
      expect(applyPlanTemplateSchema.safeParse({ templateId: ID, date }).success).toBe(false);
    },
  );
});
