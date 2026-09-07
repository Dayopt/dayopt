import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockContext } from '@/lib/test/trpc-test-helpers';
import { createCallerFactory } from '@/lib/trpc/procedures';

const methods = vi.hoisted(() => ({
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  deletePlan: vi.fn(),
  restorePlan: vi.fn(),
  setPlanSkipped: vi.fn(),
  recordPlan: vi.fn(),
  confirmDay: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  restoreRecord: vi.fn(),
}));

vi.mock('./timeblock-command-service', () => ({
  createTimeblockCommandService: () => methods,
}));

import { appRouter } from '@/app/api/trpc/_server/app-router';
import { planCommandsRouter } from './plan-commands-router';
import { recordCommandsRouter } from './record-commands-router';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const PLAN_ID = '00000000-0000-4000-8000-0000000000b1';
const RECORD_ID = '00000000-0000-4000-8000-0000000000c1';
const VERSION = '2026-07-29T00:00:00.123456Z';
const createPlanCaller = createCallerFactory(planCommandsRouter);
const createRecordCaller = createCallerFactory(recordCommandsRouter);

function planCaller() {
  return createPlanCaller(createMockContext({ userId: USER_ID }));
}

function recordCaller() {
  return createRecordCaller(createMockContext({ userId: USER_ID }));
}

describe('timeblock command routers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.values(methods)) method.mockResolvedValue({});
  });

  // #1893 で legacy mutation を削除した。plans / records に write が再び生えたら
  // owner 境界と時刻規則の写しが 2 系統に戻るため、read 専用であることを固定する。
  it('plans / recordsはread専用で、writeはversioned command namespaceだけが持つ', () => {
    const procedureNames = Object.keys(appRouter._def.procedures);

    expect(procedureNames.filter((name) => name.startsWith('plans.')).sort()).toEqual([
      'plans.getById',
      'plans.list',
    ]);
    expect(procedureNames.filter((name) => name.startsWith('records.')).sort()).toEqual([
      'records.getById',
      'records.list',
    ]);
    expect(procedureNames).toEqual(
      expect.arrayContaining(['planCommands.update', 'recordCommands.update']),
    );
  });

  // 「未認証は UNAUTHORIZED」の契約は write-fence-coverage.test.ts が全 procedure 横断で
  // 機械検証する（#2187 E-3）。ここでの個別 assert（planCommands.create）は重複だったため削除した。

  it('versioned Plan inputを必須にし、session userをserviceへbindする', async () => {
    await expect(
      planCaller().update({
        id: PLAN_ID,
        data: { title: 'Changed' },
        expectedUpdatedAt: VERSION,
      }),
    ).resolves.toEqual({});

    expect(methods.updatePlan).toHaveBeenCalledWith({
      userId: USER_ID,
      id: PLAN_ID,
      input: { title: 'Changed' },
      expectedUpdatedAt: VERSION,
    });

    await expect(
      // Runtime validation is intentionally checked independently of TypeScript.
      planCaller().update({ id: PLAN_ID, data: { title: 'Missing version' } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('versioned Record deleteへsession userとraw tokenを渡す', async () => {
    await recordCaller().delete({ id: RECORD_ID, expectedUpdatedAt: VERSION });

    expect(methods.deleteRecord).toHaveBeenCalledWith({
      userId: USER_ID,
      id: RECORD_ID,
      expectedUpdatedAt: VERSION,
    });
  });

  // p_user_id は Plan / Record の owner 境界そのもので、authenticated の直接 DML を
  // 剥がした後は RLS が第2の防波堤として効かない。#2627 で守りを「zod の unknown key
  // strip と spread 順の合成（両方外れた時だけ落ちる）」から機械保証へ変えた:
  // schema が `.strict()` なので userId の混入は BAD_REQUEST になり、service へ渡す
  // field は 1 つずつ書き出すので userId は ctx 以外から来ない。silent strip ではなく
  // explicit reject であることまで固定する。
  it('client入力のuserIdはBAD_REQUESTで拒否し、serviceへ到達させない', async () => {
    const forgedUserId = '00000000-0000-4000-8000-0000000000ff';

    await expect(
      recordCaller().delete({
        id: RECORD_ID,
        expectedUpdatedAt: VERSION,
        userId: forgedUserId,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(methods.deleteRecord).not.toHaveBeenCalled();

    await expect(
      planCaller().skip({
        id: PLAN_ID,
        expectedUpdatedAt: VERSION,
        userId: forgedUserId,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(methods.setPlanSkipped).not.toHaveBeenCalled();

    // create 系は入れ子の payload schema 側で拒否する
    await expect(
      planCaller().create({
        title: 'Forged',
        start_at: '2026-07-29T00:00:00.000Z',
        end_at: '2026-07-29T01:00:00.000Z',
        userId: forgedUserId,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(methods.createPlan).not.toHaveBeenCalled();

    // 正規の入力は通り、userId は session user だけが渡る
    await planCaller().skip({ id: PLAN_ID, expectedUpdatedAt: VERSION });
    expect(methods.setPlanSkipped).toHaveBeenCalledWith({
      userId: USER_ID,
      id: PLAN_ID,
      expectedUpdatedAt: VERSION,
      skipped: true,
    });
  });

  it('confirm dayはDSTの25時間を許可し、26時間超を拒否する', async () => {
    await expect(
      planCaller().confirmDay({
        start_at: '2026-10-31T00:00:00.000Z',
        end_at: '2026-11-01T01:00:00.000Z',
      }),
    ).resolves.toEqual({});

    await expect(
      planCaller().confirmDay({
        start_at: '2026-10-31T00:00:00.000Z',
        end_at: '2026-11-01T03:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
