import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const methods = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  apply: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./plan-template-service', () => ({
  createPlanTemplateService: () => methods,
}));

import { appRouter } from '@/app/api/trpc/_server/app-router';
import { planTemplatesRouter } from './plan-templates-router';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const TEMPLATE_ID = '00000000-0000-4000-8000-0000000000e1';
const ACTIVITY_ID = '00000000-0000-4000-8000-0000000000b1';
const createCaller = createCallerFactory(planTemplatesRouter);

function caller() {
  return createCaller(createMockContext({ userId: USER_ID }));
}

describe('planTemplates router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.values(methods)) method.mockResolvedValue({});
  });

  it('root router に planTemplates.* が登録されている', () => {
    expect(Object.keys(appRouter._def.procedures)).toEqual(
      expect.arrayContaining([
        'planTemplates.list',
        'planTemplates.create',
        'planTemplates.applyToDay',
        'planTemplates.rename',
        'planTemplates.delete',
      ]),
    );
  });

  it('list は session user を service へ渡す', async () => {
    await caller().list();
    expect(methods.list).toHaveBeenCalledWith(USER_ID);
  });

  it('create は client 入力を input に閉じ込め、userId は ctx から取る', async () => {
    await caller().create({
      name: '  朝のルーティン  ',
      blocks: [{ activityId: ACTIVITY_ID, title: '集中', anchorMinute: 540 }],
    });
    expect(methods.create).toHaveBeenCalledWith({
      userId: USER_ID,
      input: {
        name: '朝のルーティン',
        blocks: [{ activityId: ACTIVITY_ID, title: '集中', anchorMinute: 540 }],
      },
    });
  });

  it('create は空の blocks / 51 件 / 範囲外の錨 / 空の名前を弾く', async () => {
    const block = { activityId: null, title: '集中', anchorMinute: 0 };
    await expect(caller().create({ name: '型', blocks: [] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().create({ name: '型', blocks: Array.from({ length: 51 }, () => block) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().create({ name: '型', blocks: [{ ...block, anchorMinute: 1440 }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().create({ name: '   ', blocks: [block] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(methods.create).not.toHaveBeenCalled();
  });

  it('applyToDay は yyyy-MM-dd だけを受け、userId は ctx から取る', async () => {
    await caller().applyToDay({ templateId: TEMPLATE_ID, date: '2026-09-05' });
    expect(methods.apply).toHaveBeenCalledWith({
      userId: USER_ID,
      input: { templateId: TEMPLATE_ID, date: '2026-09-05' },
    });

    await expect(
      caller().applyToDay({ templateId: TEMPLATE_ID, date: '2026-09-05T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().applyToDay({ templateId: 'not-a-uuid', date: '2026-09-05' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it.each(['2026-02-30', '1900-02-29', '2026-13-01'])(
    'rejects nonexistent date %s before calling the service',
    async (date) => {
      await expect(caller().applyToDay({ templateId: TEMPLATE_ID, date })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(methods.apply).not.toHaveBeenCalled();
    },
  );

  it('rename / delete は templateId と userId を service へ渡す', async () => {
    await caller().rename({ templateId: TEMPLATE_ID, name: '新しい名前' });
    expect(methods.rename).toHaveBeenCalledWith({
      userId: USER_ID,
      input: { templateId: TEMPLATE_ID, name: '新しい名前' },
    });

    await caller().delete({ templateId: TEMPLATE_ID });
    expect(methods.delete).toHaveBeenCalledWith({
      userId: USER_ID,
      input: { templateId: TEMPLATE_ID },
    });
  });

  it('service の NOT_FOUND は tRPC NOT_FOUND へ写像される', async () => {
    methods.rename.mockRejectedValue(
      Object.assign(new Error('Plan template not found'), { code: 'NOT_FOUND' }),
    );
    await expect(caller().rename({ templateId: TEMPLATE_ID, name: '新' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
