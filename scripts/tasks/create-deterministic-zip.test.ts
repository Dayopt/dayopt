import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDeterministicZip } from './create-deterministic-zip';

describe('createDeterministicZip', () => {
  it('keeps the archive bytes stable when identical inputs have different modification times', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dayopt-brand-zip-'));
    const source = path.join(directory, 'asset.svg');
    const archive = path.join(directory, 'brand.zip');

    try {
      await writeFile(source, '<svg></svg>');
      const firstTime = new Date('2020-01-01T00:00:00Z');
      const secondTime = new Date('2024-01-01T00:00:00Z');

      await utimes(source, firstTime, firstTime);
      await createDeterministicZip(directory, 'brand.zip', ['asset.svg']);
      const firstArchive = await readFile(archive);

      await utimes(source, secondTime, secondTime);
      await createDeterministicZip(directory, 'brand.zip', ['asset.svg']);

      expect(await readFile(archive)).toEqual(firstArchive);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
