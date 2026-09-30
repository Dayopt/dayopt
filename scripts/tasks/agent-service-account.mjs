import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OP_TIMEOUT_MS = 10_000;
const OP_ID = /^[a-z2-7]{26}$/;

class ServiceAccountError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// 設定の存在だけを見る。認証・vault 権限・OS の隔離を証明するものではない。
export function collectOnePasswordConfig(env = process.env) {
  return {
    tokenPresent: Boolean(env.OP_SERVICE_ACCOUNT_TOKEN?.trim()),
    expectedAccountConfigured: Boolean(env.DAYOPT_AGENT_SERVICE_ACCOUNT_ID?.trim()),
    expectedVaultConfigured: Boolean(env.DAYOPT_AGENT_VAULT_ID?.trim()),
    scope: 'unverified',
    runtimeIsolation: 'unverified',
  };
}

function validateConfig(env) {
  if (!env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) throw new ServiceAccountError('TOKEN_MISSING');
  if (!env.OP_SERVICE_ACCOUNT_TOKEN.startsWith('ops_'))
    throw new ServiceAccountError('TOKEN_INVALID');
  if (!OP_ID.test(env.DAYOPT_AGENT_SERVICE_ACCOUNT_ID ?? ''))
    throw new ServiceAccountError('ACCOUNT_ID_REQUIRED');
  if (!OP_ID.test(env.DAYOPT_AGENT_VAULT_ID ?? ''))
    throw new ServiceAccountError('VAULT_ID_REQUIRED');
}

// Connect は SA token より優先される。OP_SESSION_* / OP_ACCOUNT / debug 等も
// 継承しない。専用クラウド側には別の人間用認証経路を置かないことが別途必要。
export function serviceAccountEnvironment(env, configDir) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('OP_')));
  return {
    ...clean,
    OP_SERVICE_ACCOUNT_TOKEN: env.OP_SERVICE_ACCOUNT_TOKEN,
    OP_CONFIG_DIR: configDir,
    OP_BIOMETRIC_UNLOCK_ENABLED: 'false',
    OP_CACHE: 'false',
    OP_DEBUG: 'false',
    OP_RUN_NO_MASKING: 'false',
  };
}

function opMetadata(args, env, failureCode) {
  const result = spawnSync('op', [...args, '--format=json'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: OP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  // error.message / stdout / stderr は token や item 内容を含み得るため返さない。
  if (result.error || result.status !== 0) throw new ServiceAccountError(failureCode);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ServiceAccountError('METADATA_INVALID');
  }
}

export function verifyServiceAccount(env) {
  const user = opMetadata(['user', 'get', '--me'], env, 'AUTH_FAILED');
  if (
    user?.type?.toUpperCase() !== 'SERVICE_ACCOUNT' ||
    user?.state?.toUpperCase() !== 'ACTIVE' ||
    user?.id !== env.DAYOPT_AGENT_SERVICE_ACCOUNT_ID
  )
    throw new ServiceAccountError('IDENTITY_MISMATCH');

  // --vault / --user 等で絞らず、現 identity が読める vault の全件を照合する。
  const vaults = opMetadata(['vault', 'list'], env, 'VAULT_LIST_FAILED');
  if (
    !Array.isArray(vaults) ||
    vaults.length !== 1 ||
    vaults[0]?.id !== env.DAYOPT_AGENT_VAULT_ID ||
    vaults[0]?.name !== 'agent'
  )
    throw new ServiceAccountError('VAULT_SCOPE_MISMATCH');

  return {
    identity: 'SERVICE_ACCOUNT',
    vaultScope: 'agent-only',
    // CLI の vault 一覧からは write/share/create-vault/Environments の権限を
    // 証明できない。管理画面の確認とクラウド側の隔離の証跡を別に残す。
    permissions: 'requires-admin-verification',
    runtimeIsolation: 'requires-cloud-verification',
  };
}

function runCommand(command, args, env) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    process.on('SIGINT', forwardInt);
    process.on('SIGTERM', forwardTerm);
    const cleanup = () => {
      process.off('SIGINT', forwardInt);
      process.off('SIGTERM', forwardTerm);
    };
    child.once('error', () => {
      cleanup();
      console.error('Agent secrets: COMMAND_START_FAILED');
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}

export async function main(args, env = process.env) {
  const [mode, ...rest] = args;
  if (
    (mode !== 'check' && mode !== 'run') ||
    (mode === 'check' && rest.some((arg) => arg !== '--json')) ||
    (mode === 'run' && (rest[0] !== '--' || rest.length < 2))
  )
    throw new ServiceAccountError('USAGE: check [--json] | run -- <command> [args]');
  validateConfig(env);
  const configDir = mkdtempSync(join(tmpdir(), 'dayopt-agent-op-'));
  try {
    chmodSync(configDir, 0o700);
    const cleanEnv = serviceAccountEnvironment(env, configDir);
    const state = verifyServiceAccount(cleanEnv);
    if (mode === 'check') {
      console.log(
        rest.includes('--json')
          ? JSON.stringify(state)
          : 'Agent secrets: SERVICE_ACCOUNT / agent-only; permissions and cloud isolation require separate verification',
      );
      return 0;
    }
    return await runCommand(rest[1], rest.slice(2), cleanEnv);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Agent secrets: ${error instanceof ServiceAccountError ? error.code : 'CHECK_FAILED'}`,
    );
    process.exitCode = 1;
  }
}
