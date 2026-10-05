import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  POC_STATE_SQL,
  isHistoricalPocBaseline,
  onlyRetiredPocFunctionsWereRemoved,
  planDbUpgrade,
  withBaseInputs,
} from './db-upgrade-check.mjs';

const original = '20261003073817_supabase_rate_limit_idempotency_poc.sql';
const forward = '20261005020445_retire_rate_limit_poc_safely.sql';
const archivePath = `supabase/migrations/_archive/${original}`;
const originalPath = `supabase/migrations/${original}`;
const forwardPath = `supabase/migrations/${forward}`;
const tombstone = 'canonical tombstone';
const historicalSql = 'byte-exact historical POC SQL';

describe('pinned POC retirement DB upgrade contract', () => {
  it('runs the ordinary shadow checks for the exact stacked Phase A base', () => {
    const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const prTrigger = workflow.split('  pull_request:')[1].split('  workflow_dispatch:')[0];
    expect(prTrigger).toMatch(/branches: \[main, integration, codex\/integration-reconcile-3009\]/);
    expect(prTrigger).not.toContain('codex/**');
    expect(workflow).toContain(
      "github.event.pull_request.draft != true && !inputs.preview_e2e && needs.impact.outputs.migrations_added == 'true'",
    );
  });
  it('allows only the validated same-version tombstone edit and runs the forward migration', () => {
    const changed = [
      { status: 'M', path: originalPath },
      { status: 'A', path: forwardPath },
      { status: 'A', path: archivePath },
    ];
    const plan = planDbUpgrade({
      base: [original, '20261004000000_unrelated.sql'],
      candidate: [original, '20261004000000_unrelated.sql', forward],
      changed,
      pocRetirementValidated: true,
    });

    expect(plan.status).toBe('run');
    expect(plan.added).toEqual([forward]);
    expect(plan.problems).toEqual([]);
  });

  it('keeps edited migrations blocked without an explicit validated retirement contract', () => {
    const plan = planDbUpgrade({
      base: [original, '20261004000000_unrelated.sql'],
      candidate: [original, '20261004000000_unrelated.sql', forward],
      changed: [
        { status: 'M', path: originalPath },
        { status: 'A', path: forwardPath },
      ],
    });

    expect(plan.status).toBe('fail');
    expect(plan.problems).toContain(
      `applied migration edited: ${original} (production will not re-run it)`,
    );
  });

  it('never uses the retirement exception for another migration edit or deletion', () => {
    const plan = planDbUpgrade({
      base: [original, '20261004000000_unrelated.sql'],
      candidate: [original, forward],
      changed: [
        { status: 'M', path: originalPath },
        { status: 'D', path: 'supabase/migrations/20261004000000_unrelated.sql' },
        { status: 'A', path: forwardPath },
      ],
      pocRetirementValidated: true,
    });

    expect(plan.status).toBe('fail');
    expect(plan.problems).toContain(
      'applied migration removed: 20261004000000_unrelated.sql (production keeps its effects)',
    );
  });

  it('does not replay archived POC SQL on a base that already contains a tombstone', () => {
    expect(isHistoricalPocBaseline([original], tombstone)).toBe(false);
    expect(isHistoricalPocBaseline([], historicalSql)).toBe(false);
  });

  it('restores the candidate tombstone and added migrations even when baseline reset throws', () => {
    const files = new Map([
      [resolve('supabase/seed.sql'), 'candidate seed'],
      [resolve(originalPath), tombstone],
      [resolve(forwardPath), 'forward SQL'],
    ]);
    const moveFile = (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    };

    expect(() =>
      withBaseInputs(
        { added: [forward], baseSeed: 'base seed', pocArchiveSql: historicalSql },
        {
          moveFile,
          makeTempDir: () => '/tmp/db-upgrade-contract',
          readFile: (path) => {
            const value = files.get(resolve(path));
            if (value === undefined) throw new Error(`missing ${path}`);
            return value;
          },
          writeFile: (path, text) => files.set(resolve(path), text),
        },
        () => {
          expect(files.get(resolve(originalPath))).toBe(historicalSql);
          expect(files.has(resolve(forwardPath))).toBe(false);
          expect(files.get(resolve('supabase/seed.sql'))).toBe('base seed');
          throw new Error('synthetic reset failure');
        },
      ),
    ).toThrow('synthetic reset failure');

    expect(files.get(resolve(originalPath))).toBe(tombstone);
    expect(files.get(resolve(forwardPath))).toBe('forward SQL');
    expect(files.get(resolve('supabase/seed.sql'))).toBe('candidate seed');
  });

  it('permits exactly all five removed POC RPCs only after Phase A retirement validation', () => {
    const comparison = {
      narrowing: true,
      removed: {
        tables: [],
        columns: [],
        columnTypes: [],
        writeContracts: [],
        relationships: [],
        views: [],
        viewColumns: [],
        functions: [
          'check_supabase_rate_limit_poc',
          'claim_supabase_webhook_event_poc',
          'complete_supabase_webhook_event_poc',
          'release_supabase_webhook_event_poc',
          'prune_supabase_rate_limit_poc',
        ],
        functionSignatures: [],
        enumValues: [],
      },
    };

    expect(onlyRetiredPocFunctionsWereRemoved(comparison, true)).toBe(true);
    expect(onlyRetiredPocFunctionsWereRemoved(comparison, false)).toBe(false);
    expect(
      onlyRetiredPocFunctionsWereRemoved(
        { ...comparison, removed: { ...comparison.removed, tables: ['activities'] } },
        true,
      ),
    ).toBe(false);
    expect(
      onlyRetiredPocFunctionsWereRemoved(
        {
          ...comparison,
          removed: {
            ...comparison.removed,
            functions: comparison.removed.functions.slice(1),
          },
        },
        true,
      ),
    ).toBe(false);
  });

  it('fingerprints both POC state tables without dropping or rewriting their rows', () => {
    expect(POC_STATE_SQL).toContain('rate_limit_poc.supabase_rate_limit_state_poc');
    expect(POC_STATE_SQL).toContain('rate_limit_poc.supabase_webhook_claims_poc');
    expect(POC_STATE_SQL).toContain('md5(');
    expect(POC_STATE_SQL).toContain('c.oid::text');
  });
});
