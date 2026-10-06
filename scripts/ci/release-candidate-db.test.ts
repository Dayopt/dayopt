import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordCandidateDb } from './release-candidate-db.mjs';

const migrationNames = ['20260101000000_initial.sql', '20260102000000_add_table.sql'];
const migrationVersions = migrationNames.map((name) => name.slice(0, 14));
const schemaDump = [
  '-- PostgreSQL database dump',
  '\\restrict first-random-token',
  'CREATE TABLE public.items (id bigint);',
  '\\unrestrict first-random-token',
  '',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-candidate-db-'));
  const migrations = join(root, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });
  for (const [index, name] of migrationNames.entries()) {
    writeFileSync(join(migrations, name), `-- migration ${index + 1}\nSELECT ${index + 1};\n`);
  }
  return root;
}

function mockExec({
  dbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  containers = ['abc123'],
  versions = migrationVersions,
  dump = schemaDump,
}: {
  dbUrl?: string;
  containers?: string[];
  versions?: string[];
  dump?: string;
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === 'supabase') return JSON.stringify({ DB_URL: dbUrl });
    if (command === 'docker' && args[0] === 'ps') return containers.join('\n');
    if (command === 'docker' && args.includes('psql')) return JSON.stringify(versions);
    if (command === 'docker' && args.includes('pg_dump')) return dump;
    throw new Error(`Unexpected injected command: ${command} ${args.join(' ')}`);
  };
  return { exec, calls };
}

function withRoot(run: (root: string) => void) {
  const root = fixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('recordCandidateDb', () => {
  it('rejects a remote DB URL before inspecting containers or reading schema', () => {
    withRoot((root) => {
      const { exec, calls } = mockExec({ dbUrl: 'postgresql://hosted.example:5432/postgres' });

      expect(() => recordCandidateDb({ root, runId: '123', attempt: '2', exec })).toThrow(
        /disposable runner Supabase/,
      );
      expect(calls.map(({ command }) => command)).toEqual(['supabase']);
    });
  });

  it.each([{ containers: [] }, { containers: ['abc123', 'def456'] }])(
    'rejects $containers matching database containers as ambiguous',
    ({ containers }) => {
      withRoot((root) => {
        const { exec, calls } = mockExec({ containers });

        expect(() => recordCandidateDb({ root, runId: '123', attempt: '2', exec })).toThrow(
          /container is ambiguous/,
        );
        expect(calls.some(({ args }) => args.includes('pg_dump'))).toBe(false);
      });
    },
  );

  it('rejects a database whose applied migration set differs from the checked out repository', () => {
    withRoot((root) => {
      const { exec, calls } = mockExec({ versions: [migrationVersions[0]] });

      expect(() => recordCandidateDb({ root, runId: '123', attempt: '2', exec })).toThrow(
        /migration set differs/,
      );
      expect(calls.some(({ args }) => args.includes('pg_dump'))).toBe(false);
    });
  });

  it('rejects a repository with no migration files', () => {
    withRoot((root) => {
      for (const name of migrationNames) rmSync(join(root, 'supabase', 'migrations', name));
      const { exec } = mockExec({ versions: [] });

      expect(() => recordCandidateDb({ root, runId: '123', attempt: '2', exec })).toThrow(
        /migration set differs/,
      );
    });
  });

  it('keeps schema hashes stable when pg_dump changes only its random restrict token', () => {
    withRoot((root) => {
      const first = mockExec({ dump: schemaDump });
      const second = mockExec({
        dump: schemaDump
          .replace('first-random-token', 'another-nonce')
          .replace('first-random-token', 'another-nonce'),
      });

      const before = recordCandidateDb({ root, runId: '123', attempt: '2', exec: first.exec });
      const after = recordCandidateDb({ root, runId: '123', attempt: '2', exec: second.exec });

      expect(before.schemaHash).toBe(after.schemaHash);
      expect(before.migrationHash).toBe(after.migrationHash);
      expect(first.calls.some(({ args }) => args.includes('--schema=public'))).toBe(true);
      expect(first.calls.some(({ args }) => args.includes('--schema=storage'))).toBe(true);
    });
  });

  it('changes the schema hash when the inspected schema changes', () => {
    withRoot((root) => {
      const before = recordCandidateDb({
        root,
        runId: '123',
        attempt: '2',
        exec: mockExec({ dump: schemaDump }).exec,
      });
      const after = recordCandidateDb({
        root,
        runId: '123',
        attempt: '2',
        exec: mockExec({ dump: `${schemaDump}\nCREATE INDEX items_id_idx ON public.items (id);\n` })
          .exec,
      });

      expect(after.schemaHash).not.toBe(before.schemaHash);
    });
  });

  it('changes the migration hash when a migration file byte changes', () => {
    withRoot((root) => {
      const before = recordCandidateDb({
        root,
        runId: '123',
        attempt: '2',
        exec: mockExec().exec,
      });
      writeFileSync(join(root, 'supabase', 'migrations', migrationNames[0]), '-- changed bytes\n');
      const after = recordCandidateDb({
        root,
        runId: '123',
        attempt: '2',
        exec: mockExec().exec,
      });

      expect(after.migrationHash).not.toBe(before.migrationHash);
    });
  });

  it('hashes the migration names and bytes in a deterministic order', () => {
    withRoot((root) => {
      const evidence = recordCandidateDb({
        root,
        runId: '123',
        attempt: '2',
        exec: mockExec().exec,
      });
      const expected = createHash('sha256');
      for (const [index, name] of migrationNames.entries()) {
        expected
          .update(name)
          .update('\0')
          .update(`-- migration ${index + 1}\nSELECT ${index + 1};\n`)
          .update('\0');
      }

      expect(evidence.migrationHash).toBe(expected.digest('hex'));
      expect(evidence.identity).toBe('runner:abc123:123:2');
      expect(evidence.observedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    });
  });
});
