import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// CI's disposable PostgreSQL only. Never resolve credentials or accept a DB URL.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true')
  throw new Error('Catalog hash rehearsal requires isolated CI');

const readMigration = (name) =>
  readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replace(/^(BEGIN|COMMIT);\s*$/gm, '');
const initial = [
  '20260927034912_integration_oauth_environment_identity',
  '20260927102812_fix_integration_oauth_origin',
]
  .map(readMigration)
  .join('\n');
const align = readMigration('20260928044000_align_integration_oauth_branch_origin');
const prepare = readMigration('20260928043959_prepare_integration_catalog_hash');
const harden = readMigration('20260930020815_harden_integration_oauth_authority');
const remove = readMigration('20260930020816_remove_integration_catalog_hash_helper');
const setup = `BEGIN;
SET LOCAL app.isolated_validation = on;
INSERT INTO public.mcp_environment_identity (
  singleton_key, environment, authorization_server_uri, resource_uri, supabase_project_ref
) VALUES (true, 'production', 'https://app.dayopt.app', 'https://mcp.dayopt.app', NULL);
CREATE TEMP TABLE authority_before AS SELECT * FROM public.mcp_environment_identity;
ALTER EXTENSION pgcrypto SET SCHEMA auth;
DROP FUNCTION public.ensure_mcp_integration_environment_identity_v1();
${initial}
`;
const run = (sql) =>
  execFileSync(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
    ],
    {
      input: sql,
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: 'postgres' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

let reproduced = false;
try {
  run(`${setup}\n${align}\nROLLBACK;`);
} catch (error) {
  reproduced =
    /42883/.test(String(error.stderr)) && /extensions\.digest/.test(String(error.stderr));
}
if (!reproduced) throw new Error('Missing Production catalog hash was not reproduced');

run(`${setup}
${prepare}
${align}
${harden}
${remove}
DO $assert$
BEGIN
  IF to_regprocedure('extensions.digest(text,text)') IS NOT NULL
    OR (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
        WHERE e.extname='pgcrypto') <> 'auth'
    OR EXISTS ((SELECT * FROM authority_before EXCEPT SELECT * FROM public.mcp_environment_identity)
      UNION ALL (SELECT * FROM public.mcp_environment_identity EXCEPT SELECT * FROM authority_before))
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid =
      'public.provision_mcp_preview_environment_identity_v1(text,text,text)'::regprocedure
      AND strpos(prosrc, 'p_supabase_project_ref = ''tilwaprottpyhlfoggbb''') > 0)
  THEN RAISE EXCEPTION 'Production catalog hash rehearsal differs'; END IF;
END
$assert$;
ROLLBACK;
`);
console.log(
  'Production pgcrypto namespace: original failure reproduced; migration chain passed; identity preserved; helper removed; rollback completed',
);
