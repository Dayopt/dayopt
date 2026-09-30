import { execFileSync } from 'node:child_process';
import { rm, utimes } from 'node:fs/promises';
import path from 'node:path';

const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');

export async function createDeterministicZip(
  directory: string,
  archiveName: string,
  files: readonly string[],
): Promise<void> {
  await rm(path.join(directory, archiveName), { force: true });
  for (const file of files) {
    await utimes(path.join(directory, file), ZIP_EPOCH, ZIP_EPOCH);
  }
  execFileSync('zip', ['-X', '-q', archiveName, ...files], {
    cwd: directory,
    env: { ...process.env, TZ: 'UTC' },
  });
}
