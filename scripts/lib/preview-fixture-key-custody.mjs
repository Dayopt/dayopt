import { createHash, createPublicKey } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { prepareFixtureAuthority } from './preview-fixture-authority.mjs';
import { generatePreviewFixtureKeyPair } from './preview-fixture-envelope.mjs';
import { createPreviewFixturePublicKeyArtifact } from './preview-fixture-handoff.mjs';

const ERROR = 'Preview fixture key custody failed';
function prefix(input) {
  const authority = prepareFixtureAuthority(input);
  if (authority.operation !== 'provision') throw new Error();
  return `preview-private-key-${createHash('sha256').update(JSON.stringify(authority)).digest('hex')}-`;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error();
}
function inside(path, parent) {
  const part = relative(parent, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
function roots({ runnerTemp, privateOutput, evidenceDirectory }) {
  if (
    ![runnerTemp, privateOutput, evidenceDirectory].every(
      (p) => typeof p === 'string' && isAbsolute(p),
    )
  )
    throw new Error();
  const root = realpathSync(runnerTemp);
  const excluded = [realpathSync(privateOutput), realpathSync(evidenceDirectory)];
  if (!lstatSync(root).isDirectory() || excluded.some((p) => inside(root, p))) throw new Error();
  return { root, excluded };
}
function owned(stat, mode, directory = false) {
  if (
    typeof process.getuid !== 'function' ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== mode ||
    (directory
      ? !stat.isDirectory()
      : !stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192)
  )
    throw new Error();
}
function same(a, b) {
  if (a.dev !== b.dev || a.ino !== b.ino) throw new Error();
}

/**
 * Trusted pre-candidate step only. Upload ONLY publicPath (public-key.json).
 * Never upload privatePath or its parent. The caller deletes the public artifact
 * directory; withPreviewFixturePrivateKey owns one-time private-key consumption.
 */
export function preparePreviewFixtureKeyCustody(options) {
  let privateDirectory;
  let privatePath;
  let publicDirectory;
  let publicPath;
  try {
    exact(options, ['input', 'runnerTemp', 'privateOutput', 'evidenceDirectory']);
    const { root } = roots(options);
    const privatePrefix = prefix(options.input);
    const { publicKey, privateKey } = generatePreviewFixtureKeyPair();
    const artifact = createPreviewFixturePublicKeyArtifact({ input: options.input, publicKey });
    privateDirectory = mkdtempSync(join(root, privatePrefix));
    privatePath = join(privateDirectory, 'private.pem');
    writeFileSync(privatePath, privateKey, { flag: 'wx', mode: 0o600 });
    publicDirectory = mkdtempSync(join(root, 'preview-public-key-'));
    publicPath = join(publicDirectory, 'public-key.json');
    writeFileSync(publicPath, JSON.stringify(artifact), { flag: 'wx', mode: 0o600 });
    return { privatePath, publicPath, publicDirectory };
  } catch {
    for (const path of [privatePath, publicPath]) {
      if (path) {
        try {
          unlinkSync(path);
        } catch {
          /* Fixed failure below. */
        }
      }
    }
    for (const directory of [privateDirectory, publicDirectory]) {
      if (directory) {
        try {
          rmdirSync(directory);
        } catch {
          /* Never remove unknown entries. */
        }
      }
    }
    throw new Error(ERROR);
  }
}

/**
 * Await use(privatePem), then remove the owned key and empty private directory on
 * success or failure, BEFORE candidate checkout. Failure to clean up is failure.
 * No recursive deletion; unknown entries are retained. This is filesystem hygiene,
 * not isolation from other code running as the same OS user. Never log the PEM.
 */
export async function withPreviewFixturePrivateKey(options) {
  let fd;
  let cleanup;
  try {
    exact(options, [
      'input',
      'runnerTemp',
      'privateOutput',
      'evidenceDirectory',
      'privatePath',
      'use',
    ]);
    const { root, excluded } = roots(options);
    const { privatePath, use, input } = options;
    if (typeof use !== 'function' || typeof privatePath !== 'string' || !isAbsolute(privatePath))
      throw new Error();
    const directory = dirname(privatePath);
    if (
      basename(privatePath) !== 'private.pem' ||
      dirname(directory) !== root ||
      !basename(directory).startsWith(prefix(input)) ||
      !/^[A-Za-z0-9]{6}$/.test(basename(directory).slice(prefix(input).length)) ||
      excluded.some((p) => inside(directory, p)) ||
      realpathSync(directory) !== directory
    )
      throw new Error();
    const dirStat = lstatSync(directory);
    owned(dirStat, 0o700, true);
    const fileStat = lstatSync(privatePath);
    owned(fileStat, 0o600);
    fd = openSync(privatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    owned(opened, 0o600);
    same(fileStat, opened);
    cleanup = () => {
      same(dirStat, lstatSync(directory));
      same(opened, lstatSync(privatePath));
      unlinkSync(privatePath);
      rmdirSync(directory);
    };
    const privateKey = readFileSync(fd, 'utf8');
    closeSync(fd);
    fd = undefined;
    if (
      // Character class preserves the exact PEM header without embedding a key marker literal.
      !/^-----BEGIN PRIVA[T]E KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVA[T]E KEY-----\n?$/.test(
        privateKey,
      )
    )
      throw new Error();
    // Reuse the exact public-key/RSA and authority policy before releasing the PEM.
    createPreviewFixturePublicKeyArtifact({
      input,
      publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    });
    return await use(privateKey);
  } catch {
    throw new Error(ERROR);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
      if (cleanup) cleanup();
    } catch {
      throw new Error(ERROR);
    }
  }
}
