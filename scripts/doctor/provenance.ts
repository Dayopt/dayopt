import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export function isPrivateEnvironmentPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((part) => /^\.env(?:$|\.)/.test(part) || /^\.op-env(?:$|\.)/.test(part));
}

/** Hash only registered repository contracts, never credentials or live responses. */
export function contractFingerprint(root: string, contracts: Record<string, string[]>): string {
  const files = new Set<string>();
  function visit(path: string) {
    if (isPrivateEnvironmentPath(relative(root, path))) throw new Error('private_contract_path');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('symlink_contract_path');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) files.add(path);
    else throw new Error('invalid_contract_path');
  }
  for (const paths of Object.values(contracts))
    for (const path of paths) {
      const absolute = resolve(root, path);
      if (relative(root, absolute).startsWith('..') || path.startsWith('/'))
        throw new Error('invalid_contract_path');
      const parts = relative(root, absolute).split(/[\\/]/);
      for (let i = 1; i < parts.length; i++)
        if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink())
          throw new Error('symlink_contract_path');
      visit(absolute);
    }
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(relative(root, file)).update('\0');
    hash.update(createHash('sha256').update(readFileSync(file)).digest()).update('\0');
  }
  return hash.digest('hex');
}
