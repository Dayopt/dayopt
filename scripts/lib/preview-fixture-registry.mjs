import { mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { prepareFixtureAuthority } from './preview-fixture-authority.mjs';

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error();
}

function inside(path, parent) {
  const part = relative(parent, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

/**
 * Materialize a verified broker response in a fresh private worker directory.
 * Call only after authenticated transport/decryption; this does not authenticate
 * a response or provide a cross-job transfer channel. Never upload this file.
 */
export function writeFixtureRegistry({
  input,
  response,
  runnerTemp,
  privateOutput,
  evidenceDirectory,
}) {
  let directory;
  let path;
  try {
    const authority = prepareFixtureAuthority(input);
    if (authority.operation !== 'provision') throw new Error();
    exact(response, ['schemaVersion', 'runId', 'operation', 'users']);
    if (
      response.schemaVersion !== 1 ||
      response.operation !== 'provision' ||
      response.runId !== authority.intent.runId
    )
      throw new Error();
    exact(response.users, ['desktop', 'mobile']);
    const users = {};
    for (const [slot, prefix] of [
      ['desktop', 'critical-path'],
      ['mobile', 'mobile-critical-path'],
    ]) {
      const user = response.users[slot];
      exact(user, ['userId', 'email', 'password', 'activityName', 'categoryName']);
      const id = authority.intent.userIds[slot];
      if (
        user.userId !== id ||
        user.email !== `${prefix}-${id}@example.com` ||
        user.activityName !== `Journey ${id.slice(0, 8)}` ||
        user.categoryName !== `Cat ${id.slice(0, 8)}` ||
        typeof user.password !== 'string' ||
        !/^E2e![A-Za-z0-9_-]{43}$/.test(user.password)
      )
        throw new Error();
      users[slot] = {
        userId: id,
        email: user.email,
        password: user.password,
        activityName: user.activityName,
        categoryName: user.categoryName,
      };
    }
    if (
      ![runnerTemp, privateOutput, evidenceDirectory].every(
        (p) => typeof p === 'string' && isAbsolute(p),
      )
    )
      throw new Error();
    const root = realpathSync(runnerTemp);
    const excluded = [realpathSync(privateOutput), realpathSync(evidenceDirectory)];
    if (excluded.some((p) => inside(root, p))) throw new Error();
    directory = mkdtempSync(join(root, 'preview-login-'));
    path = join(directory, 'registry.json');
    const registry = {
      schemaVersion: 1,
      operation: 'provision',
      runId: authority.intent.runId,
      origin: authority.origin,
      supabaseProjectRef: authority.intent.request.supabaseProjectRef,
      users,
    };
    writeFileSync(path, JSON.stringify(registry), { flag: 'wx', mode: 0o600 });
    return { path, directory };
  } catch {
    // Remove only entries this call owns, without following or recursively deleting
    // anything a later worker might have put in the private directory.
    if (path) {
      try {
        unlinkSync(path);
      } catch {
        /* May not have been created. */
      }
    }
    if (directory) {
      try {
        rmdirSync(directory);
      } catch {
        /* Preserve unknown entries. */
      }
    }
    throw new Error('Preview fixture registry preparation failed');
  }
}
