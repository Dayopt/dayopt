import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Definition } from './types.ts';

const stableId = z.string().regex(/^[a-z0-9_.-]+$/);
const environments = z
  .array(z.enum(['shared', 'all', 'production', 'preview', 'integration']))
  .min(1);
const connection = z
  .object({
    id: stableId,
    service: z.string(),
    environments,
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.string().min(1),
    expected: z.string().min(1),
    check_ids: z.array(stableId).min(1),
    contract_refs: z.array(z.string()).default([]),
    secret_refs: z.array(z.string()).default([]),
  })
  .strict();
const limitation = z
  .object({
    id: stableId,
    service: z.string(),
    category: z.enum([
      'api_not_provided_confirmed',
      'current_permission',
      'collector_unavailable',
      'secret_not_redisplayable',
      'api_secret_unavailable_ui_available',
      'behavior_not_metadata',
    ]),
    items: z.array(z.string()).min(1),
    reason: z.string().min(1),
    next_step: z.string().min(1),
    check_ids: z.array(stableId).min(1),
    documentation_urls: z.array(z.string().url()).default([]),
  })
  .strict();

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
    connections: z.array(connection).default([]),
    ui_only: z.array(limitation).default([]),
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
  const services = new Set(config.checks.map((item) => item.service));
  for (const entries of [config.connections, config.ui_only]) {
    const entryIds = new Set<string>();
    for (const entry of entries) {
      if (entryIds.has(entry.id)) throw new Error('Duplicate inventory ID');
      entryIds.add(entry.id);
      if (!services.has(entry.service) || entry.check_ids.some((id) => !ids.has(id)))
        throw new Error('Unknown inventory service or check reference');
    }
  }
  for (const entry of config.connections) {
    if (
      entry.contract_refs.some((ref) => !(ref in config.source_contracts)) ||
      entry.secret_refs.some((ref) => !(ref in config.secret_refs))
    )
      throw new Error('Unknown connection contract or secret reference');
  }
  for (const value of Object.values(config.secret_refs)) {
    if (
      value &&
      typeof value === 'object' &&
      'op_ref' in value &&
      value.op_ref !== null &&
      (typeof value.op_ref !== 'string' || !/^op:\/\/[^/?#]+\/[^/?#]+\/[^/?#]+$/.test(value.op_ref))
    )
      throw new Error('Invalid secret reference');
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
