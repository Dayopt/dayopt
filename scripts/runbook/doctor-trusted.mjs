#!/usr/bin/env node
// Install this launcher OUTSIDE candidate checkouts from a reviewed main revision.
// A check inside a malicious checkout cannot make that checkout trustworthy.
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertTrustedRuntime(root, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('trusted_runtime_required');
  if (realpathSync(root) !== resolve(root) || !lstatSync(join(root, '.git')).isDirectory())
    throw new Error('trusted_runtime_required');
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (
    git('remote', 'get-url', 'origin') !== 'https://github.com/Dayopt/dayopt.git' ||
    git('rev-parse', 'HEAD') !== revision ||
    git('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD'
  )
    throw new Error('trusted_runtime_required');
  git('merge-base', '--is-ancestor', revision, 'refs/remotes/origin/main');
  git('diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--');
  if (git('ls-files', '--others', '--exclude-standard'))
    throw new Error('trusted_runtime_required');
}

export function launch(directory, args) {
  const root = join(directory, 'runtime');
  const revision = readFileSync(join(directory, 'revision'), 'utf8').trim();
  assertTrustedRuntime(root, revision);
  const env = { ...process.env, DOCTOR_TRUSTED_REVISION: revision };
  // Do not load caller-selected JavaScript into a process that will resolve credentials.
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete env[key];
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/doctor/cli.ts'), ...args],
    { cwd: root, env, stdio: 'inherit' },
  );
  return result.status ?? 3;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = launch(dirname(fileURLToPath(import.meta.url)), process.argv.slice(2));
  } catch {
    process.stderr.write(
      'doctor: trusted_runtime_required (reviewed main installation required)\n',
    );
    process.exitCode = 3;
  }
}
