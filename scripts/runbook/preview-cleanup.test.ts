import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recoverPreviewUsers } from './preview-cleanup.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const ref = 'tilwaprottpyhlfoggbb';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'preview-cleanup-test-'));
  roots.push(directory);
  mkdirSync(join(directory, 'users'));
  const path = join(directory, 'users', `${userId}.json`);
  writeFileSync(
    path,
    JSON.stringify({ runId, userId, status: 'creation-unconfirmed', ...overrides }),
  );
  const fetchImpl = vi.fn();
  const options = {
    evidenceDirectory: directory,
    runId,
    supabaseProjectRef: ref,
    serviceKey: 'sb_secret_private_test_key',
    fetchImpl,
  };
  return { path, fetchImpl, options };
}
function ownedUser(overrides = {}) {
  return {
    id: userId,
    app_metadata: { e2e_run_id: runId },
    email: `critical-path-${userId}@example.com`,
    ...overrides,
  };
}
const response = (status: number, body = {}) => new Response(JSON.stringify(body), { status });

describe('Preview orphan recovery', () => {
  it('creation responseを失った場合もサーバー側run所有権を確認して削除と不在を検証する', async () => {
    const s = fixture();
    s.fetchImpl
      .mockResolvedValueOnce(response(200, ownedUser()))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(404));
    expect(await recoverPreviewUsers(s.options)).toEqual({
      status: 'clean',
      checked: 1,
      recovered: 1,
    });
    expect(s.fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(s.fetchImpl.mock.calls[1][0]).toBe(
      `https://${ref}.supabase.co/auth/v1/admin/users/${userId}`,
    );
    expect(new Headers(s.fetchImpl.mock.calls[0][1].headers).get('apikey')).toBe(
      'sb_secret_private_test_key',
    );
    expect(new Headers(s.fetchImpl.mock.calls[0][1].headers).get('Authorization')).toBeNull();
    expect(JSON.parse(readFileSync(s.path, 'utf8')).status).toBe('deleted');
    expect(readFileSync(s.path, 'utf8')).not.toContain('sb_secret_private_test_key');
  });
  it.each([
    { id: '33333333-3333-4333-8333-333333333333' },
    { app_metadata: { e2e_run_id: '33333333-3333-4333-8333-333333333333' } },
    { app_metadata: {} },
    { email: 'real-user@example.com' },
  ])('別run・別user・所有権なし・別namespaceを消さない: %j', async (overrides) => {
    const s = fixture();
    s.fetchImpl.mockResolvedValueOnce(response(200, ownedUser(overrides)));
    expect(await recoverPreviewUsers(s.options)).toMatchObject({ status: 'failed', recovered: 0 });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(s.path, 'utf8')).status).toBe('cleanup-failed');
  });
  it('既に削除されたuserはGETで確認し、再削除しない', async () => {
    const s = fixture({ status: 'deleted' });
    s.fetchImpl.mockResolvedValueOnce(response(404));
    expect(await recoverPreviewUsers(s.options)).toEqual({
      status: 'clean',
      checked: 1,
      recovered: 0,
    });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('status更新の一時ファイルが途中でも元journalから不在を確認して回復する', async () => {
    const s = fixture();
    writeFileSync(`${s.path}.tmp`, '{"runId":');
    s.fetchImpl.mockResolvedValueOnce(response(404));
    expect(await recoverPreviewUsers(s.options)).toEqual({
      status: 'clean',
      checked: 1,
      recovered: 0,
    });
    expect(JSON.parse(readFileSync(s.path, 'utf8'))).toMatchObject({
      runId,
      userId,
      status: 'deleted',
    });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('削除応答だけ成功でもuserが残れば失敗する', async () => {
    const s = fixture();
    s.fetchImpl
      .mockResolvedValueOnce(response(200, ownedUser()))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200, ownedUser()));
    expect(await recoverPreviewUsers(s.options)).toMatchObject({ status: 'failed', recovered: 0 });
  });
  it('private provider例外や本文をjournalへ残さない', async () => {
    const s = fixture();
    s.fetchImpl.mockRejectedValueOnce(new Error('sb_secret_private_test_key'));
    expect(await recoverPreviewUsers(s.options)).toMatchObject({ status: 'failed' });
    expect(readFileSync(s.path, 'utf8')).not.toContain('sb_secret_private_test_key');
  });
  it.each([
    { runId: '33333333-3333-4333-8333-333333333333' },
    { userId: '00000000-0000-0000-0000-000000000001' },
    { status: 'unknown' },
  ])('不正journalはリクエスト前に拒否する: %j', async (overrides) => {
    const s = fixture(overrides);
    await expect(recoverPreviewUsers(s.options)).rejects.toThrow('journal is invalid');
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it('ProductionはGETも送らない', async () => {
    const s = fixture();
    await expect(
      recoverPreviewUsers({ ...s.options, supabaseProjectRef: 'yvglwblxrnrenfifsnje' }),
    ).rejects.toThrow('nonproduction');
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it('全体deadlineを過ぎたら追加リクエストせず失敗を記録する', async () => {
    const s = fixture();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(120_001);
    expect(await recoverPreviewUsers({ ...s.options, now })).toMatchObject({
      status: 'failed',
      recovered: 0,
    });
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(s.path, 'utf8')).status).toBe('cleanup-failed');
  });
  it.each([
    { role: 'service_role', ref: 'yvglwblxrnrenfifsnje' },
    { role: 'anon', ref },
  ])('Productionまたは権限違いのJWTを非本番endpointにも送らない: %j', async (claims) => {
    const s = fixture();
    const key =
      'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
    await expect(recoverPreviewUsers({ ...s.options, serviceKey: key })).rejects.toThrow(
      'credential binding',
    );
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});
