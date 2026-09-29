import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const MAX_ARCHIVE_BYTES = 128 * 1024;

/** The digest must come from the trusted artifact verifier, not from the archive body. */
export function decodeVerifiedPreviewArtifactZip({ archive, digest, kind }) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length < 22 ||
    archive.length > MAX_ARCHIVE_BYTES ||
    typeof digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    `sha256:${createHash('sha256').update(archive).digest('hex')}` !== digest
  )
    throw new Error('Preview artifact archive digest differs');
  return decodePreviewArtifactZip(archive, kind);
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
    throw new Error('Invalid Preview artifact ZIP');
}

function assertExtraFields(buffer, offset, length) {
  const end = offset + length;
  assertRange(buffer, offset, length);
  while (offset < end) {
    assertRange(buffer, offset, 4, end);
    const id = buffer.readUInt16LE(offset);
    const fieldLength = buffer.readUInt16LE(offset + 2);
    if (id === 0x0001 || id === 0x7075 || id === 0x6375)
      throw new Error('Unsupported Preview artifact ZIP extra field');
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
  throw new Error('Invalid Preview artifact ZIP');
}

/** Decode one fixed root-level entry from an already digest-verified archive; never extract files. */
export function decodePreviewArtifactZip(archive, kind) {
  const formats = {
    intent: { name: 'intent.json', maxBytes: 16_384 },
    'public-key': { name: 'public-key.json', maxBytes: 32_768 },
    envelope: { name: 'envelope.json', maxBytes: 49_152 },
  };
  if (typeof kind !== 'string' || !Object.hasOwn(formats, kind))
    throw new Error('Invalid Preview artifact kind');
  const { name, maxBytes } = formats[kind];
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES)
    throw new Error('Invalid Preview artifact ZIP');
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
    throw new Error('Invalid Preview artifact ZIP');

  assertRange(archive, centralOffset, 46, eocdOffset);
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50)
    throw new Error('Invalid Preview artifact ZIP');
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
    !centralName.equals(Buffer.from(name)) ||
    (creatorHost === 0 && (externalAttributes & 0x10) !== 0) ||
    (fileType !== 0 && fileType !== 0o100000) ||
    uncompressedSize < 1 ||
    uncompressedSize > maxBytes ||
    compressedSize < 1 ||
    compressedSize > MAX_ARCHIVE_BYTES
  )
    throw new Error('Unsupported Preview artifact ZIP entry');
  assertExtraFields(archive, nameOffset + nameLength, extraLength);

  assertRange(archive, localOffset, 30, centralOffset);
  if (archive.readUInt32LE(localOffset) !== 0x04034b50)
    throw new Error('Invalid Preview artifact ZIP');
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
    throw new Error('Preview artifact ZIP headers differ');
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
      throw new Error('Preview artifact ZIP headers differ');
  } else {
    if (
      ![0, expectedCrc].includes(localCrc) ||
      ![0, compressedSize].includes(localCompressedSize) ||
      ![0, uncompressedSize].includes(localUncompressedSize)
    )
      throw new Error('Preview artifact ZIP headers differ');
    const descriptorOffset = dataEnd;
    assertRange(archive, descriptorOffset, 12, centralOffset);
    const descriptorLength = centralOffset - descriptorOffset;
    const descriptorHasSignature =
      descriptorLength === 16 && archive.readUInt32LE(descriptorOffset) === 0x08074b50;
    if (descriptorLength !== (descriptorHasSignature ? 16 : 12))
      throw new Error('Invalid Preview artifact ZIP descriptor');
    const descriptorStart = descriptorOffset + (descriptorHasSignature ? 4 : 0);
    assertRange(archive, descriptorStart, 12, centralOffset);
    if (
      archive.readUInt32LE(descriptorStart) !== expectedCrc ||
      archive.readUInt32LE(descriptorStart + 4) !== compressedSize ||
      archive.readUInt32LE(descriptorStart + 8) !== uncompressedSize ||
      descriptorStart + 12 !== centralOffset
    )
      throw new Error('Invalid Preview artifact ZIP descriptor');
  }

  const compressed = archive.subarray(dataOffset, dataEnd);
  let content;
  try {
    content =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: maxBytes,
          });
  } catch {
    throw new Error('Invalid Preview artifact ZIP data');
  }
  if (
    content.length !== uncompressedSize ||
    content.length > maxBytes ||
    crc32(content) !== expectedCrc
  )
    throw new Error('Invalid Preview artifact ZIP checksum');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('Invalid Preview artifact encoding');
  }
}
