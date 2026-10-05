import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { verifyPreviewRecoveryTrust } from '../lib/preview-cloud-recovery-trust.mjs';
import { recoverPreviewUsers } from '../runbook/preview-cleanup.mjs';
import { validateCloudIntent } from './preview-cloud-intent.mjs';
import { assertCloudFixtureKey } from './preview-cloud-run.mjs';

const REPO = 'Dayopt/dayopt';
const MAX_ARCHIVE_BYTES = 128 * 1024;
const MAX_INTENT_BYTES = 16 * 1024;
function number(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error();
  return result;
}
function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function safeGhEnv(token, env = process.env) {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'LANG'].flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
    ),
    GH_TOKEN: token,
    GH_HOST: 'github.com',
  };
}
async function downloadIntent({ artifactId, token }) {
  if (!Number.isSafeInteger(artifactId) || artifactId < 1 || !token?.trim()) throw new Error();
  try {
    return execFileSync(
      'gh',
      [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `repos/${REPO}/actions/artifacts/${artifactId}/zip`,
      ],
      {
        env: safeGhEnv(token),
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_ARCHIVE_BYTES,
      },
    );
  } catch {
    throw new Error('Preview recovery artifact download failed');
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertRange(buffer, offset, length, boundary = buffer.length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > boundary ||
    boundary > buffer.length
  )
    throw new Error('Invalid Preview recovery ZIP');
}

function assertExtraFields(buffer, offset, length) {
  const end = offset + length;
  assertRange(buffer, offset, length);
  while (offset < end) {
    assertRange(buffer, offset, 4, end);
    const id = buffer.readUInt16LE(offset);
    const fieldLength = buffer.readUInt16LE(offset + 2);
    if (id === 0x0001 || id === 0x7075 || id === 0x6375)
      throw new Error('Unsupported Preview recovery ZIP extra field');
    offset += 4;
    assertRange(buffer, offset, fieldLength, end);
    offset += fieldLength;
  }
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 > buffer.length) break;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (commentLength !== 0 || offset + 22 !== buffer.length) continue;
    return offset;
  }
  throw new Error('Invalid Preview recovery ZIP');
}

/** Parse one small root-level intent.json from an already digest-verified ZIP. */
export function decodePreviewIntentArtifactZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES)
    throw new Error('Invalid Preview recovery ZIP');
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDiskNumber = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntries !== 1 ||
    totalEntries !== 1 ||
    centralOffset + centralSize !== eocdOffset
  )
    throw new Error('Invalid Preview recovery ZIP');

  assertRange(archive, centralOffset, 46, eocdOffset);
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50)
    throw new Error('Invalid Preview recovery ZIP');
  const madeBy = archive.readUInt16LE(centralOffset + 4);
  const neededVersion = archive.readUInt16LE(centralOffset + 6);
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const diskStart = archive.readUInt16LE(centralOffset + 34);
  const externalAttributes = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const centralHeaderLength = 46 + nameLength + extraLength + commentLength;
  assertRange(archive, centralOffset, centralHeaderLength, eocdOffset);
  const nameOffset = centralOffset + 46;
  const centralName = archive.subarray(nameOffset, nameOffset + nameLength);
  const allowedFlags = 0x080e;
  const creatorHost = madeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  if (
    centralHeaderLength !== centralSize ||
    commentLength !== 0 ||
    diskStart !== 0 ||
    localOffset !== 0 ||
    neededVersion >= 45 ||
    (flags & ~allowedFlags) !== 0 ||
    ![0, 8].includes(method) ||
    (method === 0 && (flags & 0x0006) !== 0) ||
    !centralName.equals(Buffer.from('intent.json')) ||
    (creatorHost === 0 && (externalAttributes & 0x10) !== 0) ||
    (fileType !== 0 && fileType !== 0o100000) ||
    uncompressedSize < 1 ||
    uncompressedSize > MAX_INTENT_BYTES ||
    compressedSize < 1 ||
    compressedSize > MAX_ARCHIVE_BYTES
  )
    throw new Error('Unsupported Preview recovery ZIP entry');
  assertExtraFields(archive, nameOffset + nameLength, extraLength);

  assertRange(archive, localOffset, 30, centralOffset);
  if (archive.readUInt32LE(localOffset) !== 0x04034b50)
    throw new Error('Invalid Preview recovery ZIP');
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localCrc = archive.readUInt32LE(localOffset + 14);
  const localCompressedSize = archive.readUInt32LE(localOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localNameOffset = localOffset + 30;
  assertRange(archive, localNameOffset, localNameLength + localExtraLength, centralOffset);
  const localName = archive.subarray(localNameOffset, localNameOffset + localNameLength);
  if (localFlags !== flags || localMethod !== method || !localName.equals(centralName))
    throw new Error('Preview recovery ZIP headers differ');
  assertExtraFields(archive, localNameOffset + localNameLength, localExtraLength);
  const dataOffset = localNameOffset + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  assertRange(archive, dataOffset, compressedSize, centralOffset);
  const hasDataDescriptor = (flags & 0x0008) !== 0;
  if (!hasDataDescriptor) {
    if (
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      dataEnd !== centralOffset
    )
      throw new Error('Preview recovery ZIP headers differ');
  } else {
    if (
      ![0, expectedCrc].includes(localCrc) ||
      ![0, compressedSize].includes(localCompressedSize) ||
      ![0, uncompressedSize].includes(localUncompressedSize)
    )
      throw new Error('Preview recovery ZIP headers differ');
    const descriptorOffset = dataEnd;
    assertRange(archive, descriptorOffset, 12, centralOffset);
    const descriptorLength = centralOffset - descriptorOffset;
    const descriptorHasSignature =
      descriptorLength === 16 && archive.readUInt32LE(descriptorOffset) === 0x08074b50;
    if (descriptorLength !== (descriptorHasSignature ? 16 : 12))
      throw new Error('Invalid Preview recovery ZIP descriptor');
    const descriptorStart = descriptorOffset + (descriptorHasSignature ? 4 : 0);
    assertRange(archive, descriptorStart, 12, centralOffset);
    if (
      archive.readUInt32LE(descriptorStart) !== expectedCrc ||
      archive.readUInt32LE(descriptorStart + 4) !== compressedSize ||
      archive.readUInt32LE(descriptorStart + 8) !== uncompressedSize ||
      descriptorStart + 12 !== centralOffset
    )
      throw new Error('Invalid Preview recovery ZIP descriptor');
  }

  const compressed = archive.subarray(dataOffset, dataEnd);
  let content;
  try {
    content =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: MAX_INTENT_BYTES,
          });
  } catch {
    throw new Error('Invalid Preview recovery ZIP data');
  }
  if (
    content.length !== uncompressedSize ||
    content.length > MAX_INTENT_BYTES ||
    crc32(content) !== expectedCrc
  )
    throw new Error('Invalid Preview recovery ZIP checksum');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('Invalid Preview recovery intent encoding');
  }
}

