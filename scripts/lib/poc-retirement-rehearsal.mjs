import { createHash } from 'node:crypto';

export const POC_ORIGINAL_SQL_SHA256 =
  '11dd31c45ac6eb95b329d00c8ade766b4d625626a7c5fb1b37614e4322999905';

export const POC_ROWS_FINGERPRINT_SQL = `select 'rate_limit_poc.supabase_rate_limit_state_poc,' || c.oid::text || ',' || (select count(*)::text || ',' || md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' order by to_jsonb(t)::text), '')) from rate_limit_poc.supabase_rate_limit_state_poc t) from pg_class c where c.oid = 'rate_limit_poc.supabase_rate_limit_state_poc'::regclass union all select 'rate_limit_poc.supabase_webhook_claims_poc,' || c.oid::text || ',' || (select count(*)::text || ',' || md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' order by to_jsonb(t)::text), '')) from rate_limit_poc.supabase_webhook_claims_poc t) from pg_class c where c.oid = 'rate_limit_poc.supabase_webhook_claims_poc'::regclass order by 1`;

/** Fingerprint schema/table ACLs, RLS, policies, indexes, constraints, and triggers. RPCs are separate. */
export const POC_SECURITY_CATALOG_SQL = `with catalog_rows as (
  select 'schema:' || n.nspname || '|owner=' || pg_catalog.pg_get_userbyid(n.nspowner) || '|acl=' || coalesce(n.nspacl::text, '<default>') as item
  from pg_catalog.pg_namespace n where n.nspname = 'rate_limit_poc'
  union all
  select 'relation:' || n.nspname || '.' || c.relname || '|kind=' || c.relkind || '|owner=' || pg_catalog.pg_get_userbyid(c.relowner) || '|acl=' || coalesce(c.relacl::text, '<default>') || '|rls=' || c.relrowsecurity::text || '|force=' || c.relforcerowsecurity::text || '|options=' || coalesce(array_to_string(c.reloptions, ','), '')
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'rate_limit_poc' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'policy:' || schemaname || '.' || tablename || '.' || policyname || '|permissive=' || permissive || '|roles=' || array_to_string(roles, ',') || '|cmd=' || cmd || '|using=' || coalesce(qual, '') || '|check=' || coalesce(with_check, '')
  from pg_catalog.pg_policies where schemaname = 'rate_limit_poc'
  union all
  select 'index:' || schemaname || '.' || indexname || '|' || indexdef
  from pg_catalog.pg_indexes where schemaname = 'rate_limit_poc'
  union all
  select 'constraint:' || n.nspname || '.' || c.conrelid::regclass::text || '.' || c.conname || '|type=' || c.contype || '|validated=' || c.convalidated::text || '|' || pg_catalog.pg_get_constraintdef(c.oid)
  from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'rate_limit_poc'
  union all
  select 'trigger:' || n.nspname || '.' || t.tgrelid::regclass::text || '.' || t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid)
  from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'rate_limit_poc' and not t.tgisinternal
)
select coalesce(string_agg(item, E'\\n' order by item), '') from catalog_rows`;

const POC_RPC_NAMES = [
  'check_supabase_rate_limit_poc',
  'claim_supabase_webhook_event_poc',
  'complete_supabase_webhook_event_poc',
  'release_supabase_webhook_event_poc',
  'prune_supabase_rate_limit_poc',
];

export const POC_RPC_INVENTORY_SQL = `select p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(array[${POC_RPC_NAMES.map((name) => `'${name}'`).join(', ')}]) order by 1`;

export const POC_RPC_ABSENCE_SQL = `select count(*)::text from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(array[${POC_RPC_NAMES.map((name) => `'${name}'`).join(', ')}])`;

export const POC_FRESH_ABSENCE_SQL = `select (pg_catalog.to_regnamespace('rate_limit_poc') is null)::text || '|' || (select count(*)::text from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(array[${POC_RPC_NAMES.map((name) => `'${name}'`).join(', ')}]))`;

