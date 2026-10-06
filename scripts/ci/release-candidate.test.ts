import { describe, expect, it, vi } from 'vitest';

import {
  CANDIDATE_SUITES,
  POC_MIGRATION_ACTIVE_SHA256,
  POC_MIGRATION_PATH,
  POC_MIGRATION_TOMBSTONE,
  assertCandidate,
  assertCandidatePocMigrationRetired,
  assertCandidateStart,
  createCandidate,
  isTrustedCandidateWorkflowPath,
  pinCandidate,
} from './release-candidate.mjs';

const sha = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const mainSha = 'c'.repeat(40);
const mainTree = 'd'.repeat(40);
const migrationHash = 'e'.repeat(64);
const schemaHash = 'f'.repeat(64);
const capturedAt = '2026-10-05T01:00:00.000Z';
const observedAt = '2026-10-05T01:01:00.000Z';
const now = '2026-10-05T02:00:00.000Z';
const runId = '12345';
const attempt = '2';

const db = {
  identity: `runner:${runId}:${attempt}`,
  migrationHash,
  schemaHash,
  observedAt,
};

const candidateInput = {
  sha,
  tree,
  mainSha,
  mainTree,
  runId,
  attempt,
  capturedAt,
  db,
};

const candidate = () => createCandidate(candidateInput);

const results = () => Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success']));

const currentDb = () => ({ identity: db.identity, migrationHash, schemaHash });

const run = () => ({
  id: Number(runId),
  run_attempt: Number(attempt),
  head_sha: mainSha,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/release-candidate.yml',
});

const assertInput = (overrides: Record<string, unknown> = {}) =>
  assertCandidate({
    candidate: candidate(),
    results: results(),
    currentMainSha: mainSha,
    actualTree: tree,
    currentDb: currentDb(),
    now,
    maxAgeSeconds: 24 * 60 * 60,
    run: run(),
    ...overrides,
  });

