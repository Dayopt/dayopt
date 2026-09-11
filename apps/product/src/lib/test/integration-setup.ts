import { spawnSync } from 'node:child_process';

import { vi } from 'vitest';

// Server services create their own Supabase client. Keep those clients on the
// same local project as the direct integration-test clients when env is absent.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??=
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5Nn0.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
process.env.SUPABASE_SECRET_KEY ??=
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

if (process.env.USE_LOCAL_DB === 'true') {
  const identityBootstrap = spawnSync(
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
      input: `
        INSERT INTO public.mcp_environment_identity (
          singleton_key,
          environment,
          authorization_server_uri,
          resource_uri
        ) VALUES (
          true,
          'production',
          'https://app.dayopt.app',
          'https://mcp.dayopt.app'
        )
        ON CONFLICT (singleton_key) DO NOTHING;
      `,
    },
  );

  if (identityBootstrap.status !== 0) {
    throw new Error(identityBootstrap.stderr || 'Local MCP environment identity bootstrap failed');
  }
}

// server-only: テスト環境ではサーバーコンポーネント制約を無効化
vi.mock('server-only', () => ({}));
