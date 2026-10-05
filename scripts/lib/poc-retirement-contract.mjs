import { createHash } from 'node:crypto';

export const POC_ORIGINAL_VERSION = '20261003073817';
export const POC_ORIGINAL_MIGRATION_PATH = `supabase/migrations/${POC_ORIGINAL_VERSION}_supabase_rate_limit_idempotency_poc.sql`;
export const POC_ARCHIVE_PATH = `supabase/migrations/_archive/${POC_ORIGINAL_VERSION}_supabase_rate_limit_idempotency_poc.sql`;
export const POC_ORIGINAL_SHA256 =
  '11dd31c45ac6eb95b329d00c8ade766b4d625626a7c5fb1b37614e4322999905';
export const POC_TOMBSTONE_PATH = POC_ORIGINAL_MIGRATION_PATH;
export const POC_TOMBSTONE_SQL =
  '-- POC migration retired; original SQL is preserved in supabase/migrations/_archive/20261003073817_supabase_rate_limit_idempotency_poc.sql.\nSELECT 1;\n';
export const POC_RETIREMENT_MANIFEST = Object.freeze({
  forwardRetirementMigrationPath:
    'supabase/migrations/20261005020445_retire_rate_limit_poc_safely.sql',
});

export const POC_RETIREMENT_SQL_SHA256 =
  '610d0ce7fbaa4d44bfa8e5e0ecde23ae9638971a3fc03ef3f3bd362bb8e6427a';

const TOP_LEVEL_MIGRATION = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/;
const CODE_FILE = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i;
const TEST_OR_GENERATED_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|fixtures|generated)(?:\/|$)|(?:\.|-)(?:test|spec)\.[^.]+$/i;
const RUNTIME_ROOT = /^(?:apps\/[^/]+\/|packages\/[^/]+\/|supabase\/functions\/)/;

