import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

/** Management API enforces read_only; credentials never appear in arguments or errors. */
export async function runReadOnlyQuery(
  query,
  { token = process.env.SUPABASE_STORAGE_RLS_AUDIT_TOKEN, fetchImpl = fetch } = {},
) {
  if (!token?.trim()) throw new Error('SUPABASE_STORAGE_RLS_AUDIT_TOKEN is required');
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${SUPABASE_PRODUCTION_PROJECT_REF}/database/query`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, read_only: true }),
    },
  );
  if (!response.ok) throw new Error(`Read-only database audit failed (HTTP ${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Read-only audit returned an invalid row set');
  return rows;
}

export function scalarResult(rows) {
  if (
    rows.length !== 1 ||
    rows[0] === null ||
    typeof rows[0] !== 'object' ||
    Object.keys(rows[0]).length !== 1
  ) {
    throw new Error('Snapshot query must return exactly one scalar column');
  }
  return Object.values(rows[0])[0];
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    let query = '';
    for await (const chunk of process.stdin) query += chunk;
    if (!query.trim() || query.length > 256_000) throw new Error('Invalid snapshot query');
    console.log(JSON.stringify(scalarResult(await runReadOnlyQuery(query))));
  } catch {
    console.error('Read-only snapshot query failed; check audit credentials and metadata schema.');
    process.exitCode = 1;
  }
}
