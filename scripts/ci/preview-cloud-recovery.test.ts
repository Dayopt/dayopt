import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverPreviewUsers } from '../runbook/preview-cleanup.mjs';
import { createCloudIntent } from './preview-cloud-intent.mjs';
import {
  decodePreviewIntentArtifactZip,
  executeCloudRecovery,
  prepareCloudRecovery,
  recoverCloudIntent,
} from './preview-cloud-recovery.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const env = {
  GITHUB_REPOSITORY: 'Dayopt/dayopt',
  GITHUB_REF: 'refs/heads/integration',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_TOKEN: 'PRIVATE_GITHUB_TOKEN',
  GITHUB_WORKFLOW_REF: 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration',
  GITHUB_RUN_ID: '36405214644',
  GITHUB_RUN_ATTEMPT: '1',
  SUPABASE_SECRET_KEY: 'PRIVATE_SUPABASE_KEY',
};
const request = {
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_safe123',
  prNumber: 2949,
  branchName: 'codex/candidate',
  databaseMode: 'shared',
  supabaseProjectRef: 'tilwaprottpyhlfoggbb',
  supabaseBranchId: '4c2ed092-cba3-4f37-98e1-78f61cdf52ed',
};
const intent = createCloudIntent({ request, env });
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function createZip(
  entries: Array<{ name: string; data: Buffer | string; flags?: number; mode?: number }>,
) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const name = Buffer.from(entry.name);
    const method = 8;
    const flags = entry.flags ?? 0x0008;
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if ((flags & 0x0008) === 0) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc((flags & 0x0008) === 0 ? 0 : 16);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    locals.push(local, name, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
const intentJson = Buffer.from(JSON.stringify(intent));
const intentArchive = createZip([{ name: 'intent.json', data: intentJson }]);
const artifactDigest = `sha256:${createHash('sha256').update(intentArchive).digest('hex')}`;
const proof = { intent, artifactId: 789, digest: artifactDigest };
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'preview-recovery-test-'));
  roots.push(root);
  return root;
}
function prepare() {
  const directory = join(temp(), 'recovery');
  const artifacts = {
    total_count: 1,
    artifacts: [
      {
        id: proof.artifactId,
        name: `preview-intent-${intent.sourceRunId}-1`,
        expired: false,
        size_in_bytes: intentJson.length,
        digest: artifactDigest,
      },
    ],
  };
  const fetchImpl = vi.fn(
    async (..._args: unknown[]) => new Response(JSON.stringify(artifacts), { status: 200 }),
  );
  const download = vi.fn(async () => Buffer.from(intentArchive));
  const verify = vi.fn(async () => proof);
  return {
    directory,
    sourceRunId: String(intent.sourceRunId),
    sourceAttempt: '1',
    env,
    fetchImpl,
    download,
    verify,
    artifacts,
  };
}
describe('Cloud recovery plan intake', () => {
  it('retrieves only the uniquely named public intent and rechecks its immutable metadata', async () => {
    const s = prepare();
    expect(await prepareCloudRecovery(s)).toEqual(proof);
    expect(s.download).toHaveBeenCalledWith({
      artifactId: proof.artifactId,
      token: env.GITHUB_TOKEN,
    });
    expect(s.fetchImpl.mock.calls[0][0]).toContain(
      `/actions/runs/${intent.sourceRunId}/artifacts?per_page=100`,
    );
    expect(
      JSON.stringify(JSON.parse(readFileSync(join(s.directory, 'verified.json'), 'utf8'))),
    ).not.toContain('PRIVATE_');
  });
  it.each(['1;echo TOKEN', '0', '9007199254740992'])(
    'rejects malformed source input before download: %s',
    async (value) => {
      const s = prepare();
      await expect(prepareCloudRecovery({ ...s, sourceRunId: value })).rejects.toThrow();
      expect(s.fetchImpl).not.toHaveBeenCalled();
      expect(s.download).not.toHaveBeenCalled();
    },
  );
  it.each(['expired', 'oversize', 'partial', 'duplicate'])(
    'refuses unsafe archive metadata before extraction: %s',
    async (mode) => {
      const s = prepare();
      if (mode === 'expired') s.artifacts.artifacts[0].expired = true;
      if (mode === 'oversize') s.artifacts.artifacts[0].size_in_bytes = 129 * 1024;
      if (mode === 'partial') s.artifacts.total_count = 2;
      if (mode === 'duplicate') {
        s.artifacts.artifacts.push({ ...s.artifacts.artifacts[0] });
        s.artifacts.total_count = 2;
      }
      await expect(prepareCloudRecovery(s)).rejects.toThrow();
      expect(s.download).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed artifact identity before publishing a verified plan', async () => {
    const s = prepare();
    s.verify.mockResolvedValueOnce({ ...proof, artifactId: 790 });
    await expect(prepareCloudRecovery(s)).rejects.toThrow();
    expect(() => readFileSync(join(s.directory, 'verified.json'), 'utf8')).toThrow();
  });
  it('verifies the exact raw archive digest before invoking the ZIP decoder', async () => {
    const s = prepare();
    const corrupt = Buffer.from(intentArchive);
    corrupt[30 + Buffer.byteLength('intent.json')] ^= 0x80;
    s.download.mockResolvedValueOnce(corrupt);
    const decode = vi.fn(decodePreviewIntentArtifactZip);
    await expect(prepareCloudRecovery({ ...s, decode })).rejects.toThrow(
      'Preview recovery artifact digest differs',
    );
    expect(decode).not.toHaveBeenCalled();
    expect(s.verify).not.toHaveBeenCalled();
  });
  it('rejects a correctly hashed but corrupt ZIP before trusting its intent', async () => {
    const s = prepare();
    const corrupt = Buffer.from(intentArchive);
    corrupt[30 + Buffer.byteLength('intent.json')] ^= 0x80;
    const corruptDigest = `sha256:${createHash('sha256').update(corrupt).digest('hex')}`;
    s.artifacts.artifacts[0].digest = corruptDigest;
    s.download.mockResolvedValueOnce(corrupt);
    await expect(prepareCloudRecovery(s)).rejects.toThrow('Preview recovery intent is invalid');
    expect(s.verify).not.toHaveBeenCalled();
  });
  it('decodes a valid streamed ZIP data descriptor without extracting files', () => {
    expect(decodePreviewIntentArtifactZip(intentArchive)).toBe(intentJson.toString('utf8'));
  });
  it.each([
    [
      'corrupt deflate payload',
      (() => {
        const buffer = Buffer.from(intentArchive);
        buffer[30 + Buffer.byteLength('intent.json')] ^= 0x80;
        return buffer;
      })(),
    ],
    ['traversal path', createZip([{ name: '../intent.json', data: intentJson }])],
    ['symlink entry', createZip([{ name: 'intent.json', data: intentJson, mode: 0o120777 }])],
    ['encrypted entry', createZip([{ name: 'intent.json', data: intentJson, flags: 0x0009 }])],
    [
      'extra archive entry',
      createZip([
        { name: 'intent.json', data: intentJson },
        { name: 'extra.txt', data: 'extra' },
      ]),
    ],
    [
      'oversized uncompressed entry',
      createZip([{ name: 'intent.json', data: Buffer.alloc(16_385) }]),
    ],
    ['oversized raw archive', Buffer.alloc(128 * 1024 + 1)],
  ])('refuses %s', (_label, archive) => {
    expect(() => decodePreviewIntentArtifactZip(archive)).toThrow();
  });
});
describe('Cloud recovery after worker loss', () => {
  it('repeats recovery from the durable intent without touching another run', async () => {
    const foreignId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const foreignUser = {
      id: foreignId,
      email: `critical-path-${foreignId}@example.com`,
      app_metadata: { e2e_run_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    };
    const users = new Map([
      [
        intent.userIds.desktop,
        {
          id: intent.userIds.desktop,
          email: `critical-path-${intent.userIds.desktop}@example.com`,
          app_metadata: { e2e_run_id: intent.runId },
        },
      ],
      [foreignId, foreignUser],
    ]);
    const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      const userId = url.pathname.split('/').at(-1)!;
      if (!Object.values(intent.userIds).includes(userId)) throw new Error('unexpected user');
      if (options?.method === 'DELETE') {
        users.delete(userId);
        return new Response('{}', { status: 200 });
      }
      const user = users.get(userId);
      return new Response(JSON.stringify(user ?? {}), { status: user ? 200 : 404 });
    });
    const authenticate = vi.fn(async () => undefined);
    const recover = (options: {
      evidenceDirectory: string;
      runId: string;
      supabaseProjectRef: string;
      serviceKey: string;
    }) => recoverPreviewUsers({ ...options, fetchImpl });
    const first = await recoverCloudIntent({
      intent,
      directory: temp(),
      serviceKey: 'sb_secret_dummy',
      authenticate,
      recover,
    });
    expect(first).toMatchObject({ status: 'clean', checked: 2, recovered: 1 });
    expect(first.users.every((user) => user.status === 'deleted')).toBe(true);
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(1);
    expect(users.get(foreignId)).toEqual(foreignUser);

    fetchImpl.mockClear();
    const second = await recoverCloudIntent({
      intent,
      directory: temp(),
      serviceKey: 'sb_secret_dummy',
      authenticate,
      recover,
    });
    expect(second).toMatchObject({ status: 'clean', checked: 2, recovered: 0 });
    expect(second.users.every((user) => user.status === 'deleted')).toBe(true);
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(fetchImpl.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect([...users.entries()]).toEqual([[foreignId, foreignUser]]);
  });
  it('recovers partial creation without the lost journal, using only two precommitted IDs', async () => {
    const directory = temp();
    const authenticate = vi.fn(async () => undefined);
    let desktopDeleted = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(`/users/${intent.userIds.mobile}`))
        return new Response('{}', { status: 404 });
      if (!url.endsWith(`/users/${intent.userIds.desktop}`)) throw new Error('unexpected user');
      if (options?.method === 'DELETE') {
        desktopDeleted = true;
        return new Response('{}', { status: 200 });
      }
      if (desktopDeleted) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({
          id: intent.userIds.desktop,
          email: `critical-path-${intent.userIds.desktop}@example.com`,
          app_metadata: { e2e_run_id: intent.runId },
        }),
        { status: 200 },
      );
    });
    const result = await recoverCloudIntent({
      intent,
      directory,
      serviceKey: 'sb_secret_dummy',
      authenticate,
      recover: (options) => recoverPreviewUsers({ ...options, fetchImpl }),
    });
    expect(result).toMatchObject({ status: 'clean', checked: 2, recovered: 1 });
    expect(result.users.every((user) => user.status === 'deleted')).toBe(true);
    expect(
      fetchImpl.mock.calls.every((call) =>
        Object.values(intent.userIds).some((id) => String(call[0]).endsWith(`/users/${id}`)),
      ),
    ).toBe(true);
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('example.com');
  });
  it('performs no recovery if the selected key fails authentication', async () => {
    const recover = vi.fn();
    await expect(
      recoverCloudIntent({
        intent,
        directory: temp(),
        serviceKey: 'PRIVATE',
        authenticate: vi.fn(async () => {
          throw new Error('PRIVATE_PROVIDER_BODY');
        }),
        recover,
      }),
    ).rejects.toThrow();
    expect(recover).not.toHaveBeenCalled();
  });
  it('source revalidation failure publishes failure and never calls Auth recovery', async () => {
    const directory = temp();
    writeFileSync(join(directory, 'verified.json'), JSON.stringify(proof));
    const recover = vi.fn();
    const verify = vi.fn(async () => {
      throw new Error('PRIVATE_PROVIDER_BODY');
    });
    const result = await executeCloudRecovery({ directory, env, recover, verify });
    expect(result).toMatchObject({ status: 'failed', cleanupConfirmed: false, users: [] });
    expect(recover).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'recovery.json'), 'utf8')).not.toContain('PRIVATE_');
  });
});
