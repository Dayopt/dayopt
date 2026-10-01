import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { observeProductPreviewDeployment } from '../lib/preview-deployment-provenance.mjs';
import {
  prepareFixtureAuthority,
  requestFixtureJobToken,
  requestPreviewAccessToken,
} from '../lib/preview-fixture-authority.mjs';
import { previewFixtureHandoffArtifactName } from '../lib/preview-fixture-handoff-trust.mjs';
import {
  receivePreviewFixturePublicKey,
  receivePreviewFixtureRegistry,
} from '../lib/preview-fixture-handoff.mjs';
import {
  preparePreviewFixtureKeyCustody,
  withPreviewFixturePrivateKey,
} from '../lib/preview-fixture-key-custody.mjs';
import {
  observePreparedRuntime,
  preparedReadinessSnapshot,
  remainingPreparedBudget,
} from '../lib/preview-prepared-readiness.mjs';
import { runPreviewE2E } from '../runbook/preview-e2e.mjs';
import { observePreviewReadiness } from '../runbook/preview-readiness.mjs';
import { createCloudIntent } from './preview-cloud-intent.mjs';
import { publishCloudEvidence, verifyCloudFixtureContract } from './preview-cloud-run.mjs';
import { assertPreparedPreviewAdmission } from './preview-prepared-admission.mjs';
import { expectedMigrationVersions } from './production-migration-readiness.mjs';

const ERROR = 'Prepared Preview job failed; credentials and provider responses are not logged';
const MAX_BYTES = 65_536;
const safeEnv = (env) =>
  Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH'].flatMap((key) =>
      env[key] ? [[key, env[key]]] : [],
    ),
  );
