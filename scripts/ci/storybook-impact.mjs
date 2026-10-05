#!/usr/bin/env node
/** Standalone Vercel ignored-build step: 1 builds, 0 skips. No installed dependencies. */
import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHA = /^[a-f0-9]{40}$/;
const GLOBAL =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.npmrc|\.nvmrc|tsconfig[^/]*\.json)$|^patches\//;
const BACKEND = /\/(server|api|services|routers|mcp)\/|\.(server|router|service)\.[cm]?[jt]sx?$/;
const TEXT = /\.(?:[cm]?[jt]sx?|json|css|scss|mdx)$/;
const DOCUMENTATION = /\/content\/docs\//;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|\/(?:__tests__|test)\//;

// Strip comments without treating CSS glob strings or URLs as comment delimiters.
function withoutComments(source) {
  let output = '';
  let quote;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\') output += source[++index] ?? '';
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      output += '\n';
    } else if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        index++;
      index++;
      output += ' ';
    } else output += char;
  }
  return output;
}

function git(cwd, args, extra = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
    ...extra,
  });
}

/** Read committed inputs at BOTH ends, including deleted imports and manifest edges. */
export function readSnapshot(cwd, sha) {
  const paths = git(cwd, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean);
  const textPaths = paths.filter((path) => TEXT.test(path));
  const output = git(cwd, ['cat-file', '--batch'], {
    input: textPaths.map((path) => `${sha}:${path}\n`).join(''),
    encoding: null,
  });
  const files = new Map(paths.map((path) => [path, '']));
  let offset = 0;
  for (const path of textPaths) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString();
    const size = Number(header.split(' ')[2]);
    if (end < 0 || !header.includes(' blob ') || !Number.isSafeInteger(size))
      throw new Error('cannot read committed source');
    files.set(path, output.subarray(end + 1, end + 1 + size).toString());
    offset = end + 2 + size;
  }
  return files;
}

