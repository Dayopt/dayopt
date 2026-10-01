import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { main } from './agent-service-account.mjs';

// Convenience entry point for ordinary Codex op calls, not an OS isolation boundary.
// Only an injected SA token or the dedicated macOS Keychain item is accepted.
export async function runAgentOp(args, config, env = process.env) {
  const opArgs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (
    opArgs.some((arg) => /^--(?:account|session|config|debug)(?:=|$)/.test(arg)) ||
    ['signin', 'signout'].includes(args[0])
  )
    throw new Error('AUTH_OVERRIDE_DENIED');
  if (
    !isAbsolute(config.binary ?? '') ||
    !['serviceAccountId', 'agentVaultId'].every((key) => /^[a-z2-7]{26}$/i.test(config[key] ?? ''))
  )
    throw new Error('CONFIG_INVALID');

  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('OP_')));
  let token = env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    const reader = config.keychainBinary ?? '/usr/bin/security';
    if (!isAbsolute(reader)) throw new Error('CONFIG_INVALID');
    const stored = spawnSync(
      reader,
      [
        'find-generic-password',
        '-s',
        'dayopt-agent-service-account',
        '-a',
        config.serviceAccountId,
        '-w',
      ],
      {
        env: clean,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
    );
    if (stored.error || stored.status !== 0) throw new Error('TOKEN_UNAVAILABLE');
    token = stored.stdout.trim();
  }
  if (!token.startsWith('ops_')) throw new Error('TOKEN_INVALID');

  try {
    return await main(['run', '--', config.binary, ...args], {
      ...clean,
      // Metadata verification must resolve the real executable, not this entry point.
      PATH: `${dirname(config.binary)}:${clean.PATH ?? ''}`,
      OP_SERVICE_ACCOUNT_TOKEN: token,
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
