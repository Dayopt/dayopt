/**
 * event-pruning.ts の `deleteUnreferencedEvents` を実 Supabase local DB に対して検証する。
 *
 * regression（#1996）: `external_calendar_events.id` は UUID 列。keyset ページングの初回 cursor
 * に空文字を渡すと PostgREST が `.gt('id', '')` を invalid UUID として拒否し、candidate select
 * が丸ごと失敗する。event-pruning.test.ts の mock（文字列比較で `.gt` を素通りさせる fake table）
 * はこの UUID キャストを再現できないため、緑のまま「本番稼働以来 prune が一度も行を消せていない」
 * バグを見逃していた（指揮台の独立検証、#1996 コメント参照）。ここでは実 DB を叩いて再現する。
 */

import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { deleteUnreferencedEvents } from '@/features/external-calendar/server/event-pruning';
import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const userEmail = `calendar-event-pruning-${userId}@example.com`;

// この fixture は「これから来る予定」を表す。固定日付だとテストが古くなった時に
// 意味が変わるため、実行時刻からの相対値にする。
const EVENT_START_AT = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const EVENT_END_AT = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();

function activeShapeEvent(overrides: {
  id: string;
  connectionId: string;
  providerCalendarId?: string;
  providerEventId?: string;
}) {
  return {
    id: overrides.id,
    user_id: userId,
    provider: 'google',
    provider_calendar_id: overrides.providerCalendarId ?? 'calendar-1',
    provider_event_id: overrides.providerEventId ?? `event-${overrides.id}`,
    title: 'Standup',
    calendar_name: 'Work',
    start_at: EVENT_START_AT,
    end_at: EVENT_END_AT,
    status: 'confirmed',
    last_synced_at: EVENT_START_AT,
    connection_id: overrides.connectionId,
  };
}

async function createConnection(): Promise<string> {
  const connectionId = crypto.randomUUID();
  const { error } = await admin.from('calendar_connections').insert({
    id: connectionId,
    user_id: userId,
    provider: 'google',
    provider_account_id: `sub-${connectionId}`,
    granted_scopes: ['calendar.readonly'],
    refresh_token_enc: 'v1.integration-ciphertext',
    status: 'active',
  });
  if (error) throw error;
  return connectionId;
}

describe.skipIf(!RUN_LOCAL)('deleteUnreferencedEvents — 実 DB での keyset ページング', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email: userEmail,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (error) throw error;
  });

  afterEach(async () => {
    await admin.from('external_calendar_events').delete().eq('user_id', userId);
    await admin.from('calendar_connections').delete().eq('user_id', userId);
  });

  it('未参照のミラー行を実際に delete する（修正前は invalid UUID で 1 行も消せなかった）', async () => {
    const connectionId = await createConnection();
    const eventIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    const { error: insertError } = await admin
      .from('external_calendar_events')
      .insert(eventIds.map((id) => activeShapeEvent({ id, connectionId })));
    if (insertError) throw insertError;

    await deleteUnreferencedEvents({
      userId,
      connectionId,
      scope: { kind: 'connection' },
    });

    const { data: remaining, error: selectError } = await admin
      .from('external_calendar_events')
      .select('id')
      .eq('connection_id', connectionId);
    if (selectError) throw selectError;

    expect(remaining).toEqual([]);
  });

  it('参照済みの行は anti-join で残す', async () => {
    const connectionId = await createConnection();
    const referencedEventId = crypto.randomUUID();
    const unreferencedEventId = crypto.randomUUID();

    const { error: insertError } = await admin.from('external_calendar_events').insert([
      activeShapeEvent({ id: referencedEventId, connectionId, providerEventId: 'referenced' }),
      activeShapeEvent({
        id: unreferencedEventId,
        connectionId,
        providerEventId: 'unreferenced',
      }),
    ]);
    if (insertError) throw insertError;

    const { error: planError } = await admin.from('plans').insert({
      user_id: userId,
      title: 'Anchored plan',
      start_at: EVENT_START_AT,
      end_at: EVENT_END_AT,
      source: 'external_calendar',
      external_calendar_event_id: referencedEventId,
    });
    if (planError) throw planError;

    await deleteUnreferencedEvents({
      userId,
      connectionId,
      scope: { kind: 'connection' },
    });

    const { data: remaining, error: selectError } = await admin
      .from('external_calendar_events')
      .select('id')
      .eq('connection_id', connectionId);
    if (selectError) throw selectError;

    expect((remaining ?? []).map((row) => row.id)).toEqual([referencedEventId]);

    await admin.from('plans').delete().eq('user_id', userId);
  });

  it('複数バッチにまたがっても 2 ページ目以降の cursor で全件消す', async () => {
    const connectionId = await createConnection();
    // PRUNE_BATCH_SIZE(150) を超える件数で keyset ページングを強制する。
    const eventIds = Array.from({ length: 151 }, () => crypto.randomUUID());

    const { error: insertError } = await admin
      .from('external_calendar_events')
      .insert(
        eventIds.map((id, index) =>
          activeShapeEvent({ id, connectionId, providerEventId: `batch-${index}` }),
        ),
      );
    if (insertError) throw insertError;

    await deleteUnreferencedEvents({
      userId,
      connectionId,
      scope: { kind: 'connection' },
    });

    const { data: remaining, error: selectError } = await admin
      .from('external_calendar_events')
      .select('id')
      .eq('connection_id', connectionId);
    if (selectError) throw selectError;

    expect(remaining).toEqual([]);
  });
});