const EXPECTED_RPC_SIGNATURES = [
  'check_supabase_rate_limit_poc(text, text, integer, integer)',
  'claim_supabase_webhook_event_poc(text, uuid)',
  'complete_supabase_webhook_event_poc(text, uuid)',
  'release_supabase_webhook_event_poc(text, uuid)',
  'prune_supabase_rate_limit_poc(integer)',
];
const ARCHIVED_RPC_SIGNATURES = [
  'check_supabase_rate_limit_poc(text,text,integer,integer)',
  'claim_supabase_webhook_event_poc(text,uuid)',
  'complete_supabase_webhook_event_poc(text,uuid)',
  'release_supabase_webhook_event_poc(text,uuid)',
  'prune_supabase_rate_limit_poc(integer)',
];

const RECOVERY_ASSERTIONS = [
  'DO $poc_contract$',
  'RLS must be enabled on both POC tables',
  'Unexpected RPC execution grants',
  'must not run as SECURITY DEFINER',
];

function normalizedOutput(value, stage) {
  if (typeof value !== 'string') throw new TypeError(`${stage} did not return psql text output`);
  return value.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function execute(execPsql, sql, stage) {
  try {
    const output = execPsql(sql);
    if (typeof output !== 'string') throw new TypeError('execPsql must return psql text output');
    return output;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`POC retirement rehearsal failed during ${stage}: ${detail}`, { cause: error });
  }
}

function query(execPsql, sql, stage) {
  try {
    return normalizedOutput(execPsql(sql), stage);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('POC retirement rehearsal failed'))
      throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`POC retirement rehearsal failed during ${stage}: ${detail}`, { cause: error });
  }
}

function assertEqual(actual, expected, stage) {
  if (actual !== expected)
    throw new Error(`POC retirement rehearsal failed during ${stage}: snapshot mismatch`);
}

function rpcInventory(execPsql, stage) {
  const rows = query(execPsql, POC_RPC_INVENTORY_SQL, stage)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  if (rows.length !== EXPECTED_RPC_SIGNATURES.length)
    throw new Error(
      `POC retirement rehearsal failed during ${stage}: expected exactly 5 POC RPC signatures, found ${rows.length}`,
    );
  const expected = [...EXPECTED_RPC_SIGNATURES].sort();
  if (rows.some((row, index) => row !== expected[index]))
    throw new Error(`POC retirement rehearsal failed during ${stage}: POC RPC signatures differ`);
  return rows;
}

function assertRecoverySql(sql) {
  if (typeof sql !== 'string' || !sql.trim())
    throw new Error('POC retirement rehearsal failed during recovery rendering: SQL is empty');
  if (!/^\s*BEGIN\s*;/i.test(sql) || !/\bCOMMIT\s*;\s*$/i.test(sql))
    throw new Error(
      'POC retirement rehearsal failed during recovery rendering: recovery SQL must be transaction-wrapped',
    );
  for (const signature of ARCHIVED_RPC_SIGNATURES) {
    const name = signature.slice(0, signature.indexOf('('));
    if (!sql.includes(`CREATE OR REPLACE FUNCTION public.${name}(`))
      throw new Error(`POC retirement rehearsal failed during recovery rendering: missing ${name}`);
    if (!sql.includes(`'public.${signature}'::REGPROCEDURE`))
      throw new Error(
        `POC retirement rehearsal failed during recovery rendering: missing pinned signature ${signature}`,
      );
  }
  for (const assertion of RECOVERY_ASSERTIONS) {
    if (!sql.includes(assertion))
      throw new Error(
        `POC retirement rehearsal failed during recovery rendering: missing archived assertion ${assertion}`,
      );
  }
  if (/\b(?:CREATE\s+SCHEMA|CREATE\s+(?:UNLOGGED\s+)?TABLE|DROP\s+(?:SCHEMA|TABLE))\b/i.test(sql))
    throw new Error(
      'POC retirement rehearsal failed during recovery rendering: recovery SQL must not create or delete POC state',
    );
}

