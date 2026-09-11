import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const productionResource = 'https://mcp.dayopt.app';

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const tokenId = crypto.randomUUID();
const codeHash = `candidate-4-code-${crypto.randomUUID()}`;
const email = `mcp-candidate-4-${userId}@example.com`;
const password = 'test-password-123';

const candidateMigration = readFileSync(
  new URL(
    '../../../../../../supabase/migrations/20260730090100_mcp_oauth_scope_constraints_not_valid.sql',
    import.meta.url,
  ),
  'utf8',
);

const validationMigration = readFileSync(
  new URL(
    '../../../../../../supabase/migrations/20260730090200_validate_mcp_oauth_scope_constraints.sql',
    import.meta.url,
  ),
  'utf8',
);

const stagedTableNames = [
  'oauth_connections',
  'oauth_authorization_codes',
  'oauth_tokens',
] as const;

const stagedConstraintNames = [
  'oauth_connections_write_requires_read_entries_check',
  'oauth_authorization_codes_write_requires_read_entries_check',
  'oauth_tokens_write_requires_read_entries_check',
] as const;

/**
 * Drops `--` comments so the guards below inspect executable SQL only. Both
 * migrations narrate themselves heavily, and matching raw file text would make
 * every comment rewording a false failure (`GRANT`, `NOT VALID` and the scope
 * names all appear in prose).
 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "'") quoted = !quoted;
        else if (!quoted && line[index] === '-' && line[index + 1] === '-') {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

const candidateSql = stripSqlComments(candidateMigration);
const validationSql = stripSqlComments(validationMigration);

function statementTimeoutSeconds(sql: string): number {
  const seconds = sql.match(/SET LOCAL statement_timeout = '(\d+)s'/)?.[1];
  expect(seconds).toBeDefined();
  return Number(seconds);
}

/**
 * The Candidate 4 CHECK body, as PostgreSQL will evaluate it. Candidate 4 is an
 * applied migration and must never be edited, so anchoring on its exact shape is
 * safe and makes any retro-edit fail loudly here.
 */
function stagedCheckExpression(): string {
  const expression = candidateSql.match(/CHECK \(\n([\s\S]*?)\n {2}\)\n {2}NOT VALID;/)?.[1];
  expect(expression).toBeDefined();
  return String(expression);
}

/**
 * The Candidate 5 preflight predicate with its PL/pgSQL locals inlined, so it can
 * be evaluated as plain SQL alongside the Candidate 4 expression.
 */
function preflightPredicate(): string {
  const writeScopes = validationSql.match(/v_write_scopes CONSTANT TEXT\[\] :=([\s\S]*?);/)?.[1];
  const readScope = validationSql.match(/v_read_scope CONSTANT TEXT\[\] :=([\s\S]*?);/)?.[1];
  const where = validationSql.match(/WHERE (scopes[\s\S]*?);/)?.[1];
  expect(writeScopes).toBeDefined();
  expect(readScope).toBeDefined();
  expect(where).toBeDefined();
  return String(where)
    .replaceAll('v_write_scopes', `(${String(writeScopes)})`)
    .replaceAll('v_read_scope', `(${String(readScope)})`);
}

const existingResourceConstraintNames = [
  'oauth_connections_environment_resource_fkey',
  'oauth_authorization_codes_environment_resource_fkey',
  'oauth_tokens_environment_resource_fkey',
] as const;

function runOwnerSql(
  sql: string,
  variables: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      env: { ...process.env, PGPASSWORD: 'postgres' },
      encoding: 'utf8',
      input: `\\set VERBOSITY verbose\n${sql}`,
    },
  );
}

function expectConstraintViolation(
  result: SpawnSyncReturns<string>,
  constraintName: (typeof stagedConstraintNames)[number],
): void {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('23514');
  expect(result.stderr).toContain('violates check constraint');
  expect(result.stderr).toContain(constraintName);
}

