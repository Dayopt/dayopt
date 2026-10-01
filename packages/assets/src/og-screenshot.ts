import { Buffer } from 'node:buffer';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { resolveOgScreenshotFilename } from './og';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function hasExpectedHeader(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  }
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    mimeType === 'image/webp' &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/** Load only a small raster file from an app's own `public/og-screenshots` directory. */
export async function loadOgScreenshotDataUri(
  input: string | null | undefined,
  publicDirectory: string,
): Promise<string | undefined> {
  const filename = resolveOgScreenshotFilename(input);
  if (!filename) return undefined;

  const screenshotsDirectory = path.resolve(publicDirectory, 'og-screenshots');
  const filePath = path.resolve(screenshotsDirectory, filename);
  if (!filePath.startsWith(`${screenshotsDirectory}${path.sep}`)) return undefined;

  try {
    const [realPublicDirectory, realDirectory, realFile, fileStats] = await Promise.all([
      realpath(publicDirectory),
      realpath(screenshotsDirectory),
      realpath(filePath),
      lstat(filePath),
    ]);
    if (
      realDirectory !== path.resolve(realPublicDirectory, 'og-screenshots') ||
      !fileStats.isFile() ||
      fileStats.size === 0 ||
      fileStats.size > MAX_SCREENSHOT_BYTES ||
      !realFile.startsWith(`${realDirectory}${path.sep}`)
    ) {
      return undefined;
    }

    const mimeType = MIME_TYPES[path.extname(filename).toLowerCase()];
    if (!mimeType) return undefined;

    const bytes = await readFile(realFile);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) return undefined;
    if (!hasExpectedHeader(bytes, mimeType)) return undefined;

    return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return undefined;
  }
}
