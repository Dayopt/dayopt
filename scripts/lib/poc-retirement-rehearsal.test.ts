import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  POC_FRESH_ABSENCE_SQL,
  POC_ORIGINAL_SQL_SHA256,
  POC_ROWS_FINGERPRINT_SQL,
  POC_RPC_ABSENCE_SQL,
  POC_RPC_INVENTORY_SQL,
  POC_SECURITY_CATALOG_SQL,
  rehearsePocRetirement,
} from './poc-retirement-rehearsal.mjs';

const HISTORICAL_SOURCE_COMMIT = 'd04f80d3fa60f11249d3b64c76526b54d008bb65';
const ARCHIVE_PATH =
  'supabase/migrations/_archive/20261003073817_supabase_rate_limit_idempotency_poc.sql';
const ORIGINAL_SQL = (() => {
  try {
    return execFileSync(
      'git',
      [
        'show',
        `${HISTORICAL_SOURCE_COMMIT}:supabase/migrations/20261003073817_supabase_rate_limit_idempotency_poc.sql`,
      ],
      { encoding: 'utf8' },
    );
  } catch {
    return readFileSync(ARCHIVE_PATH, 'utf8');
  }
})();

const RETIREMENT_SQL = 'validated-forward-retirement-sql';
const TABLE_ROWS = 'rate_limit_poc table row fingerprints';
const SECURITY_CATALOG = 'rate_limit_poc schema/table ACL and catalog fingerprint';
const RPC_SIGNATURES = [
  'check_supabase_rate_limit_poc(text, text, integer, integer)',
  'claim_supabase_webhook_event_poc(text, uuid)',
  'complete_supabase_webhook_event_poc(text, uuid)',
  'release_supabase_webhook_event_poc(text, uuid)',
  'prune_supabase_rate_limit_poc(integer)',
].join('\n');
const RECOVERY_SQL = `
BEGIN;
CREATE OR REPLACE FUNCTION public.check_supabase_rate_limit_poc(p_scope TEXT, p_identifier_hash TEXT, p_limit_count INTEGER, p_window_seconds INTEGER) RETURNS JSONB;
CREATE OR REPLACE FUNCTION public.claim_supabase_webhook_event_poc(p_event_hash TEXT, p_processing_token UUID) RETURNS TEXT;
CREATE OR REPLACE FUNCTION public.complete_supabase_webhook_event_poc(p_event_hash TEXT, p_processing_token UUID) RETURNS BOOLEAN;
CREATE OR REPLACE FUNCTION public.release_supabase_webhook_event_poc(p_event_hash TEXT, p_processing_token UUID) RETURNS BOOLEAN;
CREATE OR REPLACE FUNCTION public.prune_supabase_rate_limit_poc(p_batch_size INTEGER) RETURNS JSONB;
'public.check_supabase_rate_limit_poc(text,text,integer,integer)'::REGPROCEDURE,
'public.claim_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
'public.complete_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
'public.release_supabase_webhook_event_poc(text,uuid)'::REGPROCEDURE,
'public.prune_supabase_rate_limit_poc(integer)'::REGPROCEDURE,
DO $poc_contract$
  RAISE EXCEPTION 'RLS must be enabled on both POC tables';
  RAISE EXCEPTION 'Unexpected RPC execution grants for %';
  RAISE EXCEPTION 'POC RPC % must not run as SECURITY DEFINER';
$poc_contract$;
COMMIT;
`;