const POC_RUNTIME_REFERENCES = [
  /\bisSupabaseRateLimitPocEnabled\b/,
  /\bisSupabaseWebhookClaimPocEnabled\b/,
  /\bSUPABASE_RATE_LIMIT_POC_ENABLED\b/,
  /\bSUPABASE_WEBHOOK_CLAIM_POC_ENABLED\b/,
  /\bcheck_supabase_rate_limit_poc\b/,
  /\bclaim_supabase_webhook_event_poc\b/,
  /\bcomplete_supabase_webhook_event_poc\b/,
  /\brelease_supabase_webhook_event_poc\b/,
  /\bprune_supabase_rate_limit_poc\b/,
  /\bsupabase_rate_limit_state_poc\b/,
  /\bsupabase_webhook_claims_poc\b/,
  /(?:^|[/'" ])(?:\.\/)?supabase-poc(?:\.m?js|\.ts)?\b/,
];

const POC_CREATION_SQL = [
  /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?rate_limit_poc"?)\b/i,
  /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?rate_limit_poc"?\s*\.\s*)?(?:"?supabase_(?:rate_limit_state|webhook_claims)_poc"?)\b/i,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(?:check_supabase_rate_limit_poc|claim_supabase_webhook_event_poc|complete_supabase_webhook_event_poc|release_supabase_webhook_event_poc|prune_supabase_rate_limit_poc)"?\b/i,
];

function entries(files, label) {
  if (files instanceof Map) return [...files.entries()];
  if (files && typeof files === 'object' && !Array.isArray(files)) return Object.entries(files);
  throw new TypeError(`${label} must be a Map or path-to-text object`);
}

function fileMap(files, label) {
  const result = new Map();
  for (const [path, text] of entries(files, label)) {
    if (typeof path !== 'string' || typeof text !== 'string')
      throw new TypeError(`${label} entries must be repo paths and UTF-8 text`);
    result.set(path, text);
  }
  return result;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRuntimeModule(path) {
  return RUNTIME_ROOT.test(path) && CODE_FILE.test(path) && !TEST_OR_GENERATED_PATH.test(path);
}

function findPocReferences(files) {
  const findings = [];
  for (const [path, text] of files) {
    if (!isRuntimeModule(path)) continue;
    for (const pattern of POC_RUNTIME_REFERENCES) {
      const match = text.match(pattern);
      if (match) {
        findings.push(`${path}: ${match[0]}`);
        break;
      }
    }
  }
  return findings;
}

function topLevelMigrations(files) {
  return new Map([...files].filter(([path]) => TOP_LEVEL_MIGRATION.test(path)));
}

/**
 * Assert the Phase B POC retirement boundary against complete base and candidate git file maps.
 * The caller must source `baseFiles` from the selected base commit, not from the working tree.
 * This is a static contract only; it does not connect to or mutate Supabase.
 */
export function assertPocRetirementContract({ baseFiles, candidateFiles, manifest }) {
  const base = fileMap(baseFiles, 'baseFiles');
  const candidate = fileMap(candidateFiles, 'candidateFiles');
  const errors = [];

  const archivedSql = candidate.get(POC_ARCHIVE_PATH);
  if (archivedSql === undefined) {
    errors.push(`required POC archive is missing: ${POC_ARCHIVE_PATH}`);
  } else if (sha256(archivedSql) !== POC_ORIGINAL_SHA256) {
    errors.push(`POC archive bytes do not match the original SHA-256: ${POC_ARCHIVE_PATH}`);
  }

  const tombstone = candidate.get(POC_TOMBSTONE_PATH);
  if (tombstone !== POC_TOMBSTONE_SQL)
    errors.push(`same-version POC tombstone is missing or changed: ${POC_TOMBSTONE_PATH}`);

  const retirementPath = manifest?.forwardRetirementMigrationPath;
  if (retirementPath !== POC_RETIREMENT_MANIFEST.forwardRetirementMigrationPath) {
    errors.push(
      `manifest must pin forward retirement SQL to ${POC_RETIREMENT_MANIFEST.forwardRetirementMigrationPath}`,
    );
  } else if (!candidate.has(retirementPath)) {
    errors.push(`forward retirement migration is missing: ${retirementPath}`);
  } else if (sha256(candidate.get(retirementPath)) !== POC_RETIREMENT_SQL_SHA256) {
    errors.push(
      `forward retirement SQL differs from the reviewed RPC-only retirement: ${retirementPath}`,
    );
  }

  const baseMigrations = topLevelMigrations(base);
  const candidateMigrations = topLevelMigrations(candidate);
  for (const [path, baseSql] of baseMigrations) {
    const nextSql = candidateMigrations.get(path);
    if (path === POC_ORIGINAL_MIGRATION_PATH) {
      if (sha256(baseSql) !== POC_ORIGINAL_SHA256 && baseSql !== POC_TOMBSTONE_SQL)
        errors.push(`base POC migration is not the known historical SQL: ${path}`);
      if (nextSql !== POC_TOMBSTONE_SQL)
        errors.push(`base POC migration must be replaced only by the canonical tombstone: ${path}`);
      continue;
    }
    if (nextSql === undefined) errors.push(`unrelated base migration was removed: ${path}`);
    else if (nextSql !== baseSql) errors.push(`unrelated base migration was edited: ${path}`);
  }

  const candidateReferences = findPocReferences(candidate);
  if (candidateReferences.length)
    errors.push(
      `POC runtime consumers reintroduced in candidate: ${candidateReferences.join('; ')}`,
    );
  const runtimeReferences = findPocReferences(base);
  if (runtimeReferences.length)
    errors.push(`Phase A runtime consumers remain in base files: ${runtimeReferences.join('; ')}`);

  for (const [path, sql] of candidateMigrations) {
    if (path === POC_TOMBSTONE_PATH) continue;
    if (POC_CREATION_SQL.some((pattern) => pattern.test(sql)))
      errors.push(`candidate migration creates a retired POC object: ${path}`);
  }

  if (errors.length) throw new Error(`POC retirement contract failed:\n- ${errors.join('\n- ')}`);

  return {
    archivePath: POC_ARCHIVE_PATH,
    archiveSha256: POC_ORIGINAL_SHA256,
    tombstonePath: POC_TOMBSTONE_PATH,
    forwardRetirementMigrationPath: retirementPath,
    inspectedBaseMigrationCount: baseMigrations.size,
    inspectedCandidateMigrationCount: candidateMigrations.size,
    inspectedBaseRuntimeFileCount: [...base.keys()].filter(isRuntimeModule).length,
  };
}
