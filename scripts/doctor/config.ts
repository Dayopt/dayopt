import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Definition } from './types.ts';

const check = z
  .object({
    id: z.string().regex(/^[a-z0-9_.-]+$/),
    service: z.string(),
    environments: z.array(z.enum(['shared', 'all', 'production', 'preview', 'integration'])).min(1),
    rule: z.string(),
    expected: z.unknown().optional(),
    required: z.boolean().default(true),
    next_step: z.string(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    scope: z.object({ project: z.literal('Dayopt') }).passthrough(),
    source_contracts: z.record(z.string(), z.array(z.string())),
    services: z.record(z.string(), z.unknown()),
    secret_refs: z.record(z.string(), z.unknown()),
    resources: z.record(z.string(), z.unknown()),
    advisories: z.array(z.unknown()),
    checks: z.array(check).min(1),
  })
  .strict();
export function loadConfig(root: string) {
  const document = parseDocument(
    readFileSync(resolve(root, 'docs/engineering/infra/expected.yaml'), 'utf8'),
    { uniqueKeys: true },
  );
  if (document.errors.length) throw new Error('Invalid expected YAML');
  const config = schema.parse(document.toJS({ maxAliasCount: 0 }));
  const ids = new Set<string>();
  for (const item of config.checks) {
    if (ids.has(item.id)) throw new Error('Duplicate check ID');
    ids.add(item.id);
  }
  for (const paths of Object.values(config.source_contracts))
    for (const path of paths) {
      if (
        path.startsWith('/') ||
        path.split('/').includes('..') ||
        !existsSync(resolve(root, path))
      ) {
        throw new Error('Missing or invalid contract reference');
      }
    }
  return config as typeof config & { checks: Definition[] };
}