/** Download only the small, uniquely named public plan; no platform key is needed. */
export async function prepareCloudRecovery({
  directory,
  sourceRunId,
  sourceAttempt,
  env = process.env,
  fetchImpl = fetch,
  download = downloadIntent,
  decode = decodePreviewIntentArtifactZip,
  verify = verifyPreviewRecoveryTrust,
}) {
  const runId = number(sourceRunId);
  const attempt = number(sourceAttempt);
  if (
    env.GITHUB_REPOSITORY !== REPO ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/integration' ||
    env.GITHUB_WORKFLOW_REF !== `${REPO}/.github/workflows/ci.yml@refs/heads/integration` ||
    env.PREVIEW_MERGED_VALIDATION === 'true' ||
    !env.GITHUB_TOKEN?.trim()
  )
    throw new Error();
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw new Error();
  const data = await response.json();
  if (
    !Array.isArray(data.artifacts) ||
    data.total_count !== data.artifacts.length ||
    data.artifacts.length > 100
  )
    throw new Error();
  const artifacts = data.artifacts.filter(
    (row) => row.name === `preview-intent-${runId}-${attempt}`,
  );
  if (
    artifacts.length !== 1 ||
    artifacts[0].expired !== false ||
    !Number.isSafeInteger(artifacts[0].id) ||
    !Number.isSafeInteger(artifacts[0].size_in_bytes) ||
    artifacts[0].size_in_bytes < 1 ||
    artifacts[0].size_in_bytes > 128 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifacts[0].digest ?? '')
  )
    throw new Error();
  const archive = await download({ artifactId: artifacts[0].id, token: env.GITHUB_TOKEN });
  if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES)
    throw new Error('Preview recovery artifact archive size is invalid');
  const archiveDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (archiveDigest !== artifacts[0].digest)
    throw new Error('Preview recovery artifact digest differs');
  let intent;
  try {
    intent = validateCloudIntent(JSON.parse(decode(archive)));
  } catch {
    throw new Error('Preview recovery intent is invalid');
  }
  const verified = await verify({
    repository: REPO,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    token: env.GITHUB_TOKEN,
    sourceRunId: String(runId),
    sourceAttempt: String(attempt),
    intent,
    fetchImpl,
  });
  if (verified.artifactId !== artifacts[0].id || verified.digest !== artifacts[0].digest)
    throw new Error();
  const result = { intent, artifactId: verified.artifactId, digest: verified.digest };
  mkdirSync(directory, { mode: 0o700, recursive: false });
  writeFileSync(join(directory, 'verified.json'), JSON.stringify(result), {
    mode: 0o600,
    flag: 'wx',
  });
  return result;
}

