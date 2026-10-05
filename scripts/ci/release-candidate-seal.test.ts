import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_SUITES,
  hashCandidateMigrations,
  sealCandidateEvidence,
} from './release-candidate.mjs';

const repository = 'Dayopt/dayopt';
const runId = '12345';
const attempt = '2';
const mainSha = 'a'.repeat(40);
const mainTree = 'b'.repeat(40);
const candidateSha = 'c'.repeat(40);
const candidateTree = 'd'.repeat(40);
const controlRoot = '/trusted/control';
const candidateRoot = '/candidate/source';
const now = '2026-10-05T02:00:00.000Z';
const migrationFiles = new Map([
  ['20261001000000_alpha.sql', Buffer.from('CREATE TABLE alpha (id int);\n')],
  ['20261002000000_beta.sql', Buffer.from('CREATE TABLE beta (id int);\n')],
]);

const blobId = (contents: Buffer) => createHash('sha1').update(contents).digest('hex');
const entries = [...migrationFiles.entries()]
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .map(([name, contents]) => `100644 blob ${blobId(contents)}\tsupabase/migrations/${name}\0`)
  .join('');

const migrationHash = () => {
  const hash = createHash('sha256');
  for (const [name, contents] of [...migrationFiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
    hash.update(name).update('\0').update(contents).update('\0');
  return hash.digest('hex');
};

const pin = () => ({
  sha: candidateSha,
  tree: candidateTree,
  mainSha,
  mainTree,
  runId,
  attempt,
  capturedAt: '2026-10-05T01:00:00.000Z',
});

const snapshot = (at: string, overrides: Record<string, unknown> = {}) => ({
  identity: `runner:abc123:${runId}:${attempt}`,
  migrationHash: migrationHash(),
  schemaHash: 'e'.repeat(64),
  observedAt: at,
  ...overrides,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  id: Number(runId),
  run_attempt: Number(attempt),
  repository: { full_name: repository },
  head_branch: 'main',
  head_sha: mainSha,
  path: '.github/workflows/release-candidate.yml@main',
  event: 'workflow_dispatch',
  status: 'in_progress',
  ...overrides,
});

const stepNames: Record<string, string> = {
  unit: 'Full unit and workspace tests',
  integration: 'Full integration and RLS tests',
  db_upgrade: 'Rehearse the pinned main to candidate migration upgrade',
  e2e: 'Full Product E2E',
  web: 'Web build and E2E',
  storybook: 'Storybook light and dark',
};

const verifyJob = (overrides: Record<string, unknown> = {}) => ({
  name: 'verify',
  run_id: Number(runId),
  run_attempt: Number(attempt),
  head_sha: mainSha,
  status: 'completed',
  conclusion: 'success',
  steps: CANDIDATE_SUITES.map((suite) => ({
    name: stepNames[suite],
    status: 'completed',
    conclusion: 'success',
  })),
  ...overrides,
});

function fixture({
  runOverrides = {},
  jobs = [verifyJob()],
  before = snapshot('2026-10-05T01:01:00.000Z'),
  after = snapshot('2026-10-05T01:02:00.000Z'),
}: {
  runOverrides?: Record<string, unknown>;
  jobs?: Record<string, unknown>[];
  before?: unknown;
  after?: unknown;
} = {}) {
  const blobs = new Map(
    [...migrationFiles.values()].map((contents) => [blobId(contents), contents]),
  );
  const git = (root: string, ...args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD')
      return root === controlRoot ? mainSha : candidateSha;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}')
      return root === controlRoot ? mainTree : candidateTree;
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'ls-tree') return entries;
    throw new Error(`Unexpected git call: ${root} ${args.join(' ')}`);
  };
  const seal = (overrides: Record<string, unknown> = {}) =>
    sealCandidateEvidence({
      pin: pin(),
      dbBefore: before,
      dbAfter: after,
      run: run(runOverrides),
      jobsResponse: { total_count: jobs.length, jobs },
      repository,
      runId,
      attempt,
      controlRoot,
      candidateRoot,
      maxAgeSeconds: 3600,
      now,
      gitImpl: git,
      readBlob: (object: string) => {
        const contents = blobs.get(object);
        if (!contents) throw new Error(`Unexpected blob ${object}`);
        return contents;
      },
      ...overrides,
    });
  return { seal };
}

