import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { main } from './agent-service-account.mjs';

// Convenience entry point for ordinary Codex op calls, not an OS isolation boundary.
// Human authentication is used only to resolve the explicitly configured bootstrap item.
export async function runAgentOp(args, config, env = process.env) {
  const opArgs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (
    opArgs.some((arg) => /^--(?:account|session|config|debug)(?:=|$)/.test(arg)) ||
    ['signin', 'signout'].includes(args[0])
  )
    throw new Error('AUTH_OVERRIDE_DENIED');
  if (
    !isAbsolute(config.binary ?? '') ||
    !['account', 'vault', 'item', 'serviceAccountId', 'agentVaultId'].every((key) =>
      /^[a-z2-7]{26}$/i.test(config[key] ?? ''),
    )
  )
    throw new Error('CONFIG_INVALID');

  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('OP_')));
  const bootstrap = spawnSync(
    config.binary,
    [
      'item',
      'get',
      config.item,
      '--vault',
      config.vault,
      '--account',
      config.account,
      '--format=json',
    ],
    {
      env: { ...clean, OP_DEBUG: 'false', OP_CACHE: 'false' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    },
  );
  if (bootstrap.error || bootstrap.status !== 0) throw new Error('BOOTSTRAP_FAILED');
  let item;
  try {
    item = JSON.parse(bootstrap.stdout);
  } catch {
    throw new Error('BOOTSTRAP_RESPONSE_INVALID');
  }
  const tokens = [
    ...new Set(
      (item.fields ?? [])
        .map((field) => field.value)
        .filter((value) => typeof value === 'string' && value.startsWith('ops_')),
    ),
  ];
  if (tokens.length !== 1) throw new Error('TOKEN_FIELD_NOT_UNIQUE');

  try {
    return await main(['run', '--', config.binary, ...args], {
      ...clean,
      // Metadata verification must resolve the real executable, not this entry point.
      PATH: `${dirname(config.binary)}:${clean.PATH ?? ''}`,
      OP_SERVICE_ACCOUNT_TOKEN: tokens[0],
      DAYOPT_AGENT_SERVICE_ACCOUNT_ID: config.serviceAccountId,
      DAYOPT_AGENT_VAULT_ID: config.agentVaultId,
    });
  } catch (error) {
    const codes = [
      'TOKEN_INVALID',
      'AUTH_FAILED',
      'IDENTITY_MISMATCH',
      'VAULT_LIST_FAILED',
      'VAULT_SCOPE_MISMATCH',
      'METADATA_INVALID',
    ];
    throw new Error(codes.includes(error.code) ? error.code : 'SA_CHECK_FAILED');
  }
}