/**
 * Rehearse restoration and re-retirement against a disposable local database.
 * The caller is responsible for validating the forward migration before passing it here.
 * This function does not connect to a database itself; `execPsql` owns that boundary.
 * @param {{ execPsql: (sql: string) => string, renderRecovery: (archive: string) => string, archivedSql: string, forwardSql: string, expectedTableRows: string, expectedSecurityCatalog: string }} input
 */
export function rehearsePocRetirement({
  execPsql,
  renderRecovery,
  archivedSql,
  forwardSql,
  expectedTableRows,
  expectedSecurityCatalog,
}) {
  if (typeof execPsql !== 'function') throw new TypeError('execPsql must be a function');
  if (typeof renderRecovery !== 'function')
    throw new TypeError('renderRecovery must be a function');
  if (typeof archivedSql !== 'string')
    throw new TypeError('archivedSql must be the pinned archive text');
  if (typeof forwardSql !== 'string' || !forwardSql.trim())
    throw new TypeError('forwardSql must be the caller-validated retirement SQL');
  if (typeof expectedTableRows !== 'string' || !expectedTableRows.trim())
    throw new TypeError('expectedTableRows must be a non-empty before-retirement fingerprint');
  if (typeof expectedSecurityCatalog !== 'string' || !expectedSecurityCatalog.trim())
    throw new TypeError(
      'expectedSecurityCatalog must be a non-empty before-retirement fingerprint',
    );
  const archiveHash = createHash('sha256').update(archivedSql, 'utf8').digest('hex');
  if (archiveHash !== POC_ORIGINAL_SQL_SHA256)
    throw new Error(
      'POC retirement rehearsal refused: archive is not byte-identical to pinned SQL',
    );

  const expectedRows = normalizedOutput(expectedTableRows, 'expected table fingerprint');
  const expectedSecurity = normalizedOutput(expectedSecurityCatalog, 'expected security catalog');
  const stateRows = (stage) => query(execPsql, POC_ROWS_FINGERPRINT_SQL, stage);
  const securityState = (stage) => query(execPsql, POC_SECURITY_CATALOG_SQL, stage);
  const rpcCount = (stage) => query(execPsql, POC_RPC_ABSENCE_SQL, stage);
  const verifyPreservedState = (stage) => {
    assertEqual(stateRows(`${stage}: table rows`), expectedRows, `${stage}: table rows`);
    assertEqual(
      securityState(`${stage}: security catalog`),
      expectedSecurity,
      `${stage}: security catalog`,
    );
  };
  const assertRpcsAbsent = (stage) => {
    const count = rpcCount(stage);
    if (count !== '0')
      throw new Error(
        `POC retirement rehearsal failed during ${stage}: expected 0 public POC RPCs, found ${count}`,
      );
  };

  // The caller has just applied the forward migration. Refuse to rehearse from a changed baseline.
  verifyPreservedState('post-retirement baseline');
  assertRpcsAbsent('post-retirement baseline');

  let recoverySql;
  try {
    recoverySql = renderRecovery(archivedSql);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`POC retirement rehearsal failed during recovery rendering: ${detail}`, {
      cause: error,
    });
  }
  assertRecoverySql(recoverySql);
  execute(execPsql, recoverySql, 'recovery SQL execution');

  verifyPreservedState('after recovery');
  rpcInventory(execPsql, 'recovered RPC inventory');

  execute(execPsql, forwardSql, 'forward retirement SQL reapplication');
  verifyPreservedState('after re-retirement');
  assertRpcsAbsent('after re-retirement');

  return {
    archiveSha256: archiveHash,
    recoveredRpcSignatures: [...EXPECTED_RPC_SIGNATURES],
    forwardMigrationReapplied: true,
    tableRowsPreserved: true,
    securityCatalogPreserved: true,
    publicPocRpcsAbsentAfterRetirement: true,
  };
}