/** Reuse exact-ID recovery without enumerating or exposing other Auth users. */
export async function recoverCloudIntent({
  intent,
  directory,
  serviceKey,
  authenticate = assertCloudFixtureKey,
  recover = recoverPreviewUsers,
}) {
  const plan = validateCloudIntent(intent);
  await authenticate({ request: plan.request, serviceKey });
  const journal = mkdtempSync(join(directory, 'owned-'));
  mkdirSync(join(journal, 'users'), { mode: 0o700 });
  try {
    for (const userId of Object.values(plan.userIds)) {
      writeFileSync(
        join(journal, 'users', `${userId}.json`),
        JSON.stringify({ runId: plan.runId, userId, status: 'creation-unconfirmed' }),
        { mode: 0o600, flag: 'wx' },
      );
    }
    const result = await recover({
      evidenceDirectory: journal,
      runId: plan.runId,
      supabaseProjectRef: plan.request.supabaseProjectRef,
      serviceKey,
    });
    const users = Object.values(plan.userIds).map((userId) => {
      const row = readJson(join(journal, 'users', `${userId}.json`));
      if (
        row.runId !== plan.runId ||
        row.userId !== userId ||
        !['deleted', 'cleanup-failed'].includes(row.status)
      )
        throw new Error();
      return { userId, status: row.status };
    });
    if (
      !Number.isSafeInteger(result.checked) ||
      result.checked !== Object.keys(plan.userIds).length ||
      !Number.isSafeInteger(result.recovered) ||
      result.recovered < 0 ||
      result.recovered > Object.keys(plan.userIds).length
    )
      throw new Error();
    return {
      status:
        result.status === 'clean' && users.every((user) => user.status === 'deleted')
          ? 'clean'
          : 'failed',
      checked: Object.keys(plan.userIds).length,
      recovered: result.recovered,
      users,
    };
  } finally {
    rmSync(journal, { recursive: true, force: true });
  }
}

export async function executeCloudRecovery({
  directory,
  env = process.env,
  verify = verifyPreviewRecoveryTrust,
  recover = recoverCloudIntent,
}) {
  const saved = readJson(join(directory, 'verified.json'));
  const intent = validateCloudIntent(saved.intent);
  const result = {
    sourceRunId: intent.sourceRunId,
    sourceAttempt: intent.sourceAttempt,
    runId: intent.runId,
    request: intent.request,
    observedAt: new Date().toISOString(),
    status: 'failed',
    cleanupConfirmed: false,
    users: [],
  };
  try {
    const current = await verify({
      repository: env.GITHUB_REPOSITORY,
      eventName: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      token: env.GITHUB_TOKEN,
      sourceRunId: String(intent.sourceRunId),
      sourceAttempt: String(intent.sourceAttempt),
      intent,
    });
    if (current.artifactId !== saved.artifactId || current.digest !== saved.digest)
      throw new Error();
    const cleanup = await recover({ intent, directory, serviceKey: env.SUPABASE_SECRET_KEY });
    result.status = cleanup.status;
    result.cleanupConfirmed = cleanup.status === 'clean';
    result.users = cleanup.users;
  } catch {
    /* Public failure contains neither provider errors nor private values. */
  }
  writeFileSync(join(directory, 'recovery.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  return result;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [operation, directory, ...rest] = process.argv.slice(2);
    if (
      rest.length ||
      !['prepare', 'execute'].includes(operation) ||
      !process.env.RUNNER_TEMP ||
      resolve(directory ?? '') !== join(resolve(process.env.RUNNER_TEMP), 'preview-recovery')
    )
      throw new Error();
    if (operation === 'prepare') {
      await prepareCloudRecovery({
        directory,
        sourceRunId: process.env.PREVIEW_RECOVER_RUN,
        sourceAttempt: process.env.PREVIEW_RECOVER_ATTEMPT,
      });
      console.log('Cloud Preview recovery binding prepared');
    } else {
      const result = await executeCloudRecovery({ directory });
      console.log(
        JSON.stringify({
          sourceRunId: result.sourceRunId,
          sourceAttempt: result.sourceAttempt,
          status: result.status,
        }),
      );
      if (!result.cleanupConfirmed) process.exitCode = 1;
    }
  } catch {
    console.error(
      'Cloud Preview recovery failed; inspect source binding and selected nonproduction credentials',
    );
    process.exitCode = 1;
  }
}