describe('trusted candidate evidence seal', () => {
  it('hashes only migration blobs from the pinned Git tree without following filesystem paths', () => {
    const fixture = new Map(
      [...migrationFiles.values()].map((contents) => [blobId(contents), contents]),
    );
    const hash = hashCandidateMigrations({
      candidateRoot,
      gitImpl: (_root: string, ...args: string[]) => {
        expect(args).toEqual(['ls-tree', '-rz', 'HEAD', '--', 'supabase/migrations']);
        return entries;
      },
      readBlob: (object: string) => {
        const contents = fixture.get(object);
        if (!contents) throw new Error(`Unexpected blob ${object}`);
        return contents;
      },
    });

    expect(hash).toBe(migrationHash());
  });

  it('seals explicit suite results from the exact GitHub verify job and matched migration bytes', () => {
    const { seal } = fixture();
    const evidence = seal();

    expect(evidence.version).toBe(2);
    expect(evidence.results).toEqual(
      Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success'])),
    );
    expect(evidence.candidate.db.migrationHash).toBe(migrationHash());
    expect(evidence.databaseEvidence).toEqual({
      source: 'verification-runner-report',
      migrationContentMatched: true,
    });
  });

  it('rejects worker claims of success when GitHub records a red suite step', () => {
    const steps = verifyJob().steps.map((step) =>
      step.name === stepNames.unit ? { ...step, conclusion: 'failure' } : step,
    );
    const { seal } = fixture({ jobs: [verifyJob({ steps })] });

    expect(() =>
      seal({
        workerResults: Object.fromEntries(CANDIDATE_SUITES.map((suite) => [suite, 'success'])),
      }),
    ).toThrow(/unit step is not explicitly successful/);
  });

  it.each([
    ['duplicate verify jobs', [verifyJob(), verifyJob()]],
    ['wrong attempt', [verifyJob({ run_attempt: 1 })]],
  ])('rejects ambiguous or mismatched job metadata: %s', (_label, jobs) => {
    const { seal } = fixture({ jobs });
    expect(() => seal()).toThrow();
  });

  it.each([
    ['missing before snapshot', null, snapshot('2026-10-05T01:02:00.000Z')],
    ['missing after snapshot', snapshot('2026-10-05T01:01:00.000Z'), null],
    [
      'malformed identity',
      snapshot('2026-10-05T01:01:00.000Z', { identity: 'remote-db' }),
      snapshot('2026-10-05T01:02:00.000Z'),
    ],
    [
      'malformed schema hash',
      snapshot('2026-10-05T01:01:00.000Z', { schemaHash: 'bad' }),
      snapshot('2026-10-05T01:02:00.000Z'),
    ],
    [
      'wrong migration hash',
      snapshot('2026-10-05T01:01:00.000Z', { migrationHash: 'f'.repeat(64) }),
      snapshot('2026-10-05T01:02:00.000Z'),
    ],
  ])('rejects %s', (_label, before, after) => {
    const { seal } = fixture({ before, after });
    expect(() => seal()).toThrow();
  });

  it.each([
    ['repository', { repository: { full_name: 'attacker/fork' } }],
    ['SHA', { head_sha: 'f'.repeat(40) }],
    ['event', { event: 'pull_request' }],
    ['workflow path', { path: '.github/workflows/release-candidate.yml@integration' }],
  ])('rejects a workflow run with mismatched %s identity', (_label, override) => {
    const { seal } = fixture({ runOverrides: override });
    expect(() => seal()).toThrow(/workflow run identity/);
  });
});
