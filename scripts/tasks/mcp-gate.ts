#!/usr/bin/env node
/**
 * MCP write gate 操作スクリプト（issue #1754 Production closed beta）
 *
 * `public.mcp_mutation_control`（global write gate + client allowlist）を
 * service_role 経由の SECURITY DEFINER RPC（`set_mcp_mutation_control_v1` /
 * `set_mcp_client_write_control_v1`）だけで操作する。直接 UPDATE できる GRANT は
 * どのロールにも無い（`supabase/migrations/20260729062445_mcp_mutation_envelope_foundation.sql`
 * / `20260729073125_mcp_environment_identity_client_fence.sql`）。
 *
 * `@supabase/supabase-js` は apps/product 専属の依存で root scripts からは
 * phantom dependency になるため使わない。PostgREST の REST / RPC endpoint を
 * 素の `fetch` で直接叩く（依存追加なし）。
 *
 * 既定は read-only（現在の gate 状態を表示するだけ）。書き込みは明示フラグが必要。
 *
 * Usage:
 *   pnpm mcp:gate
 *   pnpm mcp:gate -- --enable-global
 *   pnpm mcp:gate -- --disable-global
 *   pnpm mcp:gate -- --enable-client=claude-ai
 *   pnpm mcp:gate -- --disable-client=claude-ai
 *
 * 必須 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * （production 値は 1Password `app` item。`op run -- pnpm mcp:gate ...` で渡す）
 *
 * revision は毎回 DB から読み直して渡す（CAS）。同時実行での取り違えを防ぐため、
 * 書き込み系オプションは 1 回の呼び出しにつき 1 個までしか受け付けない。
 */

const VALID_CLIENT_IDS = ['claude-ai', 'chatgpt', 'cursor'] as const;
type OAuthClientId = (typeof VALID_CLIENT_IDS)[number];

interface MutationControlRow {
  writes_enabled: boolean;
  enabled_client_ids: string[];
  revision: number;
  changed_at: string;
}

function isValidClientId(value: string): value is OAuthClientId {
  return (VALID_CLIENT_IDS as readonly string[]).includes(value);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    flags.set(key, value ?? true);
  }
  return flags;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `環境変数 ${name} が未設定です。service_role 権限の値を op run 等で渡してください。`,
    );
    process.exit(1);
  }
  return value;
}

async function restRequest<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`PostgREST ${response.status}: ${body}`);
  }
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

async function readControl(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<MutationControlRow> {
  const rows = await restRequest<MutationControlRow[]>(
    supabaseUrl,
    serviceRoleKey,
    'mcp_mutation_control?select=writes_enabled,enabled_client_ids,revision,changed_at',
  );
  const [row] = rows;
  if (!row) {
    throw new Error('mcp_mutation_control の行が見つかりません（DM002 相当）。');
  }
  return row;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  const writeFlags = ['enable-global', 'disable-global', 'enable-client', 'disable-client'].filter(
    (key) => flags.has(key),
  );
  if (writeFlags.length > 1) {
    console.error(`書き込み系オプションは 1 回に 1 個までです（指定: ${writeFlags.join(', ')}）。`);
    process.exit(1);
  }

  // --enable-global / --disable-global は bare boolean flag（値を取らない）。
  // `--enable-global=false` のような入力は flags.has('enable-global') が
  // true のままになり、値を無視して gate を ON にしてしまう（意図と逆方向の
  // 書き込み）。値付きで渡された場合は解釈せずに拒否する。
  for (const key of ['enable-global', 'disable-global'] as const) {
    if (flags.get(key) !== undefined && flags.get(key) !== true) {
      console.error(
        `--${key} は値を取りません（例: --${key}）。--${key}=${String(flags.get(key))} のような指定は意図しない方向へ倒れうるため拒否します。`,
      );
      process.exit(1);
    }
  }

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const control = await readControl(supabaseUrl, serviceRoleKey);

  console.log('--- 現在の MCP write gate 状態 ---');
  console.log(`writes_enabled: ${control.writes_enabled}`);
  console.log(`enabled_client_ids: ${JSON.stringify(control.enabled_client_ids)}`);
  console.log(`revision: ${control.revision}`);
  console.log(`changed_at: ${control.changed_at}`);

  if (writeFlags.length === 0) {
    console.log(
      '\n(read-only 実行。書き込むには --enable-global / --disable-global / --enable-client=<id> / --disable-client=<id> を指定してください)',
    );
    return;
  }

  const revision = control.revision;

  if (flags.has('enable-global') || flags.has('disable-global')) {
    const writesEnabled = flags.has('enable-global');
    const [result] = await restRequest<[Record<string, unknown>]>(
      supabaseUrl,
      serviceRoleKey,
      'rpc/set_mcp_mutation_control_v1',
      {
        method: 'POST',
        body: JSON.stringify({ p_writes_enabled: writesEnabled, p_expected_revision: revision }),
      },
    );
    console.log(`\nglobal gate を ${writesEnabled ? 'ON' : 'OFF'} にしました。`, result);
    return;
  }

  const clientFlagKey = flags.has('enable-client') ? 'enable-client' : 'disable-client';
  const clientId = flags.get(clientFlagKey);
  if (typeof clientId !== 'string' || !isValidClientId(clientId)) {
    console.error(
      `--${clientFlagKey} には ${VALID_CLIENT_IDS.join(' / ')} のいずれかを指定してください（例: --${clientFlagKey}=claude-ai）。`,
    );
    process.exit(1);
  }

  const enabled = clientFlagKey === 'enable-client';
  const [result] = await restRequest<[Record<string, unknown>]>(
    supabaseUrl,
    serviceRoleKey,
    'rpc/set_mcp_client_write_control_v1',
    {
      method: 'POST',
      body: JSON.stringify({
        p_client_id: clientId,
        p_enabled: enabled,
        p_expected_revision: revision,
      }),
    },
  );
  console.log(
    `\nclient "${clientId}" の write scope を ${enabled ? '許可' : '除外'} しました。`,
    result,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
