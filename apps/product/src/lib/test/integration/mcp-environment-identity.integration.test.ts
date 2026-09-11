import { spawnSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@/lib/database';
import { hashToken } from '@/lib/oauth-server';

import { deriveStage1PkceS256Challenge } from './mcp-stage1-crypto';

const LOCAL_DB_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';
const productionResource = 'https://mcp.dayopt.app';
const foreignResource = 'https://mcp.staging.dayopt.app';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const challenge = deriveStage1PkceS256Challenge('v'.repeat(43));

const admin = createClient<Database>(LOCAL_DB_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authenticated = createClient<Database>(LOCAL_DB_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = crypto.randomUUID();
const email = `mcp-environment-${userId}@example.com`;
const password = 'test-password-123';

function runOwnerSql(sql: string) {
  return spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
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
      input: sql,
    },
  );
}

describe.skipIf(!RUN_LOCAL)('MCP environment identity integration', () => {
  beforeAll(async () => {
    const { error } = await admin.auth.admin.createUser({
      id: userId,
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const { error: signInError } = await authenticated.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
  });

  afterAll(async () => {
    await authenticated.auth.signOut();
    await admin.auth.admin.deleteUser(userId);
  });

  it('exposes the immutable tuple only through the service-role getter', async () => {
    const { data, error } = await admin.rpc('get_mcp_environment_identity_v1');
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({
        environment: 'production',
        authorization_server_uri: 'https://app.dayopt.app',
        resource_uri: productionResource,
        supabase_project_ref: null,
      }),
    ]);

    const [{ error: browserGetterError }, { error: directReadError }] = await Promise.all([
      authenticated.rpc('get_mcp_environment_identity_v1'),
      admin.from('mcp_environment_identity').select('environment'),
    ]);
    expect(browserGetterError?.code).toBe('42501');
    expect(directReadError?.code).toBe('42501');

    const immutableUpdate = runOwnerSql(`
      UPDATE public.mcp_environment_identity
      SET resource_uri = '${foreignResource}'
      WHERE singleton_key = true;
    `);
    expect(immutableUpdate.status).not.toBe(0);
    expect(immutableUpdate.stderr).toContain('MCP environment identity is immutable');
  });

  it('rejects a foreign resource before creating or consuming authority', async () => {
    const directInsert = runOwnerSql(`
      INSERT INTO public.oauth_connections (
        user_id,
        client_id,
        resource_uri,
        scopes
      ) VALUES (
        '${userId}'::UUID,
        'chatgpt',
        '${foreignResource}',
        ARRAY['read:entries']::TEXT[]
      );
    `);
    expect(directInsert.status).not.toBe(0);
    expect(directInsert.stderr).toContain('oauth_connections_environment_resource_fkey');

    const codeHash = hashToken(`foreign-resource-${crypto.randomUUID()}`);
    const { error: grantError } = await admin.rpc('create_oauth_authorization_grant_v2', {
      p_user_id: userId,
      p_client_id: 'chatgpt',
      p_resource_uri: foreignResource,
      p_scopes: ['read:entries'],
      p_code_hash: codeHash,
      p_redirect_uri: redirectUri,
      p_code_challenge: challenge,
      p_write_enabled: false,
    });
    expect(grantError?.code).toBe('22023');

    const { count: codeCount } = await admin
      .from('oauth_authorization_codes')
      .select('code_hash', { count: 'exact', head: true })
      .eq('code_hash', codeHash);
    expect(codeCount).toBe(0);
  });

  it('provisions empty or exact unused-seed Preview and rejects changed authority', () => {
    const previewRef = 'abcdefghijklmnopqrst';
    const previewUrl = 'https://product-git-mcp-safe-dayopt.vercel.app';
    const previewProof = runOwnerSql(`
      BEGIN;

      TRUNCATE auth.users CASCADE;
      UPDATE public.mcp_mutation_control
      SET
        writes_enabled = false,
        enabled_client_ids = ARRAY[]::TEXT[],
        revision = revision + 1,
        changed_at = pg_catalog.clock_timestamp()
      WHERE singleton_key = true;

      ALTER TABLE public.mcp_environment_identity
        DISABLE TRIGGER trigger_prevent_mcp_environment_identity_change;
      DELETE FROM public.mcp_environment_identity;
      ALTER TABLE public.mcp_environment_identity
        ENABLE TRIGGER trigger_prevent_mcp_environment_identity_change;

      DO $$
      BEGIN
        PERFORM pg_catalog.set_config(
          'request.jwt.claims',
          '{"role":"service_role","ref":"${previewRef}"}',
          true
        );
      END;
      $$;

      CREATE FUNCTION pg_temp.assert_preview_provision_rejected(
        p_expected_sqlstate TEXT
      )
      RETURNS VOID
      LANGUAGE plpgsql
      SET search_path = ''
      AS $assert$
      DECLARE
        v_actual_sqlstate TEXT;
      BEGIN
        BEGIN
          PERFORM *
          FROM public.provision_mcp_preview_environment_identity_v1(
            '${previewUrl}',
            '${previewUrl}',
            '${previewRef}'
          );
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            v_actual_sqlstate = RETURNED_SQLSTATE;

          IF v_actual_sqlstate IS DISTINCT FROM p_expected_sqlstate THEN
            RAISE EXCEPTION
              'Expected SQLSTATE %, received %',
              p_expected_sqlstate,
              v_actual_sqlstate;
          END IF;

          IF EXISTS (SELECT 1 FROM public.mcp_environment_identity) THEN
            RAISE EXCEPTION
              'Rejected Preview provisioning created an environment identity';
          END IF;
          RETURN;
        END;

        RAISE EXCEPTION
          'Preview provisioning unexpectedly accepted SQLSTATE % case',
          p_expected_sqlstate;
      END;
      $assert$;

      CREATE FUNCTION pg_temp.insert_preview_seed_shaped_user(
        p_user_id UUID,
        p_email TEXT,
        p_phone TEXT
      )
      RETURNS VOID
      LANGUAGE sql
      SET search_path = ''
      AS $fixture$
        INSERT INTO auth.users (
          id,
          instance_id,
          email,
          encrypted_password,
          email_confirmed_at,
          raw_app_meta_data,
          raw_user_meta_data,
          created_at,
          updated_at,
          role,
          aud,
          confirmation_token,
          recovery_token,
          email_change_token_new,
          email_change,
          email_change_token_current,
          phone,
          phone_change,
          phone_change_token,
          reauthentication_token,
          email_change_confirm_status
        ) VALUES (
          p_user_id,
          '00000000-0000-0000-0000-000000000000',
          p_email,
          extensions.crypt(
            'TestPassword123!',
            extensions.gen_salt('bf')
          ),
          pg_catalog.now(),
          '{"provider":"email","providers":["email"]}',
          '{"full_name":"Test User"}',
          pg_catalog.now(),
          pg_catalog.now(),
          'authenticated',
          'authenticated',
          '',
          '',
          '',
          '',
          '',
          p_phone,
          '',
          '',
          '',
          0
        );
      $fixture$;

      -- An actually empty Preview database remains a valid first-run case.
      SELECT resource_uri
      FROM public.provision_mcp_preview_environment_identity_v1(
        '${previewUrl}',
        '${previewUrl}',
        '${previewRef}'
      );

      ALTER TABLE public.mcp_environment_identity
        DISABLE TRIGGER trigger_prevent_mcp_environment_identity_change;
      DELETE FROM public.mcp_environment_identity;
      ALTER TABLE public.mcp_environment_identity
        ENABLE TRIGGER trigger_prevent_mcp_environment_identity_change;

      -- UUID and email are independently bound to the deterministic fixture.
      SELECT pg_temp.insert_preview_seed_shaped_user(
        '00000000-0000-0000-0000-000000000002'::UUID,
        'test@dayopt.dev',
        ''
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      TRUNCATE auth.users CASCADE;

      SELECT pg_temp.insert_preview_seed_shaped_user(
        '00000000-0000-0000-0000-000000000001'::UUID,
        'wrong-preview-user@example.com',
        ''
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      TRUNCATE auth.users CASCADE;

      SELECT pg_temp.insert_preview_seed_shaped_user(
        '00000000-0000-0000-0000-000000000001'::UUID,
        'test@dayopt.dev',
        ''
      );

      INSERT INTO auth.identities (
        id,
        user_id,
        provider_id,
        provider,
        identity_data,
        last_sign_in_at,
        created_at,
        updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        'test@dayopt.dev',
        'email',
        '{"sub":"00000000-0000-0000-0000-000000000001","email":"test@dayopt.dev"}',
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
      );

      -- An additional user cannot hide behind the valid seed user.
      SELECT pg_temp.insert_preview_seed_shaped_user(
        '00000000-0000-0000-0000-000000000002'::UUID,
        'unknown-preview-user@example.com',
        NULL
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      DELETE FROM auth.users
      WHERE id = '00000000-0000-0000-0000-000000000002'::UUID;

      -- Changed credentials and any second provider identity are rejected.
      UPDATE auth.users
      SET encrypted_password = extensions.crypt(
        'ChangedPassword123!',
        extensions.gen_salt('bf')
      )
      WHERE id = '00000000-0000-0000-0000-000000000001'::UUID;
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      UPDATE auth.users
      SET encrypted_password = extensions.crypt(
        'TestPassword123!',
        extensions.gen_salt('bf')
      )
      WHERE id = '00000000-0000-0000-0000-000000000001'::UUID;

      INSERT INTO auth.identities (
        id,
        user_id,
        provider_id,
        provider,
        identity_data,
        last_sign_in_at,
        created_at,
        updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'preview-google-subject',
        'google',
        '{"sub":"preview-google-subject","email":"test@dayopt.dev"}',
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      DELETE FROM auth.identities
      WHERE id = '00000000-0000-0000-0000-000000000002'::UUID;

      -- Supabase Auth OAuth state has no user FK, but still blocks identity.
      INSERT INTO auth.oauth_client_states (
        id,
        provider_type,
        code_verifier,
        created_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000003',
        'google',
        'preview-code-verifier',
        pg_catalog.now()
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI005');
      DELETE FROM auth.oauth_client_states;

      -- The exact seed fixture still fails closed after MCP OAuth authority.
      INSERT INTO public.oauth_audit_log (
        user_id,
        client_id,
        tool_name
      ) VALUES (
        '00000000-0000-0000-0000-000000000001',
        'chatgpt',
        'entries.list'
      );
      SELECT pg_temp.assert_preview_provision_rejected('DI006');
      DELETE FROM public.oauth_audit_log;

      SELECT resource_uri
      FROM public.provision_mcp_preview_environment_identity_v1(
        '${previewUrl}',
        '${previewUrl}',
        '${previewRef}'
      );

      SELECT resource_uri
      FROM public.provision_mcp_preview_environment_identity_v1(
        '${previewUrl}',
        '${previewUrl}',
        '${previewRef}'
      );

      DO $$
      DECLARE
        v_replacement_rejected BOOLEAN := false;
        v_update_rejected BOOLEAN := false;
      BEGIN
        BEGIN
          PERFORM *
          FROM public.provision_mcp_preview_environment_identity_v1(
            'https://product-git-other-dayopt.vercel.app',
            'https://product-git-other-dayopt.vercel.app',
            '${previewRef}'
          );
        EXCEPTION WHEN SQLSTATE 'DI002' THEN
          v_replacement_rejected := true;
        END;

        BEGIN
          UPDATE public.mcp_environment_identity
          SET authorization_server_uri = 'https://product-git-other-dayopt.vercel.app'
          WHERE singleton_key = true;
        EXCEPTION WHEN check_violation THEN
          v_update_rejected := true;
        END;

        IF NOT v_replacement_rejected OR NOT v_update_rejected THEN
          RAISE EXCEPTION 'Preview identity replacement was not rejected';
        END IF;
      END;
      $$;

      ROLLBACK;
    `);

    expect(previewProof.status, previewProof.stderr).toBe(0);
    expect(previewProof.stdout.trim().split('\n').filter(Boolean)).toEqual([
      previewUrl,
      previewUrl,
      previewUrl,
    ]);
  });
});
