import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { POC_ORIGINAL_SHA256 } from '../lib/poc-retirement-contract.mjs';

/** Prepare recovery SQL offline. Never connect to or mutate a database. */
export function renderPocRetirementRecovery(originalSql) {
  if (createHash('sha256').update(originalSql).digest('hex') !== POC_ORIGINAL_SHA256)
    throw new Error('Recovery requires byte-identical original POC archive');
  const start = originalSql.indexOf(
    'CREATE OR REPLACE FUNCTION public.check_supabase_rate_limit_poc(',
  );
  const end = originalSql.lastIndexOf('COMMIT;');
  if (start < 0 || end <= start) throw new Error('Archived recovery boundaries are missing');
  // Only RPC definitions, their original grants and security assertions. Existing state is retained.
  return (
    "BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';\n" +
    originalSql.slice(start, end) +
    'COMMIT;\n'
  );
}

if (isDirectExecution(import.meta.url)) {
  const archive = fileURLToPath(
    new URL(
      '../../supabase/migrations/_archive/20261003073817_supabase_rate_limit_idempotency_poc.sql',
      import.meta.url,
    ),
  );
  try {
    process.stdout.write(renderPocRetirementRecovery(readFileSync(archive, 'utf8')));
  } catch {
    console.error('POC recovery generation failed: verify immutable archive; no SQL was applied.');
    process.exitCode = 1;
  }
}
