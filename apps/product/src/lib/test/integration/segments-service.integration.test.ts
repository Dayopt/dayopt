/**
 * SegmentsService の CRUD 契約を固定する（epic #2162 Step 5）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 *
 * `segment-schema.integration.test.ts` が DB の制約そのもの（複合 FK / PK / CHECK）を
 * 固定するのに対し、こちらは**サービス層がその制約をどうエラーへ翻訳するか**を固定する。
 * 分析 UI（#2181 の `/report`）はこのサービスの戻り値とエラーコードに乗るので、
 * 表示先が変わってもここが契約になる。
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSegmentsService,
  SegmentsServiceError,
} from '@/features/review/server/segments-service';
import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const service = createSegmentsService(admin);

const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const ownerEmail = `segments-service-owner-${ownerId}@example.com`;
const otherEmail = `segments-service-other-${otherId}@example.com`;

async function createActivity(userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from('activities')
    .insert({ user_id: userId, name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/** 投げられたエラーの code を読む。ServiceError は code を持つ。 */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error instanceof SegmentsServiceError ? error.code : `unexpected:${String(error)}`;
  }
}

describe.skipIf(!RUN_LOCAL)('SegmentsService (#2162)', () => {
  beforeAll(async () => {
    for (const [id, email] of [
      [ownerId, ownerEmail],
      [otherId, otherEmail],
    ] as const) {
      const { error } = await admin.auth.admin.createUser({
        id,
        email,
        password: 'test-password-123',
        email_confirm: true,
      });
      if (error) throw error;
    }
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(ownerId);
    await admin.auth.admin.deleteUser(otherId);
  });

  it('creates a segment with its activity set and reads it back', async () => {
    const a1 = await createActivity(ownerId, `API-${crypto.randomUUID()}`);
    const a2 = await createActivity(ownerId, `英語-${crypto.randomUUID()}`);
    const name = `深い仕事-${crypto.randomUUID()}`;

    const created = await service.create({ userId: ownerId, name, activityIds: [a1, a2] });
    expect(created.name).toBe(name);
    expect([...created.activityIds].sort()).toEqual([a1, a2].sort());

    const listed = await service.list({ userId: ownerId });
    const found = listed.find((s) => s.id === created.id);
    expect(found).toBeDefined();
    expect([...found!.activityIds].sort()).toEqual([a1, a2].sort());
  });

  it('creates an empty segment and returns it with an empty activity set', async () => {
    const created = await service.create({
      userId: ownerId,
      name: `空-${crypto.randomUUID()}`,
      activityIds: [],
    });

    const listed = await service.list({ userId: ownerId });
    // 行ごと落とさない（0h を過去比較として出せるようにするため）
    expect(listed.find((s) => s.id === created.id)?.activityIds).toEqual([]);
  });

  it('rejects a duplicate name with DUPLICATE_NAME', async () => {
    const name = `重複-${crypto.randomUUID()}`;
    await service.create({ userId: ownerId, name, activityIds: [] });

    const code = await codeOf(() => service.create({ userId: ownerId, name, activityIds: [] }));
    expect(code).toBe('DUPLICATE_NAME');
  });

  it('rejects another user’s activity with INVALID_INPUT', async () => {
    const foreign = await createActivity(otherId, `他人-${crypto.randomUUID()}`);

    const code = await codeOf(() =>
      service.create({
        userId: ownerId,
        name: `侵入-${crypto.randomUUID()}`,
        activityIds: [foreign],
      }),
    );
    expect(code).toBe('INVALID_INPUT');
  });

  it('replaces the activity set wholesale', async () => {
    const a1 = await createActivity(ownerId, `旧-${crypto.randomUUID()}`);
    const a2 = await createActivity(ownerId, `新-${crypto.randomUUID()}`);
    const created = await service.create({
      userId: ownerId,
      name: `入替-${crypto.randomUUID()}`,
      activityIds: [a1],
    });

    await service.replaceMembers({
      userId: ownerId,
      segmentId: created.id,
      activityIds: [a2],
    });

    const listed = await service.list({ userId: ownerId });
    expect(listed.find((s) => s.id === created.id)?.activityIds).toEqual([a2]);
  });

  it('renames a segment', async () => {
    const created = await service.create({
      userId: ownerId,
      name: `旧名-${crypto.randomUUID()}`,
      activityIds: [],
    });
    const newName = `新名-${crypto.randomUUID()}`;

    await service.rename({ userId: ownerId, segmentId: created.id, name: newName });

    const listed = await service.list({ userId: ownerId });
    expect(listed.find((s) => s.id === created.id)?.name).toBe(newName);
  });

  it('refuses to rename another user’s segment with NOT_FOUND', async () => {
    const foreign = await service.create({
      userId: otherId,
      name: `他人-${crypto.randomUUID()}`,
      activityIds: [],
    });

    const code = await codeOf(() =>
      service.rename({ userId: ownerId, segmentId: foreign.id, name: '乗っ取り' }),
    );
    expect(code).toBe('NOT_FOUND');
  });

  it('refuses to delete another user’s segment with NOT_FOUND', async () => {
    const foreign = await service.create({
      userId: otherId,
      name: `他人-${crypto.randomUUID()}`,
      activityIds: [],
    });

    const code = await codeOf(() => service.remove({ userId: ownerId, segmentId: foreign.id }));
    expect(code).toBe('NOT_FOUND');

    // 実際に消えていないことも確認する
    const stillThere = await service.list({ userId: otherId });
    expect(stillThere.some((s) => s.id === foreign.id)).toBe(true);
  });

  it('deletes a segment without deleting its activities', async () => {
    const activityId = await createActivity(ownerId, `残存-${crypto.randomUUID()}`);
    const created = await service.create({
      userId: ownerId,
      name: `削除対象-${crypto.randomUUID()}`,
      activityIds: [activityId],
    });

    await service.remove({ userId: ownerId, segmentId: created.id });

    const listed = await service.list({ userId: ownerId });
    expect(listed.some((s) => s.id === created.id)).toBe(false);

    const { data } = await admin.from('activities').select('id').eq('id', activityId).single();
    expect(data?.id).toBe(activityId);
  });

  /**
   * risk-reviewer が構成した P1 の再現（2026-08-18）。
   * 削除→挿入の順だと、stale な activityId が 1 つ混じるだけで既存メンバーが全消しになる。
   */
  it('keeps existing members when the new set contains a stale activity id', async () => {
    const a1 = await createActivity(ownerId, `維持1-${crypto.randomUUID()}`);
    const a2 = await createActivity(ownerId, `維持2-${crypto.randomUUID()}`);
    const stale = await createActivity(ownerId, `消える-${crypto.randomUUID()}`);
    const created = await service.create({
      userId: ownerId,
      name: `巻き戻し-${crypto.randomUUID()}`,
      activityIds: [a1, a2],
    });

    // 別タブでアクティビティが消えた状況を作る
    await admin.from('activities').delete().eq('id', stale);

    const code = await codeOf(() =>
      service.replaceMembers({
        userId: ownerId,
        segmentId: created.id,
        activityIds: [a1, a2, stale],
      }),
    );
    expect(code).toBe('INVALID_INPUT');

    // 失敗しても既存メンバーは 1 件も落ちていない
    const listed = await service.list({ userId: ownerId });
    expect([...(listed.find((s) => s.id === created.id)?.activityIds ?? [])].sort()).toEqual(
      [a1, a2].sort(),
    );
  });

  /** 同じく P1: create が途中失敗した時に名前を占有する幽霊セグメントを残さない。 */
  it('leaves no ghost segment when create fails on a bad activity id', async () => {
    const foreign = await createActivity(otherId, `他人-${crypto.randomUUID()}`);
    const name = `幽霊-${crypto.randomUUID()}`;

    const firstCode = await codeOf(() =>
      service.create({ userId: ownerId, name, activityIds: [foreign] }),
    );
    expect(firstCode).toBe('INVALID_INPUT');

    // 同じ名前で作り直せる（幽霊が名前を占有していたら DUPLICATE_NAME で詰む）
    const retried = await service.create({ userId: ownerId, name, activityIds: [] });
    expect(retried.name).toBe(name);

    const listed = await service.list({ userId: ownerId });
    expect(listed.filter((s) => s.name === name)).toHaveLength(1);
  });

  it('rejects replaceMembers on another user’s segment with NOT_FOUND', async () => {
    const foreign = await service.create({
      userId: otherId,
      name: `他人-${crypto.randomUUID()}`,
      activityIds: [],
    });

    const code = await codeOf(() =>
      service.replaceMembers({ userId: ownerId, segmentId: foreign.id, activityIds: [] }),
    );
    // 以前は 0 行 delete + insert skip で success を返す silent no-op だった
    expect(code).toBe('NOT_FOUND');
  });

  it('scopes list to the calling user', async () => {
    const mine = await service.create({
      userId: ownerId,
      name: `自分-${crypto.randomUUID()}`,
      activityIds: [],
    });
    const foreign = await service.create({
      userId: otherId,
      name: `他人-${crypto.randomUUID()}`,
      activityIds: [],
    });

    const listed = await service.list({ userId: ownerId });
    expect(listed.some((s) => s.id === mine.id)).toBe(true);
    // 修正前は segment id と userId を比較しており常に真だった（#2204 クロスレビュー P3-2）。
    // 他ユーザーの segment 実 id が含まれないことを見る。
    expect(listed.some((s) => s.id === foreign.id)).toBe(false);
  });
});