describe('release candidate contract', () => {
  it('declares the complete candidate suite set', () => {
    expect(CANDIDATE_SUITES).toEqual([
      'unit',
      'integration',
      'db_upgrade',
      'e2e',
      'web',
      'storybook',
    ]);
  });

  it('captures the candidate inputs and its database state', () => {
    expect(candidate()).toEqual({ version: 1, ...candidateInput });
  });

  it.each([
    ['candidate sha', { sha: 'abc' }],
    ['candidate tree', { tree: 'g'.repeat(40) }],
    ['main sha', { mainSha: '123' }],
    ['main tree', { mainTree: 'h'.repeat(40) }],
    ['run id', { runId: '0' }],
    ['run attempt', { attempt: '1.5' }],
    ['capture time', { capturedAt: 'yesterday' }],
    ['database identity', { db: { ...db, identity: '   ' } }],
    ['database run binding', { db: { ...db, identity: 'runner:12345:1' } }],
    ['database migration hash', { db: { ...db, migrationHash: 'bad' } }],
    ['database schema hash', { db: { ...db, schemaHash: 'g'.repeat(64) } }],
    ['database observation time', { db: { ...db, observedAt: 'unknown' } }],
    [
      'database observation before capture',
      { db: { ...db, observedAt: '2026-10-05T00:59:59.000Z' } },
    ],
  ])('rejects invalid %s when creating a candidate', (_label, override) => {
    expect(() => createCandidate({ ...candidateInput, ...override })).toThrow();
  });

  it('accepts a fresh candidate when every required suite and source run succeeded', () => {
    expect(assertInput()).toEqual(candidate());
  });

  it('accepts the REST path with @main while keeping other refs and workflows untrusted', () => {
    expect(isTrustedCandidateWorkflowPath('.github/workflows/release-candidate.yml')).toBe(true);
    expect(isTrustedCandidateWorkflowPath('.github/workflows/release-candidate.yml@main')).toBe(
      true,
    );
    expect(
      isTrustedCandidateWorkflowPath('.github/workflows/release-candidate.yml@integration'),
    ).toBe(false);
    expect(
      isTrustedCandidateWorkflowPath('.github/workflows/release-candidate.yml@refs/heads/main'),
    ).toBe(false);
    expect(isTrustedCandidateWorkflowPath('.github/workflows/nightly.yml@main')).toBe(false);
    expect(
      assertInput({ run: { ...run(), path: '.github/workflows/release-candidate.yml@main' } }),
    ).toEqual(candidate());
  });

  it.each(CANDIDATE_SUITES)('holds the candidate when suite %s is missing', (suite) => {
    const incompleteResults = results();
    delete incompleteResults[suite];
    expect(() => assertInput({ results: incompleteResults })).toThrow();
  });

  it.each(['failure', 'cancelled', 'skipped', 'pending', ''])(
    'holds the candidate when a suite result is %s',
    (status) => {
      expect(() => assertInput({ results: { ...results(), e2e: status } })).toThrow();
    },
  );

  it('holds the candidate when an unexpected suite result is present', () => {
    expect(() => assertInput({ results: { ...results(), lint: 'success' } })).toThrow();
  });

  it('holds the candidate when its result evidence is stale', () => {
    expect(() =>
      assertInput({ now: '2026-10-06T01:00:01.000Z', maxAgeSeconds: 24 * 60 * 60 }),
    ).toThrow();
  });

  it('holds the candidate when the clock precedes candidate capture', () => {
    expect(() => assertInput({ now: '2026-10-05T00:59:59.000Z' })).toThrow();
  });

  it('holds when database state was observed after the candidate verification time', () => {
    const futureDb = createCandidate({
      ...candidateInput,
      db: { ...db, observedAt: '2026-10-05T02:00:01.000Z' },
    });

    expect(() => assertInput({ candidate: futureDb, now: Date.parse(now) })).toThrow();
  });

  it('requires a positive integer evidence age limit', () => {
    for (const maxAgeSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertInput({ maxAgeSeconds })).toThrow();
    }
  });

  it('holds if main moved after candidate capture, including a hotfix', () => {
    expect(() => assertInput({ currentMainSha: '9'.repeat(40) })).toThrow();
  });

  it('holds if the tree to be promoted differs from the tested candidate', () => {
    expect(() => assertInput({ actualTree: '8'.repeat(40) })).toThrow();
  });

  it.each([
    ['database identity', { identity: 'other-preview-db' }],
    ['migration state', { migrationHash: '1'.repeat(64) }],
    ['schema state', { schemaHash: '2'.repeat(64) }],
  ])('holds when current %s differs from captured state', (_label, change) => {
    expect(() => assertInput({ currentDb: { ...currentDb(), ...change } })).toThrow();
  });

  it.each([
    ['run id', { id: 12346 }],
    ['run attempt', { run_attempt: 1 }],
    ['source SHA', { head_sha: '7'.repeat(40) }],
    ['source branch', { head_branch: 'integration' }],
    ['workflow path', { path: '.github/workflows/nightly.yml' }],
    ['run status', { status: 'in_progress' }],
    ['run conclusion', { conclusion: 'failure' }],
  ])('holds when the workflow run has mismatched %s', (_label, change) => {
    expect(() => assertInput({ run: { ...run(), ...change } })).toThrow();
  });
});

describe('release candidate start window', () => {
  it('allows a manual dispatch regardless of schedule configuration', () => {
    expect(() =>
      assertCandidateStart({
        eventName: 'workflow_dispatch',
        schedule: undefined,
        now,
        maxDelaySeconds: undefined,
      }),
    ).not.toThrow();
  });

  it('accepts a daily UTC run within the approved delay', () => {
    expect(() =>
      assertCandidateStart({
        eventName: 'schedule',
        schedule: '30 19 * * *',
        now: '2026-10-05T19:40:00.000Z',
        maxDelaySeconds: 600,
      }),
    ).not.toThrow();
  });

  it('rejects a daily UTC run after the approved delay', () => {
    expect(() =>
      assertCandidateStart({
        eventName: 'schedule',
        schedule: '30 19 * * *',
        now: '2026-10-05T19:40:01.000Z',
        maxDelaySeconds: 600,
      }),
    ).toThrow(/started too late/);
  });

  it('uses the previous UTC day after midnight when checking a delayed schedule', () => {
    expect(() =>
      assertCandidateStart({
        eventName: 'schedule',
        schedule: '30 19 * * *',
        now: '2026-10-06T00:00:00.000Z',
        maxDelaySeconds: 4 * 60 * 60,
      }),
    ).toThrow(/started too late/);
  });

  it.each([
    ['timezone suffix', '30 19 * * * Asia/Tokyo', 600],
    ['invalid minute', '60 19 * * *', 600],
    ['invalid hour', '30 24 * * *', 600],
    ['missing delay limit', '30 19 * * *', undefined],
    ['one-day delay limit', '30 19 * * *', 86400],
    ['fractional delay limit', '30 19 * * *', 600.5],
  ])('rejects invalid %s configuration', (_label, schedule, maxDelaySeconds) => {
    expect(() =>
      assertCandidateStart({
        eventName: 'schedule',
        schedule,
        now: '2026-10-05T19:35:00.000Z',
        maxDelaySeconds,
      }),
    ).toThrow();
  });
});