describe.skipIf(!RUN_LOCAL)('MCP Candidate 4 and 5 OAuth scope constraints', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const fixture = runOwnerSql(
      `
        INSERT INTO public.oauth_connections (
          id,
          user_id,
          client_id,
          resource_uri,
          scopes,
          write_enabled_at
        ) VALUES (
          :'connection_id'::UUID,
          :'user_id'::UUID,
          'chatgpt',
          :'resource_uri',
          ARRAY[
            'read:entries',
            'write:plans',
            'delete:plans',
            'write:records',
            'delete:records'
          ]::TEXT[],
          pg_catalog.now()
        );

        INSERT INTO public.oauth_authorization_codes (
          code_hash,
          user_id,
          client_id,
          redirect_uri,
          code_challenge,
          code_challenge_method,
          scopes,
          connection_id,
          resource_uri
        ) VALUES (
          :'code_hash',
          :'user_id'::UUID,
          'chatgpt',
          'https://chatgpt.com/connector_platform_oauth_redirect',
          'candidate-4-challenge',
          'S256',
          ARRAY[
            'read:entries',
            'write:plans',
            'delete:plans',
            'write:records',
            'delete:records'
          ]::TEXT[],
          :'connection_id'::UUID,
          :'resource_uri'
        );

        INSERT INTO public.oauth_tokens (
          id,
          user_id,
          token_hash,
          token_type,
          client_id,
          scopes,
          expires_at,
          connection_id,
          resource_uri
        ) VALUES (
          :'token_id'::UUID,
          :'user_id'::UUID,
          'candidate-4-token-' || :'token_id',
          'access',
          'chatgpt',
          ARRAY[
            'read:entries',
            'write:plans',
            'delete:plans',
            'write:records',
            'delete:records'
          ]::TEXT[],
          pg_catalog.now() + INTERVAL '5 minutes',
          :'connection_id'::UUID,
          :'resource_uri'
        );
      `,
      {
        user_id: userId,
        connection_id: connectionId,
        token_id: tokenId,
        code_hash: codeHash,
        resource_uri: productionResource,
      },
    );

    if (fixture.status !== 0) {
      throw new Error(fixture.stderr || 'Candidate 4 fixture setup failed');
    }
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(userId);
  });

  it('adds only the three staged checks without preflight or validation', () => {
    expect(candidateMigration.match(/NOT VALID;/g)).toHaveLength(3);
    expect(candidateMigration).not.toContain('VALIDATE CONSTRAINT');
    expect(candidateMigration).not.toContain('GRANT ');
    expect(candidateMigration).not.toContain('REVOKE ');
    expect(candidateMigration).not.toContain('UPDATE public.mcp_mutation_control');

    for (const scope of ['write:plans', 'delete:plans', 'write:records', 'delete:records']) {
      expect(candidateMigration.match(new RegExp(`'${scope}'`, 'g'))).toHaveLength(3);
    }
  });

  it('validates only the three staged checks and changes nothing else', () => {
    expect(validationSql.match(/VALIDATE CONSTRAINT \w+;/g)).toHaveLength(3);
    for (const constraintName of stagedConstraintNames) {
      expect(validationSql).toContain(`VALIDATE CONSTRAINT ${constraintName};`);
    }

    // Candidate 1 already validated these, so Candidate 5 must not restate them.
    for (const constraintName of existingResourceConstraintNames) {
      expect(validationSql).not.toContain(constraintName);
    }

    // Candidate 5 only advances constraint state. No schema restructuring, no
    // privilege change, no gate change, and above all no destructive
    // "remediation" of the very rows the preflight exists to surface: deleting a
    // write-only grant would destroy consent history instead of repairing it.
    expect(validationSql).not.toMatch(/\bNOT VALID\b/i);
    expect(validationSql).not.toMatch(/\bADD CONSTRAINT\b/i);
    expect(validationSql).not.toMatch(/\bDROP CONSTRAINT\b/i);
    expect(validationSql).not.toMatch(/\b(GRANT|REVOKE|TRUNCATE)\b/i);
    expect(validationSql).not.toMatch(
      /\b(DELETE\s+FROM|INSERT\s+INTO|UPDATE)\s+(public\.)?(oauth_|mcp_)/i,
    );
  });

  it('runs the read-only preflight over all three tables before validating', () => {
    // Order matters: with the scan first, validation fails on the same rows but
    // with a generic PostgreSQL message and the actionable abort never runs.
    const preflightIndex = validationSql.indexOf('DO $$');
    const firstValidateIndex = validationSql.indexOf('VALIDATE CONSTRAINT');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(firstValidateIndex).toBeGreaterThan(preflightIndex);

    // Each table is counted exactly once. Scanning one table three times is the
    // likely defect in a hand-duplicated block, and no runtime test would catch it.
    for (const table of stagedTableNames) {
      expect(validationSql.match(new RegExp(`FROM public\\.${table}\\b`, 'g'))).toHaveLength(1);
    }

    // The abort must be a check violation, and every interpolated argument must
    // be a plain count, so no row identity can reach the PostgreSQL log.
    // Anchor on the terminator, not the first `;` — the message text contains one.
    const raiseStatement = validationSql.match(
      /RAISE EXCEPTION[\s\S]*?USING ERRCODE = 'check_violation';/,
    )?.[0];
    expect(raiseStatement).toBeDefined();
    expect(raiseStatement).toContain('revocation alone is insufficient');
    const raiseArguments = String(raiseStatement).slice(String(raiseStatement).indexOf("',") + 2);
    expect(raiseArguments.match(/v_\w+_violations/g)).toHaveLength(3);
    expect(raiseArguments).not.toMatch(/\b(scopes|_agg|user_id|client_id|token_hash|code_hash)\b/);
    expect(
      validationSql.match(/SELECT pg_catalog\.count\(\*\)\s+INTO v_\w+_violations\b/g),
    ).toHaveLength(3);

    // The scan reads every row, so it needs a larger budget than the
    // metadata-only NOT VALID additions of Candidate 4. Assert the inequality
    // rather than the literal, so raising Candidate 4 cannot silently invert it.
    expect(statementTimeoutSeconds(validationSql)).toBeGreaterThan(
      statementTimeoutSeconds(candidateSql),
    );
    expect(validationSql).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it('preflights with the exact negation of the staged check expression', () => {
    // Evaluate both expressions in PostgreSQL over a probe set instead of
    // comparing source text. This catches an AND/OR inversion, a dropped NOT, a
    // rewrite to `= ANY (scopes)`, and any scope-set drift — none of which a
    // string match distinguishes. CHECK passes on TRUE or NULL; the preflight
    // WHERE matches only on TRUE, so the two must be exact complements.
    const result = runOwnerSql(`
      WITH probe(scopes) AS (
        VALUES
          (ARRAY[]::TEXT[]),
          (ARRAY['read:entries']::TEXT[]),
          (ARRAY['write:plans']::TEXT[]),
          (ARRAY['delete:records']::TEXT[]),
          (ARRAY['read:entries', 'write:plans']::TEXT[]),
          (ARRAY['read:entries', 'write:records', 'delete:plans']::TEXT[]),
          (ARRAY['write:plans', NULL]::TEXT[]),
          (ARRAY[NULL]::TEXT[])
      )
      SELECT pg_catalog.bool_and(
        COALESCE((${preflightPredicate()}), false) = NOT COALESCE((${stagedCheckExpression()}), true)
      )
      FROM probe;
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('t');
  });

  // Tautological once Candidate 5 has run: this re-evaluates the validated
  // constraints' own predicate over the same tables, so it cannot fail unless a
  // constraint is broken. It is kept as a cheap canary, not as evidence of data
  // health — the real evidence is the read-only production count recorded in the
  // Candidate 5 PR, plus the `convalidated` catalog assertion below.
  it('leaves no stored grant that the validated checks would reject', () => {
    const result = runOwnerSql(`
      SELECT NOT EXISTS (
        SELECT 1
        FROM (
          SELECT scopes FROM public.oauth_connections
          UNION ALL
          SELECT scopes FROM public.oauth_authorization_codes
          UNION ALL
          SELECT scopes FROM public.oauth_tokens
        ) AS stored_grants
        WHERE scopes && ARRAY[
            'write:plans',
            'delete:plans',
            'write:records',
            'delete:records'
          ]::TEXT[]
          AND NOT (scopes @> ARRAY['read:entries']::TEXT[])
      );
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('t');
  });

  // The preflight abort path has no runtime test. Once Candidate 5 has run, the
  // validated CHECK rejects every violating row and a CHECK constraint cannot be
  // deferred, so seeding a fixture that trips the preflight would mean dropping
  // the constraint this migration exists to enforce. The static assertions above
  // cover the preflight instead.

  it('marks the staged checks and the existing resource FKs as validated', () => {
    const result = runOwnerSql(`
      SELECT c.conname || '|' || c.contype::TEXT || '|' || c.convalidated::TEXT
      FROM pg_constraint AS c
      JOIN pg_class AS relation ON relation.oid = c.conrelid
      JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
      WHERE schema.nspname = 'public'
        AND c.conname = ANY (ARRAY[
          ${[...stagedConstraintNames, ...existingResourceConstraintNames]
            .map((name) => `'${name}'`)
            .join(',\n          ')}
        ]::TEXT[])
      ORDER BY c.conname;
    `);

    expect(result.status).toBe(0);
    // Sort both sides: SQL orders by conname, JS by the whole `name|type|valid`
    // string, and the two only agree while no name is a prefix of another.
    const catalogRows = result.stdout.trim().split('\n').sort();
    expect(catalogRows).toEqual(
      [
        ...existingResourceConstraintNames.map((name) => `${name}|f|true`),
        ...stagedConstraintNames.map((name) => `${name}|c|true`),
      ].sort(),
    );
  });

  it('accepts read plus write scopes while every write gate remains off', () => {
    const result = runOwnerSql(
      `
        SELECT
          (
            SELECT count(*) = 3
            FROM (
              SELECT scopes
              FROM public.oauth_connections
              WHERE id = :'connection_id'::UUID
              UNION ALL
              SELECT scopes
              FROM public.oauth_authorization_codes
              WHERE code_hash = :'code_hash'
              UNION ALL
              SELECT scopes
              FROM public.oauth_tokens
              WHERE id = :'token_id'::UUID
            ) AS valid_rows
            WHERE 'read:entries' = ANY (scopes)
              AND scopes && ARRAY[
                'write:plans',
                'delete:plans',
                'write:records',
                'delete:records'
              ]::TEXT[]
          )
          AND (
            SELECT NOT writes_enabled
              AND COALESCE(pg_catalog.cardinality(enabled_client_ids), 0) = 0
            FROM public.mcp_mutation_control
            WHERE singleton_key = true
          );
      `,
      {
        connection_id: connectionId,
        token_id: tokenId,
        code_hash: codeHash,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('t');
  });

  it('rejects new write-only rows through each staged constraint', () => {
    const connectionInsert = runOwnerSql(
      `
        INSERT INTO public.oauth_connections (
          user_id,
          client_id,
          resource_uri,
          scopes,
          write_enabled_at
        ) VALUES (
          :'user_id'::UUID,
          'chatgpt',
          :'resource_uri',
          ARRAY['write:plans']::TEXT[],
          pg_catalog.now()
        );
      `,
      { user_id: userId, resource_uri: productionResource },
    );
    expectConstraintViolation(
      connectionInsert,
      'oauth_connections_write_requires_read_entries_check',
    );

    const codeInsert = runOwnerSql(
      `
        INSERT INTO public.oauth_authorization_codes (
          code_hash,
          user_id,
          client_id,
          redirect_uri,
          code_challenge,
          code_challenge_method,
          scopes,
          connection_id,
          resource_uri
        ) VALUES (
          'candidate-4-invalid-code-' || :'user_id',
          :'user_id'::UUID,
          'chatgpt',
          'https://chatgpt.com/connector_platform_oauth_redirect',
          'candidate-4-challenge',
          'S256',
          ARRAY['write:plans']::TEXT[],
          :'connection_id'::UUID,
          :'resource_uri'
        );
      `,
      {
        user_id: userId,
        connection_id: connectionId,
        resource_uri: productionResource,
      },
    );
    expectConstraintViolation(
      codeInsert,
      'oauth_authorization_codes_write_requires_read_entries_check',
    );

    const tokenInsert = runOwnerSql(
      `
        INSERT INTO public.oauth_tokens (
          user_id,
          token_hash,
          token_type,
          client_id,
          scopes,
          expires_at,
          connection_id,
          resource_uri
        ) VALUES (
          :'user_id'::UUID,
          'candidate-4-invalid-token-' || :'user_id',
          'access',
          'chatgpt',
          ARRAY['write:plans']::TEXT[],
          pg_catalog.now() + INTERVAL '5 minutes',
          :'connection_id'::UUID,
          :'resource_uri'
        );
      `,
      {
        user_id: userId,
        connection_id: connectionId,
        resource_uri: productionResource,
      },
    );
    expectConstraintViolation(tokenInsert, 'oauth_tokens_write_requires_read_entries_check');
  });

  it('rejects updates from valid rows to write-only scopes', () => {
    const connectionUpdate = runOwnerSql(
      `
        UPDATE public.oauth_connections
        SET scopes = ARRAY['write:plans']::TEXT[]
        WHERE id = :'connection_id'::UUID;
      `,
      { connection_id: connectionId },
    );
    expectConstraintViolation(
      connectionUpdate,
      'oauth_connections_write_requires_read_entries_check',
    );

    const codeUpdate = runOwnerSql(
      `
        UPDATE public.oauth_authorization_codes
        SET scopes = ARRAY['write:plans']::TEXT[]
        WHERE code_hash = :'code_hash';
      `,
      { code_hash: codeHash },
    );
    expectConstraintViolation(
      codeUpdate,
      'oauth_authorization_codes_write_requires_read_entries_check',
    );

    const tokenUpdate = runOwnerSql(
      `
        UPDATE public.oauth_tokens
        SET scopes = ARRAY['write:plans']::TEXT[]
        WHERE id = :'token_id'::UUID;
      `,
      { token_id: tokenId },
    );
    expectConstraintViolation(tokenUpdate, 'oauth_tokens_write_requires_read_entries_check');
  });

  it('preserves the mixed-version OAuth compatibility grants', () => {
    const result = runOwnerSql(`
      SELECT
        pg_catalog.has_table_privilege(
          'authenticated',
          'public.oauth_connections',
          'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'public.oauth_connections',
          'INSERT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'public.oauth_tokens',
          'SELECT'
        )
        AND pg_catalog.has_column_privilege(
          'authenticated',
          'public.oauth_tokens',
          'id',
          'SELECT'
        )
        AND NOT pg_catalog.has_column_privilege(
          'authenticated',
          'public.oauth_tokens',
          'token_hash',
          'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'service_role',
          'public.oauth_connections',
          'INSERT'
        )
        AND pg_catalog.has_column_privilege(
          'service_role',
          'public.oauth_connections',
          'last_used_at',
          'UPDATE'
        )
        AND pg_catalog.has_table_privilege(
          'service_role',
          'public.oauth_authorization_codes',
          'INSERT'
        )
        AND pg_catalog.has_table_privilege(
          'service_role',
          'public.oauth_tokens',
          'INSERT'
        );
    `);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('t');
  });
});
