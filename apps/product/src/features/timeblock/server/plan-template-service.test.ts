import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlanTemplateService } from './plan-template-service';
import type { TimeblockCommandClient } from './timeblock-command-client';
import type { PlanRow } from './timeblock-types';
import type { ServiceSupabaseClient } from './types';

const trackProductEvent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics/product-events', () => ({
  trackProductEvent,
  trackProductEvents: vi.fn(),
}));
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedDatabaseError: (error: unknown) => error,
}));

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const TEMPLATE_ID = '00000000-0000-4000-8000-0000000000e1';
const ACTIVITY_A = '00000000-0000-4000-8000-0000000000b1';
const ACTIVITY_ARCHIVED = '00000000-0000-4000-8000-0000000000b2';

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/**
 * table ごとに結果を順に返す最小の Supabase stub。chain の全 method は自分を返し、
 * `single` / `maybeSingle` / `then` が次の結果を消費する。
 */
function createSupabaseStub(results: Record<string, QueryResult[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const queue = results[table] ?? [];
    const next = () => queue.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const method of [
      'select',
      'insert',
      'update',
      'delete',
      'eq',
      'in',
      'is',
      'order',
      'gte',
      'gt',
      'range',
      'lt',
    ]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method, args });
        return chain;
      });
    }
    chain.single = vi.fn(async () => next());
    chain.maybeSingle = vi.fn(async () => next());
    chain.then = (resolve: (value: QueryResult) => unknown) =>
      Promise.resolve(next()).then(resolve);
    return chain;
  });
  return { supabase: { from } as unknown as ServiceSupabaseClient, calls };
}

const template = {
  id: TEMPLATE_ID,
  name: '朝のルーティン',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const blocks = [
  {
    id: 'blk-1',
    template_id: TEMPLATE_ID,
    activity_id: ACTIVITY_A,
    title: '集中',
    anchor_minute: 9 * 60,
  },
  {
    id: 'blk-2',
    template_id: TEMPLATE_ID,
    activity_id: ACTIVITY_ARCHIVED,
    title: '旧アクティビティ',
    anchor_minute: 10 * 60,
  },
  { id: 'blk-3', template_id: TEMPLATE_ID, activity_id: null, title: '昼', anchor_minute: 12 * 60 },
];

const settings = { timezone: 'Asia/Tokyo', default_duration: 45 };

function recordRows(activityId: string, minutes: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `rec-${index}`,
    activity_id: activityId,

    source: 'manual',
    start_at: '2026-09-01T00:00:00.000Z',
    end_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + minutes * 60_000).toISOString(),
  }));
}

function createCommands() {
  return { createPlansBulk: vi.fn() } as unknown as TimeblockCommandClient & {
    createPlansBulk: ReturnType<typeof vi.fn>;
  };
}