describe('Production candidate POC migration blocker', () => {
  const entryFor = (contents: string) => {
    const object = 'f'.repeat(40);
    return {
      gitImpl: (...args: string[]) => {
        expect(args).toEqual(['ls-tree', sha, '--', POC_MIGRATION_PATH]);
        return `100644 blob ${object}\t${POC_MIGRATION_PATH}`;
      },
      readBlob: (actualObject: string) => {
        expect(actualObject).toBe(object);
        return Buffer.from(contents);
      },
    };
  };

  it('allows a candidate without the experimental migration', () => {
    expect(() =>
      assertCandidatePocMigrationRetired({
        candidateSha: sha,
        gitImpl: () => '',
      }),
    ).not.toThrow();
  });

  it('rejects the original active migration by its known content hash', () => {
    const entry = entryFor('original active migration bytes');
    expect(() =>
      assertCandidatePocMigrationRetired({
        candidateSha: sha,
        ...entry,
        hashContents: () => POC_MIGRATION_ACTIVE_SHA256,
      }),
    ).toThrow(/canonical retired tombstone/);
  });

  it('allows only the exact canonical tombstone with its final newline', () => {
    expect(() =>
      assertCandidatePocMigrationRetired({
        candidateSha: sha,
        ...entryFor(POC_MIGRATION_TOMBSTONE),
      }),
    ).not.toThrow();
    expect(() =>
      assertCandidatePocMigrationRetired({
        candidateSha: sha,
        ...entryFor(POC_MIGRATION_TOMBSTONE.trimEnd()),
      }),
    ).toThrow(/canonical retired tombstone/);
  });

  it('applies the POC blocker while pinning the integration SHA', () => {
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_EVENT_PATH', '');

    const calls: string[][] = [];
    const gitImpl = (...args: string[]) => {
      calls.push(args);
      if (args[0] === 'ls-tree') {
        const object = 'f'.repeat(40);
        return `100644 blob ${object}\t${POC_MIGRATION_PATH}`;
      }
      if (args[0] === 'rev-parse') return tree;
      return '';
    };

    try {
      expect(() =>
        pinCandidate({
          repository: 'Dayopt/dayopt',
          runId,
          attempt,
          controlSha: mainSha,
          now: () => capturedAt,
          api: (path: string) => ({ object: { sha: path.endsWith('main') ? mainSha : sha } }),
          gitImpl,
          readBlob: () => Buffer.from(POC_MIGRATION_TOMBSTONE),
          hashContents: () => POC_MIGRATION_ACTIVE_SHA256,
        }),
      ).toThrow(/canonical retired tombstone/);
      expect(calls).toContainEqual(['ls-tree', sha, '--', POC_MIGRATION_PATH]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['edited tombstone', `${POC_MIGRATION_TOMBSTONE}-- edited\n`],
    ['changed POC DDL', 'CREATE TABLE public.rate_limit_poc(id integer);\n'],
  ])('rejects %s', (_label, contents) => {
    expect(() =>
      assertCandidatePocMigrationRetired({
        candidateSha: sha,
        ...entryFor(contents),
      }),
    ).toThrow(/canonical retired tombstone/);
  });
});