function readJson(path, privateFile = false) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_BYTES ||
    (privateFile && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()))
  )
    throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function save(path, body) {
  writeFileSync(path, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
}
function directory(path) {
  mkdirSync(path, { mode: 0o700 });
}
function output(name, value, env) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error();
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`, { mode: 0o600 });
}
export function preparedJobContext(value, env) {
  if (!value || Object.keys(value).sort().join(',') !== 'expectedMigrations,input')
    throw new Error();
  const authority = prepareFixtureAuthority(value.input);
  if (
    authority.operation !== 'provision' ||
    authority.intent.request.databaseMode !== 'ephemeral' ||
    env.GITHUB_REPOSITORY !== 'Dayopt/dayopt' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/integration' ||
    env.GITHUB_WORKFLOW_REF !== 'Dayopt/dayopt/.github/workflows/ci.yml@refs/heads/integration' ||
    env.GITHUB_SHA !== authority.execution.workflowSha ||
    env.GITHUB_RUN_ID !== String(authority.execution.runId) ||
    env.GITHUB_RUN_ATTEMPT !== String(authority.execution.attempt) ||
    !Array.isArray(value.expectedMigrations) ||
    !value.expectedMigrations.length ||
    value.expectedMigrations.length > 2000 ||
    !value.expectedMigrations.every((v) => typeof v === 'string' && /^\d{14}$/.test(v)) ||
    new Set(value.expectedMigrations).size !== value.expectedMigrations.length
  )
    throw new Error();
  return {
    input: {
      operation: authority.operation,
      origin: authority.origin,
      intent: authority.intent,
      execution: authority.execution,
    },
    expectedMigrations: [...value.expectedMigrations].sort(),
  };
}

/** No configured DB-independent durable quarantine store exists. Removing the
 * admission gate alone must not activate provision. No env flag grants reuse. */
export function requirePreparedQuarantineStore() {
  throw new Error('Prepared Preview durable quarantine store is not configured');
}

export function assertPreparedConsumerEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (
      /^(?:SUPABASE_|VERCEL_|ACTIONS_ID_TOKEN_REQUEST_)/.test(key) ||
      ['GH_TOKEN', 'GH_PAT', 'NODE_OPTIONS'].includes(key)
    )
      throw new Error('Prepared consumer has a forbidden capability');
  }
}

/** Bounded waiting does not convert missing/invalid metadata into trust. */
export async function waitPreparedHandoff(
  receive,
  { now = Date.now, pause = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 30 } = {},
) {
  const deadline = now() + 150_000;
  for (let n = 0; n < attempts && now() < deadline; n++) {
    try {
      return await receive();
    } catch {
      if (n + 1 < attempts) await pause(5000);
    }
  }
  throw new Error('Prepared Preview authenticated handoff unavailable');
}

/** Candidate process stdout/stderr and inherited credentials never reach Actions.
 * Kill its process group before treating interruption/deadline as complete. */
export function runPreparedProcess(command, args, { cwd, env, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 7 * 60_000)
    throw new Error();
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd, env: safeEnv(env), stdio: 'ignore', detached: true });
    let settled = false;
    let stopping = false;
    let forceTimer;
    const kill = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      kill('SIGKILL');
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      resolveCode(code);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill('SIGTERM');
      forceTimer = setTimeout(() => {
        kill('SIGKILL');
        finish(1);
      }, 3000);
    };
    const timer = setTimeout(stop, timeoutMs);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', () => finish(1));
    child.once('exit', (code) => {
      if (!stopping) finish(code ?? 1);
    });
  });
}

async function boundedResponse(response) {
  if (response.status !== 200 || response.redirected || !response.body) throw new Error();
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 49_152) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function provisionPreparedFixtures({
  context,
  env,
  receive = receivePreviewFixturePublicKey,
  access = requestPreviewAccessToken,
  authenticate = requestFixtureJobToken,
  observe = observePreviewReadiness,
  fetchImpl = fetch,
  quarantine = requirePreparedQuarantineStore,
}) {
  const { input, expectedMigrations } = preparedJobContext(context, env);
  // Source admission is ALSO checked by the CLI and upstream workflow trust job.
  await quarantine(input);
  const publicKey = await waitPreparedHandoff(() => receive({ input, token: env.GITHUB_TOKEN }));
  const previewAccessToken = await access({ input, env });
  const readiness = preparedReadinessSnapshot(
    input,
    await observe({
      ...input.intent.request,
      expectedMigrations,
      githubToken: env.GITHUB_TOKEN,
      supabaseToken: env.SUPABASE_PREVIEW_READINESS_TOKEN,
      trustedOidcToken: previewAccessToken,
    }),
  );
  const token = await authenticate({ input, env });
  const envelope = await boundedResponse(
    await fetchImpl(`${input.origin}/api/preview-fixtures`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(150_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-vercel-trusted-oidc-idp-token': previewAccessToken,
      },
      body: JSON.stringify({ input, publicKey, previewAccessToken, readiness }),
    }),
  );
  // The receiver verifies the full cryptographic schema after authenticated ZIP
  // provenance. Only encrypted fields may be serialized by this trusted sender.
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !==
      'binding,ciphertext,nonce,schemaVersion,tag,wrappedKey' ||
    envelope.schemaVersion !== 1 ||
    ['ciphertext', 'nonce', 'tag', 'wrappedKey'].some(
      (key) => typeof envelope[key] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope[key]),
    )
  )
    throw new Error();
  const bound = prepareFixtureAuthority(input);
  if (
    JSON.stringify(envelope.binding?.authority) !== JSON.stringify(bound) ||
    Object.keys(envelope.binding).sort().join(',') !== 'authority,publicKeyDigest' ||
    !/^[a-f0-9]{64}$/.test(envelope.binding.publicKeyDigest)
  )
    throw new Error();
  return envelope;
}

export async function recordPreparedOutcome({
  context,
  env,
  directory: destination,
  observe = observePreviewReadiness,
  access = requestPreviewAccessToken,
}) {
  const { input, expectedMigrations } = preparedJobContext(context, env);
  let providerPostConfirmed = false;
  try {
    const trustedOidcToken = await access({ input, env });
    const ready = await observe({
      ...input.intent.request,
      expectedMigrations,
      githubToken: env.GITHUB_TOKEN,
      supabaseToken: env.SUPABASE_PREVIEW_READINESS_TOKEN,
      trustedOidcToken,
    });
    preparedReadinessSnapshot(input, ready);
    providerPostConfirmed = true;
  } catch {
    /* Neither a provider error nor missing credentials become success. */
  }
  directory(destination);
  const result = {
    sourceRunId: input.intent.sourceRunId,
    sourceAttempt: input.intent.sourceAttempt,
    runId: input.intent.runId,
    request: input.intent.request,
    status: 'unknown',
    cleanupConfirmed: false,
    reusable: false,
    quarantinePersisted: false,
    providerPostConfirmed,
    users: [],
    failure: 'fixture-termination-and-durable-quarantine-unverified',
  };
  save(join(destination, 'recovery.json'), result);
  return result;
}

export function removeOwnedPreparedLogin({ session, root, input }) {
  const authority = prepareFixtureAuthority(input);
  if (
    typeof session?.directory !== 'string' ||
    dirname(session.directory) !== root ||
    !/^preview-login-[A-Za-z0-9]{6}$/.test(session.directory.slice(root.length + 1)) ||
    realpathSync(session.directory) !== session.directory ||
    session.path !== join(session.directory, 'registry.json')
  )
    throw new Error();
  const owner = lstatSync(session.directory);
  if (!owner.isDirectory() || (owner.mode & 0o777) !== 0o700 || owner.uid !== process.getuid())
    throw new Error();
  const row = readJson(session.path, true);
  if (
    row.runId !== authority.intent.runId ||
    row.origin !== authority.origin ||
    row.supabaseProjectRef !== authority.intent.request.supabaseProjectRef ||
    Object.entries(authority.intent.userIds).some(([slot, id]) => row.users?.[slot]?.userId !== id)
  )
    throw new Error();
  unlinkSync(session.path);
  rmdirSync(session.directory); // Never recursively remove candidate-written extra files.
}

export function preparedGitEnvironment(env) {
  return {
    ...safeEnv(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: env.GITHUB_TOKEN ? '2' : '1',
    GIT_CONFIG_KEY_0: 'http.followRedirects',
    GIT_CONFIG_VALUE_0: 'false',
    ...(env.GITHUB_TOKEN
      ? {
          GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString('base64')}`,
        }
      : {}),
  };
}
function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    env: preparedGitEnvironment(env),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function main(operation, env) {
  const root = realpathSync(env.RUNNER_TEMP);
  const workspace = realpathSync(env.GITHUB_WORKSPACE);
  const consumer = join(root, 'prepared-consumer');
  const statePath = join(consumer, 'state.json');
  if (operation === 'plan') {
    const request = readJson(join(root, 'preview-request.json'));
    assertPreparedPreviewAdmission(request);
    requirePreparedQuarantineStore();
    const intent = createCloudIntent({ request, env });
    const { origin } = await observeProductPreviewDeployment({
      ...request,
      githubToken: env.GITHUB_TOKEN,
    });
    // Inspect filenames in an exact fetched tree, never checkout/execute candidate code here.
    const bare = join(root, 'preview-candidate-metadata');
    directory(bare);
    git(['init', '--bare', '--quiet'], bare, env);
    git(
      ['fetch', '--quiet', '--depth=1', 'https://github.com/Dayopt/dayopt.git', request.sha],
      bare,
      env,
    );
    const versions = git(
      ['ls-tree', '-r', '--name-only', request.sha, '--', 'supabase/migrations'],
      bare,
      env,
    )
      .split('\n')
      .filter((name) => /^supabase\/migrations\/\d{14}_.+\.sql$/.test(name))
      .map((name) => name.split('/').at(-1).slice(0, 14));
    const context = preparedJobContext(
      {
        input: {
          operation: 'provision',
          origin,
          intent,
          execution: {
            runId: intent.sourceRunId,
            attempt: intent.sourceAttempt,
            workflowSha: intent.workflowSha,
          },
        },
        expectedMigrations: versions,
      },
      env,
    );
    directory(join(root, 'preview-intent'));
    save(join(root, 'preview-intent', 'intent.json'), intent);
    output('context', JSON.stringify(context), env);
    output('public_key_name', previewFixtureHandoffArtifactName(context.input, 'public-key'), env);
    output('envelope_name', previewFixtureHandoffArtifactName(context.input, 'envelope'), env);
    return;
  }
  const context = preparedJobContext(JSON.parse(env.PREVIEW_PREPARED_CONTEXT), env);
  const { input } = context;
  if (!['post', 'clean'].includes(operation)) {
    assertPreparedPreviewAdmission(input.intent.request);
    requirePreparedQuarantineStore();
  }
  if (operation === 'provision') {
    const envelope = await provisionPreparedFixtures({ context, env });
    const publicDir = join(root, 'prepared-envelope');
    directory(publicDir);
    save(join(publicDir, 'envelope.json'), envelope);
    return;
  }
  if (operation === 'post') {
    await recordPreparedOutcome({ context, env, directory: join(root, 'prepared-quarantine') });
    throw new Error('Prepared fixtures remain UNKNOWN');
  }
  assertPreparedConsumerEnvironment(env);
  const keyOptions = {
    input,
    runnerTemp: root,
    privateOutput: join(consumer, 'browser'),
    evidenceDirectory: join(consumer, 'evidence'),
  };
  if (operation === 'key') {
    directory(consumer);
    directory(keyOptions.privateOutput);
    directory(keyOptions.evidenceDirectory);
    const custody = preparePreviewFixtureKeyCustody(keyOptions);
    try {
      save(statePath, custody);
      output('public_path', custody.publicPath, env);
    } catch {
      await withPreviewFixturePrivateKey({
        ...keyOptions,
        privatePath: custody.privatePath,
        use: async () => undefined,
      });
      throw new Error();
    }
    return;
  }
  const state = readJson(statePath, true);
  const sessionPath = join(consumer, 'session.json');
  if (operation === 'clean') {
    if (state.privatePath) {
      let exists = true;
      try {
        lstatSync(state.privatePath);
      } catch (error) {
        if (error.code === 'ENOENT') exists = false;
        else throw error;
      }
      if (exists)
        await withPreviewFixturePrivateKey({
          ...keyOptions,
          privatePath: state.privatePath,
          use: async () => undefined,
        });
    }
    let session;
    try {
      session = readJson(sessionPath, true);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    removeOwnedPreparedLogin({ session, root, input });
    unlinkSync(sessionPath);
    return;
  }
  if (operation === 'receive') {
    let received;
    try {
      await withPreviewFixturePrivateKey({
        ...keyOptions,
        privatePath: state.privatePath,
        use: async (privateKey) => {
          received = await waitPreparedHandoff(() =>
            receivePreviewFixtureRegistry({
              ...keyOptions,
              input,
              token: env.GITHUB_TOKEN,
              privateKey,
              preparedAccess: true,
              preparedReadiness: true,
            }),
          );
        },
      });
      save(sessionPath, received);
    } catch {
      if (received) removeOwnedPreparedLogin({ session: received, root, input });
      throw new Error();
    }
    return;
  }
  const session = readJson(sessionPath, true);
  remainingPreparedBudget(session.accessDeadline);
  const candidate = join(workspace, 'candidate');
  if (operation === 'checkout') {
    directory(candidate);
    git(['init', '--quiet'], candidate, env);
    git(
      [
        'fetch',
        '--quiet',
        '--depth=1',
        'https://github.com/Dayopt/dayopt.git',
        input.intent.request.sha,
      ],
      candidate,
      env,
    );
    remainingPreparedBudget(session.accessDeadline);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], candidate, env);
    if (git(['rev-parse', 'HEAD'], candidate, env) !== input.intent.request.sha) throw new Error();
    return;
  }
  if (operation !== 'execute') throw new Error();
  // No static provider or OIDC issuer credential exists on this worker. Capture
  // owned paths before candidate code, and never read candidate-mutated state again.
  if (
    dirname(session.path) !== session.directory ||
    dirname(session.directory) !== root ||
    !/^preview-login-[A-Za-z0-9]{6}$/.test(session.directory.slice(root.length + 1)) ||
    realpathSync(session.directory) !== session.directory ||
    session.path !== join(session.directory, 'registry.json')
  )
    throw new Error();
  const registryStat = lstatSync(session.path);
  if (!registryStat.isFile() || registryStat.isSymbolicLink() || registryStat.nlink !== 1)
    throw new Error();
  const runPath = join(root, 'prepared-run');
  try {
    if (
      git(['rev-parse', 'HEAD'], candidate, env) !== input.intent.request.sha ||
      git(['status', '--porcelain'], candidate, env)
    )
      throw new Error();
    verifyCloudFixtureContract(candidate);
    const expectedMigrations = expectedMigrationVersions(candidate);
    if (JSON.stringify(expectedMigrations) !== JSON.stringify(context.expectedMigrations))
      throw new Error();
    const code = await runPreparedProcess('pnpm', ['install', '--frozen-lockfile'], {
      cwd: candidate,
      env,
      timeoutMs: remainingPreparedBudget(session.accessDeadline, Date.now(), 60_000),
    });
    if (code !== 0) throw new Error();
    const result = await runPreviewE2E({
      request: { ...input.intent.request, expectedMigrations },
      env: safeEnv(env),
      candidateRoot: candidate,
      runDirectory: runPath,
      runId: input.intent.runId,
      cloudUserIds: input.intent.userIds,
      registryPath: session.path,
      trustedOidcToken: session.trustedOidcToken,
      accessDeadline: session.accessDeadline,
      observe: () =>
        observePreparedRuntime({
          input,
          snapshot: session.readiness,
          token: session.trustedOidcToken,
          deadline: session.accessDeadline,
          expectedMigrations,
        }),
    });
    if (result.status !== 'passed') throw new Error();
  } finally {
    // Candidate evidence is untrusted and only the existing coordinate sanitizer may publish it.
    try {
      publishCloudEvidence({
        directory: runPath,
        destination: join(root, 'prepared-public'),
        request: input.intent.request,
        intent: input.intent,
      });
    } finally {
      const current = lstatSync(session.path);
      if (current.dev !== registryStat.dev || current.ino !== registryStat.ino) throw new Error();
      removeOwnedPreparedLogin({ session, root, input });
      unlinkSync(sessionPath);
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const [operation, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      !['plan', 'key', 'receive', 'checkout', 'execute', 'provision', 'post', 'clean'].includes(
        operation,
      )
    )
      throw new Error();
    await main(operation, process.env);
  } catch {
    console.error(ERROR);
    process.exitCode = 1;
  }
}