describe('PlanTemplateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('中央値（n>=3）を着せ、無い activity と未分類は user_settings の既定長を着せる', async () => {
      const { supabase } = createSupabaseStub({
        plan_templates: [{ data: [template], error: null }],
        plan_template_blocks: [{ data: blocks, error: null }],
        user_settings: [{ data: settings, error: null }],
        records: [{ data: recordRows(ACTIVITY_A, 90, 3), error: null }],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      const result = await service.list(USER_ID);

      expect(result).toHaveLength(1);
      expect(result[0]?.blocks.map((block) => block.previewDurationMinutes)).toEqual([
        60, // 中央値 90 だが次の錨（10:00）までで 60 に clip
        45, // n < 3 → 既定長 45
        45, // 未分類 → 既定長 45
      ]);
    });

    it('template が無ければ blocks も records も読まない', async () => {
      const { supabase, calls } = createSupabaseStub({
        plan_templates: [{ data: [], error: null }],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      await expect(service.list(USER_ID)).resolves.toEqual([]);
      expect(calls.some((call) => call.table === 'plan_template_blocks')).toBe(false);
      expect(calls.some((call) => call.table === 'records')).toBe(false);
    });
  });

  describe('create', () => {
    it('親 → 子の順に insert し、子が失敗したら親を消して INVALID_INPUT にする', async () => {
      const { supabase, calls } = createSupabaseStub({
        plan_templates: [
          { data: template, error: null },
          { data: null, error: null }, // compensating delete
        ],
        plan_template_blocks: [{ data: null, error: { code: '23503', message: 'fk violation' } }],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      await expect(
        service.create({
          userId: USER_ID,
          input: {
            name: '型',
            blocks: [{ activityId: ACTIVITY_A, title: '集中', anchorMinute: 540 }],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      const templateCalls = calls.filter((call) => call.table === 'plan_templates');
      expect(templateCalls.some((call) => call.method === 'delete')).toBe(true);
      const deleteEqArgs = templateCalls
        .filter((call) => call.method === 'eq')
        .map((call) => call.args);
      expect(deleteEqArgs).toEqual(
        expect.arrayContaining([
          ['id', TEMPLATE_ID],
          ['user_id', USER_ID],
        ]),
      );
    });

    it('成功時は preview 付きの view を返す', async () => {
      const { supabase, calls } = createSupabaseStub({
        plan_templates: [{ data: template, error: null }],
        plan_template_blocks: [{ data: [blocks[0]], error: null }],
        user_settings: [{ data: settings, error: null }],
        records: [{ data: [], error: null }],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      const result = await service.create({
        userId: USER_ID,
        input: {
          name: '型',
          blocks: [{ activityId: ACTIVITY_A, title: '集中', anchorMinute: 540 }],
        },
      });

      expect(result.id).toBe(TEMPLATE_ID);
      expect(result.blocks).toEqual([
        {
          id: 'blk-1',
          activityId: ACTIVITY_A,
          title: '集中',
          anchorMinute: 540,
          previewDurationMinutes: 45,
        },
      ]);
      const blockInsert = calls.find(
        (call) => call.table === 'plan_template_blocks' && call.method === 'insert',
      );
      expect(blockInsert?.args[0]).toEqual([
        {
          template_id: TEMPLATE_ID,
          user_id: USER_ID,
          activity_id: ACTIVITY_A,
          title: '集中',
          anchor_minute: 540,
        },
      ]);
    });
  });

  describe('rename / delete', () => {
    it('行が返らなければ NOT_FOUND（他人の template は RLS で行が返らない）', async () => {
      const { supabase } = createSupabaseStub({
        plan_templates: [
          { data: null, error: null },
          { data: null, error: null },
        ],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      await expect(
        service.rename({ userId: USER_ID, input: { templateId: TEMPLATE_ID, name: '新' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        service.delete({ userId: USER_ID, input: { templateId: TEMPLATE_ID } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rename は user_id で絞って update する', async () => {
      const { supabase, calls } = createSupabaseStub({
        plan_templates: [
          {
            data: { id: TEMPLATE_ID, name: '新', updated_at: '2026-09-02T00:00:00.000Z' },
            error: null,
          },
        ],
      });
      const service = new PlanTemplateService(supabase, createCommands(), () => supabase);

      await expect(
        service.rename({ userId: USER_ID, input: { templateId: TEMPLATE_ID, name: '新' } }),
      ).resolves.toEqual({ id: TEMPLATE_ID, name: '新', updatedAt: '2026-09-02T00:00:00.000Z' });
      expect(calls.map((call) => [call.method, call.args])).toEqual(
        expect.arrayContaining([
          ['update', [{ name: '新' }]],
          ['eq', ['user_id', USER_ID]],
        ]),
      );
    });
  });

  describe('apply', () => {
    it('中央値 / 既定長 / archived を反映した行を 1 回の bulk command へ渡し、Plan 行を返す', async () => {
      const created = [{ id: 'plan-1' }, { id: 'plan-2' }, { id: 'plan-3' }] as PlanRow[];
      const commands = createCommands();
      commands.createPlansBulk.mockResolvedValue(created);
      const { supabase } = createSupabaseStub({
        plan_templates: [{ data: template, error: null }],
        plan_template_blocks: [{ data: blocks, error: null }],
        user_settings: [{ data: settings, error: null }],
        records: [{ data: recordRows(ACTIVITY_A, 30, 4), error: null }],
        activities: [
          {
            data: [
              { id: ACTIVITY_A, archived_at: null },
              { id: ACTIVITY_ARCHIVED, archived_at: '2026-08-01T00:00:00.000Z' },
            ],
            error: null,
          },
        ],
      });
      const service = new PlanTemplateService(supabase, commands, () => supabase);

      const result = await service.apply({
        userId: USER_ID,
        input: { templateId: TEMPLATE_ID, date: '2026-09-05' },
      });

      expect(result).toBe(created);
      expect(commands.createPlansBulk).toHaveBeenCalledTimes(1);
      expect(commands.createPlansBulk).toHaveBeenCalledWith({
        userId: USER_ID,
        plans: [
          {
            title: '集中',
            activityId: ACTIVITY_A,
            startAt: '2026-09-05T00:00:00.000Z', // 09:00 JST
            endAt: '2026-09-05T00:30:00.000Z', // 中央値 30
          },
          {
            title: '旧アクティビティ',
            activityId: null, // archived → activity 無しで title 保持
            startAt: '2026-09-05T01:00:00.000Z',
            endAt: '2026-09-05T01:45:00.000Z', // 既定長 45
          },
          {
            title: '昼',
            activityId: null,
            startAt: '2026-09-05T03:00:00.000Z',
            endAt: '2026-09-05T03:45:00.000Z',
          },
        ],
      });
      expect(trackProductEvent).toHaveBeenCalledWith({
        eventName: 'plan_created',
        userId: USER_ID,
      });
    });

    it('template が読めなければ NOT_FOUND で、command を呼ばない', async () => {
      const commands = createCommands();
      const { supabase } = createSupabaseStub({
        plan_templates: [{ data: null, error: null }],
      });
      const service = new PlanTemplateService(supabase, commands, () => supabase);

      await expect(
        service.apply({ userId: USER_ID, input: { templateId: TEMPLATE_ID, date: '2026-09-05' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(commands.createPlansBulk).not.toHaveBeenCalled();
    });

    it('具現化できない型（clip 後 5 分未満）は TEMPLATE_DOES_NOT_FIT で、command を呼ばない', async () => {
      const commands = createCommands();
      const { supabase } = createSupabaseStub({
        plan_templates: [{ data: template, error: null }],
        plan_template_blocks: [
          {
            data: [
              { ...blocks[0], anchor_minute: 540 },
              { ...blocks[2], anchor_minute: 542 },
            ],
            error: null,
          },
        ],
        user_settings: [{ data: settings, error: null }],
        records: [{ data: [], error: null }],
        activities: [{ data: [{ id: ACTIVITY_A, archived_at: null }], error: null }],
      });
      const service = new PlanTemplateService(supabase, commands, () => supabase);

      await expect(
        service.apply({ userId: USER_ID, input: { templateId: TEMPLATE_ID, date: '2026-09-05' } }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_DOES_NOT_FIT' });
      expect(commands.createPlansBulk).not.toHaveBeenCalled();
    });

    it('command の TIME_OVERLAP はそのまま伝播する（全件 rollback 済み）', async () => {
      const commands = createCommands();
      commands.createPlansBulk.mockRejectedValue(
        Object.assign(new Error('overlap'), { code: 'TIME_OVERLAP' }),
      );
      const { supabase } = createSupabaseStub({
        plan_templates: [{ data: template, error: null }],
        plan_template_blocks: [{ data: [blocks[0]], error: null }],
        user_settings: [{ data: settings, error: null }],
        records: [{ data: [], error: null }],
        activities: [{ data: [{ id: ACTIVITY_A, archived_at: null }], error: null }],
      });
      const service = new PlanTemplateService(supabase, commands, () => supabase);

      await expect(
        service.apply({ userId: USER_ID, input: { templateId: TEMPLATE_ID, date: '2026-09-05' } }),
      ).rejects.toMatchObject({ code: 'TIME_OVERLAP' });
      expect(trackProductEvent).not.toHaveBeenCalled();
    });
  });
});