/** Conservative frontend buckets plus transitive literal source references into backend files. */
export function storybookInputs(files) {
  const manifests = new Map();
  for (const [path, source] of files) {
    if (/^(apps|packages)\/[^/]+\/package\.json$/.test(path)) {
      const manifest = JSON.parse(source);
      if (!manifest.name || manifests.has(manifest.name))
        throw new Error('invalid workspace names');
      manifests.set(manifest.name, { directory: posix.dirname(path), manifest });
    }
  }
  const directories = new Set(['apps/storybook', 'apps/product', 'apps/web']);
  const visit = (name) => {
    const entry = manifests.get(name);
    if (!entry) throw new Error(`missing workspace ${name}`);
    directories.add(entry.directory);
    for (const [dependency, version] of Object.entries({
      ...entry.manifest.dependencies,
      ...entry.manifest.devDependencies,
      ...entry.manifest.peerDependencies,
      ...entry.manifest.optionalDependencies,
    })) {
      if (
        String(version).startsWith('workspace:') &&
        !directories.has(manifests.get(dependency)?.directory)
      )
        visit(dependency);
    }
  };
  // Web stories are included by main.ts even though web is not a manifest dependency.
  for (const name of ['@dayopt/storybook', '@dayopt/product', '@dayopt/web']) visit(name);
  const inputs = new Set();
  const queue = [];
  const queued = new Set();
  const add = (path, follow = true) => {
    inputs.add(path);
    if (
      follow &&
      files.has(path) &&
      TEXT.test(path) &&
      !path.endsWith('.json') &&
      !queued.has(path)
    ) {
      queued.add(path);
      queue.push(path);
    }
  };
  for (const path of files.keys()) {
    if (
      [...directories].some((directory) => {
        if (!path.startsWith(`${directory}/`)) return false;
        const relative = path.slice(directory.length + 1);
        return (
          /^(src|public|assets|messages|\.storybook)\//.test(relative) || !relative.includes('/')
        );
      }) &&
      !BACKEND.test(path) &&
      !DOCUMENTATION.test(path) &&
      !TEST.test(path) &&
      !/\.md$/.test(path)
    )
      add(path, /\/(src|\.storybook)\//.test(path));
  }
  const find = (path) =>
    [
      path,
      ...[
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.json',
        '.css',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ].map((ext) => path + ext),
    ].find((candidate) => files.has(candidate));
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    const source = withoutComments(files.get(path));
    // Dynamic local templates include the entire static prefix, never just today's locale.
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*`([^`]+)`/g)) {
      const prefix = match[1].split('${')[0];
      if (!prefix.startsWith('.') || !prefix.includes('/')) {
        for (const target of files.keys()) add(target);
      } else {
        const directory = posix.normalize(posix.join(posix.dirname(path), prefix));
        for (const target of files.keys()) if (target.startsWith(directory)) add(target);
      }
    }
    // Opaque computed imports/globs over-approximate all committed source, but docs still skip.
    if (
      /\b(?:import|require)\s*\(\s*[^'"`\s]/.test(source) ||
      /\b(?:import|require)\s*\(\s*['"][^'"\n]*['"]\s*[^),\s]/.test(source) ||
      /import\.meta\.glob\s*\(\s*[^'"\s]/.test(source)
    )
      for (const target of files.keys()) add(target);
    for (const match of source.matchAll(/import\.meta\.glob\s*\(\s*['"]([^'"]+)['"]/g)) {
      const prefix = match[1].split(/[*(?{[]/)[0];
      if (!prefix.startsWith('.')) for (const target of files.keys()) add(target);
      else {
        const directory = posix.normalize(posix.join(posix.dirname(path), prefix));
        for (const target of files.keys()) if (target.startsWith(directory)) add(target);
      }
    }
    // Scan all quoted paths, including imports, exports, require and CSS imports. Extra matches build safely.
    for (const match of source.matchAll(/['"]([^'"\n]+)['"]/g)) {
      const reference = match[1];
      let candidate;
      if (reference.startsWith('.'))
        candidate = posix.normalize(posix.join(posix.dirname(path), reference));
      else if (reference.startsWith('@/')) candidate = `apps/product/src/${reference.slice(2)}`;
      else if (reference.startsWith('@web/')) candidate = `apps/web/src/${reference.slice(5)}`;
      else if (reference.startsWith('@dayopt/storybook/'))
        candidate = `apps/storybook/.storybook/${reference.slice(18)}`;
      else {
        const entry = [...manifests].find(
          ([name]) => reference === name || reference.startsWith(`${name}/`),
        );
        if (entry) {
          // Package exports may be conditional: include every source in the referenced workspace.
          for (const target of files.keys())
            if (target.startsWith(`${entry[1].directory}/`)) add(target);
        }
      }
      if (candidate) {
        const target = find(candidate);
        if (target) add(target);
      }
    }
  }
  return { inputs, directories };
}

export function gitStorybookDiff(cwd, base, target) {
  return git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, target])
    .split('\0')
    .filter(Boolean);
}

export function resolveStorybookIgnore({
  prevSha,
  currentSha,
  cwd = ROOT,
  diffImpl = (base, target) => gitStorybookDiff(cwd, base, target),
  snapshotImpl = (sha) => readSnapshot(cwd, sha),
  headImpl = () => git(cwd, ['rev-parse', 'HEAD']).trim(),
}) {
  const build = (reason) => ({ shouldBuild: true, reason });
  if (!SHA.test(prevSha ?? '') || !SHA.test(currentSha ?? ''))
    return build('missing/invalid deployment SHA');
  try {
    if (headImpl() !== currentSha) return build('checkout differs from deployment SHA');
    const changed = diffImpl(prevSha, currentSha);
    if (!changed.length) return { shouldBuild: false, reason: 'no changed files' };
    const graphs = [
      storybookInputs(snapshotImpl(prevSha)),
      storybookInputs(snapshotImpl(currentSha)),
    ];
    for (const path of changed) {
      if (
        GLOBAL.test(path) ||
        path.startsWith('apps/storybook/') ||
        path === 'scripts/ci/storybook-impact.mjs'
      )
        return build(`build input: ${path}`);
      if (graphs.some(({ inputs }) => inputs.has(path))) return build(`source dependency: ${path}`);
      // New/deleted binary assets are absent from text snapshots; classify their workspace bucket.
      if (
        graphs.some(({ directories }) => [...directories].some((dir) => path.startsWith(`${dir}/`)))
      ) {
        if (
          !BACKEND.test(path) &&
          !DOCUMENTATION.test(path) &&
          !/\/scripts\//.test(path) &&
          !TEST.test(path) &&
          !/\.md$/.test(path)
        )
          return build(`workspace input: ${path}`);
        continue;
      }
      if (
        /^(docs|supabase|\.agents|\.claude|\.codex|\.github)\//.test(path) ||
        /\.md$/.test(path) ||
        /^scripts\//.test(path)
      )
        continue;
      if (/^(apps|packages)\//.test(path)) continue;
      return build(`unknown input: ${path}`);
    }
    return { shouldBuild: false, reason: 'no Storybook input changes' };
  } catch (error) {
    return build(`cannot establish input impact: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = resolveStorybookIgnore({
    prevSha: process.env.VERCEL_GIT_PREVIOUS_SHA,
    currentSha: process.env.VERCEL_GIT_COMMIT_SHA,
  });
  console.log(`Storybook: ${result.shouldBuild ? 'build' : 'skip'} — ${result.reason}`);
  process.exitCode = result.shouldBuild ? 1 : 0;
}
