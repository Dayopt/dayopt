#!/usr/bin/env node
/**
 * MCP write gate 操作スクリプト（issue #1754 Production closed beta）
 *
 * `public.mcp_mutation_control`（global write gate + client allowlist + 利用権判定の
 * 切替）を service_role 経由の SECURITY DEFINER RPC（`set_mcp_mutation_control_v1` /
 * `set_mcp_client_write_control_v1` / `set_mcp_billing_enforcement_v1`）だけで操作する。
 * 直接 UPDATE できる GRANT はどのロールにも無い
 * （`supabase/migrations/20260729062445_mcp_mutation_envelope_foundation.sql`
 * / `20260729073125_mcp_environment_identity_client_fence.sql`
 * / `20260908022927_add_mcp_billing_access_switch.sql`）。
 *
 * `billing_enforced` は MCP **書き込み**の DB 側利用権判定（`private.authorize_mcp_mutation_v1`）
 * の切替。false（既定）は契約中（active / trialing / past_due）だけを通す旧契約、true は
 * 45 日無料体験中も通す単一プラン契約。読み取り側の判定は env `BILLING_ENFORCED`
 * （app 層 `checkMcpEntitlement`）が持ち、この列とは独立。切替順序は
 * `docs/operations/billing-single-plan-rollout.md` §公開順序 / §復帰 に従う。
 *
 * `@supabase/supabase-js` は apps/product 専属の依存で root scripts からは
 * phantom dependency になるため使わない。PostgREST の REST / RPC endpoint を
 * 素の `fetch` で直接叩く（依存追加なし）。
 *
 * 既定は read-only（現在の gate 状態を表示するだけ）。書き込みは明示フラグが必要。
 *
 * Usage:
 *   pnpm mcp:gate
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --enable-global
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --disable-global
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --enable-client=claude-ai
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --disable-client=claude-ai
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --enable-billing
 *   pnpm mcp:gate -- --expect-url='<origin>' --expect-environment=production --disable-billing
 *
 * 必須 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
 * （production は人間が `.op-env.human` を消費する。runbook §MCP write gate を参照）
 *
 * revision は毎回 DB から読み直して渡す（CAS）。同時実行での取り違えを防ぐため、
 * 書き込み系オプションは 1 回の呼び出しにつき 1 個までしか受け付けない。
 */

import { pathToFileURL } from 'node:url';

const VALID_CLIENT_IDS = ['claude-ai', 'chatgpt', 'cursor'] as const;
type OAuthClientId = (typeof VALID_CLIENT_IDS)[number];

interface MutationControlRow {
  writes_enabled: boolean;
  billing_enforced: boolean;
  enabled_client_ids: string[];
  revision: number;
  changed_at: string;
}

