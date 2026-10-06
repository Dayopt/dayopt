import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  POC_ARCHIVE_PATH,
  POC_ORIGINAL_MIGRATION_PATH,
  POC_ORIGINAL_SHA256,
  POC_RETIREMENT_MANIFEST,
  POC_TOMBSTONE_PATH,
  POC_TOMBSTONE_SQL,
  assertPocRetirementContract,
} from './poc-retirement-contract.mjs';

const HISTORICAL_SOURCE_COMMIT = 'd04f80d3fa60f11249d3b64c76526b54d008bb65';
const RETIREMENT_PATH = POC_RETIREMENT_MANIFEST.forwardRetirementMigrationPath;
const ORIGINAL_SQL = (() => {
  try {
    return execFileSync(
      'git',
      ['show', `${HISTORICAL_SOURCE_COMMIT}:${POC_ORIGINAL_MIGRATION_PATH}`],
      { encoding: 'utf8' },
    );
  } catch {
    // The archived file is the durable source after the Phase B branch adds it.
    return readFileSync(POC_ARCHIVE_PATH, 'utf8');
  }
})();

function candidateFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'supabase/migrations/20260101000000_baseline.sql': 'CREATE TABLE public.items (id uuid);\n',
    [POC_TOMBSTONE_PATH]: POC_TOMBSTONE_SQL,
    [POC_ARCHIVE_PATH]: ORIGINAL_SQL,
    [RETIREMENT_PATH]: readFileSync(RETIREMENT_PATH, 'utf8'),
    ...overrides,
  };
}

function baseFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'supabase/migrations/20260101000000_baseline.sql': 'CREATE TABLE public.items (id uuid);\n',
    'apps/product/src/lib/runtime.ts': 'export const ready = true;\n',
    ...overrides,
  };
}

function assertValid(
  base: Record<string, string> = baseFiles(),
  candidate: Record<string, string> = candidateFiles(),
  manifest: Record<string, string> = POC_RETIREMENT_MANIFEST,
) {
  return assertPocRetirementContract({ baseFiles: base, candidateFiles: candidate, manifest });
}

describe('POC retirement contract', () => {
  it('rejects changed forward SQL and runtime reintroduction', () => {
    expect(() =>
      assertValid(
        baseFiles(),
        candidateFiles({ [RETIREMENT_PATH]: 'DROP SCHEMA rate_limit_poc CASCADE;' }),
      ),
    ).toThrow('differs from the reviewed');
    expect(() =>
      assertValid(
        baseFiles(),
        candidateFiles({
          'apps/product/src/lib/reintroduced.ts': "db.rpc('check_supabase_rate_limit_poc');",
        }),
      ),
    ).toThrow('reintroduced');
  });

  it('accepts an already retired baseline without replaying original SQL', () => {
    expect(assertValid(baseFiles({ [POC_TOMBSTONE_PATH]: POC_TOMBSTONE_SQL }))).toBeDefined();
  });

  it('uses the pinned historical SQL bytes and fixed forward migration manifest', () => {
    expect(ORIGINAL_SQL).toHaveLength(18083);
    expect(assertValid()).toMatchObject({
      archivePath: POC_ARCHIVE_PATH,
      archiveSha256: POC_ORIGINAL_SHA256,
      tombstonePath: POC_TOMBSTONE_PATH,
      forwardRetirementMigrationPath: RETIREMENT_PATH,
    });
  });

  it('keeps the old migration version as a canonical no-op while preserving its SQL in the archive', () => {
    const result = assertValid(
      baseFiles({ [POC_ORIGINAL_MIGRATION_PATH]: ORIGINAL_SQL }),
      candidateFiles(),
    );
    expect(result.tombstonePath).toBe(POC_ORIGINAL_MIGRATION_PATH);
  });

  it('rejects a missing or byte-modified historical archive', () => {
    const missing = candidateFiles();
    delete missing[POC_ARCHIVE_PATH];
    expect(() => assertValid(baseFiles(), missing)).toThrow(/archive is missing/);

    expect(() =>
      assertValid(baseFiles(), candidateFiles({ [POC_ARCHIVE_PATH]: `${ORIGINAL_SQL}\n` })),
    ).toThrow(/archive bytes do not match/);
  });

  it('rejects a missing or changed same-version tombstone', () => {
    const missing = candidateFiles();
    delete missing[POC_TOMBSTONE_PATH];
    expect(() => assertValid(baseFiles(), missing)).toThrow(/tombstone is missing or changed/);

    expect(() =>
      assertValid(baseFiles(), candidateFiles({ [POC_TOMBSTONE_PATH]: `${POC_TOMBSTONE_SQL}\n` })),
    ).toThrow(/tombstone is missing or changed/);
  });

  it('requires the manifest-pinned forward retirement SQL and rejects a different path', () => {
    const missing = candidateFiles();
    delete missing[RETIREMENT_PATH];
    expect(() => assertValid(baseFiles(), missing)).toThrow(
      /forward retirement migration is missing/,
    );

    expect(() =>
      assertValid(baseFiles(), candidateFiles(), {
        forwardRetirementMigrationPath: 'supabase/migrations/20261006000000_other.sql',
      }),
    ).toThrow(/manifest must pin forward retirement SQL/);
  });

  it('rejects Phase A runtime imports, flags, and RPC consumers in base files', () => {
    for (const source of [
      "import { isSupabaseRateLimitPocEnabled } from './supabase-poc';",
      'const enabled = process.env.SUPABASE_WEBHOOK_CLAIM_POC_ENABLED;',
      "await supabase.rpc('check_supabase_rate_limit_poc', params);",
    ]) {
      expect(() => assertValid(baseFiles({ 'apps/product/src/lib/runtime.ts': source }))).toThrow(
        /Phase A runtime consumers remain in base files/,
      );
    }
  });

  it('ignores generated types and test-only POC references when checking base runtime consumers', () => {
    expect(
      assertValid(
        baseFiles({
          'apps/product/src/lib/database/generated/database.types.ts':
            'check_supabase_rate_limit_poc: never;',
          'apps/product/src/lib/supabase-poc.test.ts':
            "expect(client.rpc('check_supabase_rate_limit_poc')).toBeDefined();",
          'apps/product/src/lib/__tests__/fixture.ts': 'isSupabaseRateLimitPocEnabled',
        }),
      ).inspectedBaseRuntimeFileCount,
    ).toBe(1);
  });

  it('does not allow unrelated migration edits or removals through the POC exception', () => {
    const edited = baseFiles({
      'supabase/migrations/20260101000000_baseline.sql': 'CREATE TABLE public.items (id text);\n',
    });
    expect(() => assertValid(edited)).toThrow(/unrelated base migration was edited/);

    const missingCandidate = candidateFiles();
    delete missingCandidate['supabase/migrations/20260101000000_baseline.sql'];
    expect(() => assertValid(baseFiles(), missingCandidate)).toThrow(
      /unrelated base migration was removed/,
    );
  });

  it('rejects another candidate migration that recreates any POC object', () => {
    expect(() =>
      assertValid(
        baseFiles(),
        candidateFiles({
          'supabase/migrations/20261006000000_recreate_poc.sql': 'CREATE SCHEMA rate_limit_poc;\n',
        }),
      ),
    ).toThrow(/creates a retired POC object/);
  });
});
