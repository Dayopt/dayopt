import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateDatabaseTypes, parseTarget } from './generate-database-types.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'db-types-'));
  roots.push(root);
  const output = join(root, 'apps/product/src/lib/database/generated/database.types.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'export type Database = { existing: true };\n');
  return { root, output };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explicit database type target', () => {
  it.each([
    [],
    ['--target', 'preview'],
    ['--target', 'integration', '--project-ref', 'yvglwblxrnrenfifsnje'],
    ['--target', 'preview', '--project-ref', 'https://example.com'],
    ['--target', 'production', '--project-ref', 'aaaaaaaaaaaaaaaaaaaa'],
    ['--target', 'local', '--target', 'production'],
    ['--linked'],
  ])('rejects missing/ambiguous/production-fallback input: %j', async (...args) => {
    const { root, output } = fixture();
    const before = readFileSync(output, 'utf8');
    const run = vi.fn(() => '');
    await expect(generateDatabaseTypes({ root, args, run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(output, 'utf8')).toBe(before);
  });

  it('keeps production available only as an explicit target', () => {
    expect(parseTarget(['--target', 'production'])).toEqual({
      target: 'production',
      projectRef: 'yvglwblxrnrenfifsnje',
    });
  });

  it.each(['preview', 'integration', 'local'])(
    'generates from exactly the selected %s DB',
    async (target) => {
      const { root, output } = fixture();
      const run = vi.fn(() => 'export type Database = {newColumn:string}');
      const args = ['--target', target];
      if (target !== 'local') args.push('--project-ref', 'aaaaaaaaaaaaaaaaaaaa');
      const result = await generateDatabaseTypes({ root, args, run });
      expect(run).toHaveBeenCalledWith(
        'supabase',
        [
          'gen',
          'types',
          '--lang',
          'typescript',
          ...(target === 'local' ? ['--local'] : ['--project-id', 'aaaaaaaaaaaaaaaaaaaa']),
        ],
        expect.objectContaining({ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      expect(result.changed).toBe(true);
      expect(readFileSync(output, 'utf8')).toContain('newColumn: string');
      expect(readdirSync(dirname(output))).toEqual(['database.types.ts']);
    },
  );

  it.each(['cli', 'empty', 'syntax'])(
    'preserves existing types when %s fails, without echoing CLI output',
    async (failure) => {
      const { root, output } = fixture();
      const before = readFileSync(output, 'utf8');
      const run = () => {
        if (failure === 'cli') throw new Error('secret-should-not-appear');
        return failure === 'empty' ? '' : 'export type Database = { secret-should-not-appear';
      };
      const result = generateDatabaseTypes({ root, args: ['--target', 'local'], run });
      await expect(result).rejects.toThrow();
      await expect(result).rejects.not.toThrow('secret-should-not-appear');
      expect(readFileSync(output, 'utf8')).toBe(before);
      expect(readdirSync(dirname(output))).toEqual(['database.types.ts']);
    },
  );
});