function isValidClientId(value: string): value is OAuthClientId {
  return (VALID_CLIENT_IDS as readonly string[]).includes(value);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const allowed = new Set([
    'enable-global',
    'disable-global',
    'enable-client',
    'disable-client',
    'enable-billing',
    'disable-billing',
    'expect-url',
    'expect-environment',
  ]);
  for (const raw of argv) {
    if (raw === '--') continue;
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!match || !allowed.has(match[1]!) || flags.has(match[1]!)) {
      throw new Error('不明または重複したオプションです。');
    }
    flags.set(match[1]!, match[2] ?? true);
  }
  return flags;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} が未設定です。`);
  return value;
}

function validateUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Supabase URL は HTTPS origin（local は HTTP 可）で指定してください。');
  }
  return url.origin;
}

async function restRequest<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    // Do not echo arbitrary upstream bodies or credentials into the runbook log.
    throw new Error(
      `PostgREST ${response.status}。状態を再確認してください（自動再試行しません）。`,
    );
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
    'mcp_mutation_control?select=writes_enabled,billing_enforced,enabled_client_ids,revision,changed_at',
  );
  const [row] = rows;
  if (!row) {
    throw new Error('mcp_mutation_control の行が見つかりません（DM002 相当）。');
  }
  return row;
}

export async function runMcpGate(argv: string[], env: NodeJS.ProcessEnv) {
  const flags = parseArgs(argv);

  const writeFlags = [
    'enable-global',
    'disable-global',
    'enable-client',
    'disable-client',
    'enable-billing',
    'disable-billing',
  ].filter((key) => flags.has(key));
  if (writeFlags.length > 1) {
    throw new Error('書き込み系オプションは 1 回に 1 個までです。');
  }

  // --enable-global / --disable-global / --enable-billing / --disable-billing は
  // bare boolean flag（値を取らない）。`--enable-global=false` のような入力は
  // flags.has('enable-global') が true のままになり、値を無視して gate を ON に
  // してしまう（意図と逆方向の書き込み）。値付きで渡された場合は解釈せずに拒否する。
  for (const key of [
    'enable-global',
    'disable-global',
    'enable-billing',
    'disable-billing',
  ] as const) {
    if (flags.get(key) !== undefined && flags.get(key) !== true) {
      throw new Error(`--${key} は値を取りません。`);
    }
  }

  const supabaseUrl = validateUrl(requireEnv(env, 'NEXT_PUBLIC_SUPABASE_URL'));
  const serviceRoleKey = requireEnv(env, 'SUPABASE_SECRET_KEY');
  const expectedUrl = flags.get('expect-url');
  const expectedEnvironment = flags.get('expect-environment');
  const writing = writeFlags.length > 0;
  if (writing && (typeof expectedUrl !== 'string' || typeof expectedEnvironment !== 'string')) {
    throw new Error(
      '書き込みには --expect-url=<origin> と --expect-environment=production|preview が必要です。',
    );
  }
  if (
    expectedUrl !== undefined &&
    (typeof expectedUrl !== 'string' || validateUrl(expectedUrl) !== supabaseUrl)
  ) {
    throw new Error('期待した Supabase URL と接続先が一致しません。');
  }
  if (
    expectedEnvironment !== undefined &&
    !['production', 'preview'].includes(String(expectedEnvironment))
  ) {
    throw new Error('期待環境は production または preview です。');
  }
  for (const key of ['enable-client', 'disable-client']) {
    const value = flags.get(key);
    if (value !== undefined && (typeof value !== 'string' || !isValidClientId(value))) {
      throw new Error(`--${key} は claude-ai / chatgpt / cursor を指定してください。`);
    }
  }
  const identities = await restRequest<Array<{ environment: string }>>(
    supabaseUrl,
    serviceRoleKey,
    'rpc/get_mcp_environment_identity_v1',
    { method: 'POST', body: '{}' },
  );
  if (
    identities.length !== 1 ||
    !['production', 'preview'].includes(identities[0]!.environment) ||
    (expectedEnvironment !== undefined && identities[0]!.environment !== expectedEnvironment)
  ) {
    throw new Error('DB の MCP identity が期待環境と一致しません。');
  }
  console.log(`target: ${supabaseUrl} (${identities[0]!.environment})`);

  const control = await readControl(supabaseUrl, serviceRoleKey);

  console.log('--- 現在の MCP write gate 状態 ---');
  console.log(`writes_enabled: ${control.writes_enabled}`);
  console.log(`enabled_client_ids: ${JSON.stringify(control.enabled_client_ids)}`);
  console.log(
    `billing_enforced: ${control.billing_enforced}（write の利用権判定。false=契約中のみ / true=45 日体験中も可）`,
  );
  console.log(`revision: ${control.revision}`);
  console.log(`changed_at: ${control.changed_at}`);

  if (writeFlags.length === 0) {
    console.log(
      '\n(read-only 実行。書き込むには --enable-global / --disable-global / --enable-client=<id> / --disable-client=<id> / --enable-billing / --disable-billing を指定してください)',
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

  if (flags.has('enable-billing') || flags.has('disable-billing')) {
    const billingEnforced = flags.has('enable-billing');
    const [result] = await restRequest<[Record<string, unknown>]>(
      supabaseUrl,
      serviceRoleKey,
      'rpc/set_mcp_billing_enforcement_v1',
      {
        method: 'POST',
        body: JSON.stringify({
          p_billing_enforced: billingEnforced,
          p_expected_revision: revision,
        }),
      },
    );
    console.log(
      `\nMCP write の利用権判定を ${billingEnforced ? '単一プラン契約（45 日体験中も可）' : '旧契約（契約中のみ）'} にしました。`,
      result,
    );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpGate(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'MCP gate 操作に失敗しました。');
    process.exitCode = 1;
  });
}