function successfulExecutor(overrides: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const queues = new Map<string, string[]>([
    [POC_ROWS_FINGERPRINT_SQL, [TABLE_ROWS, TABLE_ROWS, TABLE_ROWS, TABLE_ROWS]],
    [
      POC_SECURITY_CATALOG_SQL,
      [SECURITY_CATALOG, SECURITY_CATALOG, SECURITY_CATALOG, SECURITY_CATALOG],
    ],
    [POC_RPC_ABSENCE_SQL, ['0', '0']],
    [POC_RPC_INVENTORY_SQL, [RPC_SIGNATURES]],
    ...Object.entries(overrides),
  ]);
  return {
    calls,
    execPsql(sql: string) {
      calls.push(sql);
      const queue = queues.get(sql);
      if (queue?.length) return queue.shift() ?? '';
      if (sql === RECOVERY_SQL || sql === RETIREMENT_SQL) return '';
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function runRehearsal(
  execPsql: (sql: string) => string,
  options: Partial<Parameters<typeof rehearsePocRetirement>[0]> = {},
) {
  return rehearsePocRetirement({
    execPsql,
    renderRecovery: () => RECOVERY_SQL,
    archivedSql: ORIGINAL_SQL,
    forwardSql: RETIREMENT_SQL,
    expectedTableRows: TABLE_ROWS,
    expectedSecurityCatalog: SECURITY_CATALOG,
    ...options,
  });
}

describe('POC retirement rehearsal helper', () => {
  it('exports catalog SQL covering tables, ACLs, RLS, policies, indexes, constraints, and triggers', () => {
    expect(POC_SECURITY_CATALOG_SQL).toContain("n.nspname = 'rate_limit_poc'");
    for (const evidence of [
      'n.nspacl',
      'c.relacl',
      'c.relrowsecurity',
      'c.relforcerowsecurity',
      'pg_catalog.pg_policies',
      'pg_catalog.pg_indexes',
      'pg_catalog.pg_constraint',
      'pg_catalog.pg_get_constraintdef',
      'pg_catalog.pg_trigger',
      'pg_catalog.pg_get_triggerdef',
    ])
      expect(POC_SECURITY_CATALOG_SQL).toContain(evidence);
    expect(POC_ROWS_FINGERPRINT_SQL).toContain('pg_class');
    expect(POC_RPC_INVENTORY_SQL).toContain('pg_catalog.oidvectortypes(p.proargtypes)');
    expect(POC_RPC_INVENTORY_SQL).not.toContain('p_scope');
    expect(POC_RPC_ABSENCE_SQL).toContain('pg_proc');
    expect(POC_FRESH_ABSENCE_SQL).toContain("to_regnamespace('rate_limit_poc') is null");
    expect(POC_FRESH_ABSENCE_SQL).toContain('pg_proc');
    for (const name of [
      'check_supabase_rate_limit_poc',
      'claim_supabase_webhook_event_poc',
      'complete_supabase_webhook_event_poc',
      'release_supabase_webhook_event_poc',
      'prune_supabase_rate_limit_poc',
    ]) {
      expect(POC_RPC_INVENTORY_SQL).toContain(name);
      expect(POC_RPC_ABSENCE_SQL).toContain(name);
      expect(POC_FRESH_ABSENCE_SQL).toContain(name);
    }
  });

  it('restores exactly the five RPC signatures, preserves state/security, then reapplies retirement', () => {
    const executor = successfulExecutor();
    const renderRecovery = vi.fn(() => RECOVERY_SQL);
    const result = rehearsePocRetirement({
      execPsql: executor.execPsql,
      renderRecovery,
      archivedSql: ORIGINAL_SQL,
      forwardSql: RETIREMENT_SQL,
      expectedTableRows: TABLE_ROWS,
      expectedSecurityCatalog: SECURITY_CATALOG,
    });

    expect(renderRecovery).toHaveBeenCalledWith(ORIGINAL_SQL);
    expect(result).toMatchObject({
      archiveSha256: POC_ORIGINAL_SQL_SHA256,
      recoveredRpcSignatures: RPC_SIGNATURES.split('\n'),
      forwardMigrationReapplied: true,
      tableRowsPreserved: true,
      securityCatalogPreserved: true,
      publicPocRpcsAbsentAfterRetirement: true,
    });
    expect(executor.calls).toEqual([
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_ABSENCE_SQL,
      RECOVERY_SQL,
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_INVENTORY_SQL,
      RETIREMENT_SQL,
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_ABSENCE_SQL,
    ]);
  });

  it('refuses an unpinned archive before invoking recovery or SQL execution', () => {
    const executor = successfulExecutor();
    expect(() => runRehearsal(executor.execPsql, { archivedSql: `${ORIGINAL_SQL}\n` })).toThrow(
      /not byte-identical to pinned SQL/,
    );
    expect(executor.calls).toEqual([]);
  });

  it('stops before recovery if the post-retirement row or security baseline differs', () => {
    const rowExecutor = successfulExecutor({ [POC_ROWS_FINGERPRINT_SQL]: ['different rows'] });
    expect(() => runRehearsal(rowExecutor.execPsql)).toThrow(
      /post-retirement baseline: table rows/,
    );
    expect(rowExecutor.calls).toEqual([POC_ROWS_FINGERPRINT_SQL]);

    const securityExecutor = successfulExecutor({
      [POC_SECURITY_CATALOG_SQL]: ['different security catalog'],
    });
    expect(() => runRehearsal(securityExecutor.execPsql)).toThrow(
      /post-retirement baseline: security catalog/,
    );
    expect(securityExecutor.calls).toEqual([POC_ROWS_FINGERPRINT_SQL, POC_SECURITY_CATALOG_SQL]);
  });

  it('fails closed on missing or extra RPCs before recovery and after recovery', () => {
    const missingInitially = successfulExecutor({ [POC_RPC_ABSENCE_SQL]: ['1'] });
    expect(() => runRehearsal(missingInitially.execPsql)).toThrow(/expected 0 public POC RPCs/);
    expect(missingInitially.calls).toEqual([
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_ABSENCE_SQL,
    ]);

    const extraOverload = successfulExecutor({
      [POC_RPC_INVENTORY_SQL]: [
        [...RPC_SIGNATURES.split('\n'), 'check_supabase_rate_limit_poc(jsonb)'].join('\n'),
      ],
    });
    expect(() => runRehearsal(extraOverload.execPsql)).toThrow(
      /expected exactly 5 POC RPC signatures, found 6/,
    );
    expect(extraOverload.calls).not.toContain(RETIREMENT_SQL);
  });

  it('refuses incomplete recovery SQL before applying it', () => {
    const executor = successfulExecutor();
    expect(() =>
      runRehearsal(executor.execPsql, {
        renderRecovery: () => 'BEGIN; CREATE FUNCTION public.partial_poc(); COMMIT;',
      }),
    ).toThrow(/missing check_supabase_rate_limit_poc/);
    expect(executor.calls).toEqual([
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_ABSENCE_SQL,
    ]);
  });

  it('requires transaction-wrapped recovery SQL and stops before re-retiring on restore mismatch', () => {
    const unwrapped = successfulExecutor();
    expect(() =>
      runRehearsal(unwrapped.execPsql, {
        renderRecovery: () => RECOVERY_SQL.replace(/^\s*BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''),
      }),
    ).toThrow(/must be transaction-wrapped/);
    expect(unwrapped.calls).toEqual([
      POC_ROWS_FINGERPRINT_SQL,
      POC_SECURITY_CATALOG_SQL,
      POC_RPC_ABSENCE_SQL,
    ]);

    const changedAfterRestore = successfulExecutor({
      [POC_ROWS_FINGERPRINT_SQL]: [TABLE_ROWS, 'rows changed by recovery'],
    });
    expect(() => runRehearsal(changedAfterRestore.execPsql)).toThrow(
      /after recovery: table rows: snapshot mismatch/,
    );
    expect(changedAfterRestore.calls).not.toContain(RETIREMENT_SQL);
  });

  it('reports post-retirement state drift after reapplication instead of returning success', () => {
    const changedAfterRetirement = successfulExecutor({
      [POC_SECURITY_CATALOG_SQL]: [
        SECURITY_CATALOG,
        SECURITY_CATALOG,
        'catalog changed during re-retirement',
      ],
    });
    expect(() => runRehearsal(changedAfterRetirement.execPsql)).toThrow(
      /after re-retirement: security catalog: snapshot mismatch/,
    );
    expect(changedAfterRetirement.calls).toContain(RETIREMENT_SQL);
  });

  it('does not reapply forward SQL when recovery execution or its RPC inventory check fails', () => {
    const recoveryFailure = successfulExecutor();
    const failingRecovery = (sql: string) => {
      if (sql === RECOVERY_SQL) throw new Error('mocked psql failure');
      return recoveryFailure.execPsql(sql);
    };
    expect(() => runRehearsal(failingRecovery)).toThrow(
      /recovery SQL execution: mocked psql failure/,
    );
    expect(recoveryFailure.calls).not.toContain(RETIREMENT_SQL);

    const recoveryInventoryFailure = successfulExecutor({
      [POC_RPC_INVENTORY_SQL]: ['unexpected_rpc(text)'],
    });
    expect(() => runRehearsal(recoveryInventoryFailure.execPsql)).toThrow(
      /expected exactly 5 POC RPC signatures/,
    );
    expect(recoveryInventoryFailure.calls).not.toContain(RETIREMENT_SQL);
  });

  it('does not claim real transaction rollback when a mocked stage fails', () => {
    const executor = successfulExecutor();
    const attemptedSql: string[] = [];
    const failingForward = (sql: string) => {
      attemptedSql.push(sql);
      if (sql === RETIREMENT_SQL) throw new Error('mocked forward failure');
      return executor.execPsql(sql);
    };
    expect(() => runRehearsal(failingForward)).toThrow(
      /forward retirement SQL reapplication: mocked forward failure/,
    );
    expect(executor.calls).toContain(RECOVERY_SQL);
    expect(attemptedSql).toContain(RETIREMENT_SQL);
  });
});

describe('PostgreSQL catalog discriminant types', () => {
  it('casts internal char kinds before text concatenation', () => {
    expect(POC_SECURITY_CATALOG_SQL).toContain("'|kind=' || c.relkind::text ||");
    expect(POC_SECURITY_CATALOG_SQL).toContain("'|type=' || c.contype::text ||");
    expect(POC_SECURITY_CATALOG_SQL).not.toMatch(/\|\| c\.(?:relkind|contype) \|\|/);
  });
});
