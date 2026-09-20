/**
 * avatars の object key 制限（#2460）
 *
 * 書き込み policy が先頭のパス要素しか見ていなかったため、`<uid>/` 配下なら任意名で
 * 何個でも置けた（`file_size_limit` は 1 object の上限にすぎない）。RLS を key の形で縛り、
 * 1 ユーザーが作れる object を拡張子ごとの 1 個（最大 5 個）に有界化する。
 *
 * policy の話なので実 DB でしか検証できない。越境（他人のフォルダ）と自分の領域の両方で
 * 1 回ずつ判定させる — ブロック側だけの test は緑が証拠にならない。
 *
 * 実行方法:
 * 1. supabase start
 * 2. USE_LOCAL_DB=true pnpm test:integration
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SUPABASE_URL =
  process.env.USE_LOCAL_DB === 'true'
    ? LOCAL_DB_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_DB_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

/** 最小の PNG（マジックナンバーだけ。MIME は contentType で明示する） */
const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

describe.skipIf(!RUN_LOCAL)('avatars の object key 制限（#2460）', () => {
  let adminSupabase: ReturnType<typeof createClient<Database>>;
  let ownerClient: ReturnType<typeof createClient<Database>>;
  let ownerId: string;
  let otherUserId: string;
  const uploadedKeys: string[] = [];

  async function upload(key: string) {
    uploadedKeys.push(key);
    return ownerClient.storage.from('avatars').upload(key, PNG_BYTES, {
      contentType: 'image/png',
      upsert: true,
    });
  }

  beforeAll(async () => {
    adminSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    ownerId = crypto.randomUUID();
    otherUserId = crypto.randomUUID();
    const email = `avatar-policy-${ownerId}@example.com`;
    const password = 'avatar-policy-password-123';

    for (const [id, address] of [
      [ownerId, email],
      [otherUserId, `avatar-policy-other-${otherUserId}@example.com`],
    ] as const) {
      const { error } = await adminSupabase.auth.admin.createUser({
        id,
        email: address,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(`Failed to create user: ${error.message}`);
    }

    ownerClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await ownerClient.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`Failed to sign in: ${signInError.message}`);
  });

  afterAll(async () => {
    if (!adminSupabase) return;
    if (uploadedKeys.length > 0) {
      await adminSupabase.storage.from('avatars').remove(uploadedKeys);
    }
    for (const id of [ownerId, otherUserId]) {
      if (id) await adminSupabase.auth.admin.deleteUser(id);
    }
  });

  // 正側: アプリが実際に作る key（storage.ts の uploadAvatar）は通り続けること。
  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp'])(
    'アプリが作る <uid>/avatar.%s は許可される',
    async (extension) => {
      const { error } = await upload(`${ownerId}/avatar.${extension}`);

      expect(error).toBeNull();
    },
  );

  // 負側（自分の領域）: 任意名を許すと object 数が青天井になる。
  it.each([
    ['任意のファイル名', 'screenshot-1.png'],
    ['allowlist 外の拡張子', 'avatar.exe'],
    ['拡張子なし', 'avatar'],
    ['二重拡張子', 'avatar.png.exe'],
    ['サブディレクトリ', 'nested/avatar.png'],
  ])('自分のフォルダでも %s は拒否される', async (_label, suffix) => {
    const { error } = await upload(`${ownerId}/${suffix}`);

    expect(error).not.toBeNull();
  });

  // 負側（越境）: 従来からの境界が壊れていないこと。
  it('他ユーザーのフォルダへの upload は拒否される', async () => {
    const { error } = await upload(`${otherUserId}/avatar.png`);

    expect(error).not.toBeNull();
  });

  // 上限の確認: 拡張子ごとに 1 つ = 1 ユーザー最大 5 object。
  it('同じ拡張子への再 upload は既存 object を置き換える（object 数が増えない）', async () => {
    await upload(`${ownerId}/avatar.png`);
    await upload(`${ownerId}/avatar.png`);

    const { data: objects, error } = await adminSupabase.storage.from('avatars').list(ownerId);

    expect(error).toBeNull();
    const names = (objects ?? []).map((object) => object.name).sort();
    expect(names).toEqual(['avatar.gif', 'avatar.jpeg', 'avatar.jpg', 'avatar.png', 'avatar.webp']);
  });
});
