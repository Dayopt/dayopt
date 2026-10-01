import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadConfig } from './config.ts';

const root = resolve(import.meta.dirname, '../..');
function fixture(mutate: (config: ReturnType<typeof parse>) => void) {
  const config = parse(readFileSync(resolve(root, 'docs/engineering/infra/expected.yaml'), 'utf8'));
  for (const key of Object.keys(config.source_contracts)) config.source_contracts[key] = [];
  config.connections = [
    {
      id: 'github.product.release',
      service: 'github',
      environments: ['production'],
      from: 'Dayopt/dayopt Actions',
      to: 'Vercel Product',
      type: 'release_control',
      expected: 'main only',
      check_ids: ['github.repository'],
      contract_refs: ['release'],
      secret_refs: ['product_bypass'],
    },
  ];
  config.ui_only = [
    {
      id: 'github.secret.values',
      service: 'github',
      category: 'secret_not_redisplayable',
      items: ['Actions secret values'],
      reason: 'metadata only',
      next_step: 'Inspect names only',
      check_ids: ['github.production-release.secret_names'],
      documentation_urls: [],
    },
  ];
  mutate(config);
  const directory = mkdtempSync(resolve(tmpdir(), 'dayopt-doctor-config-'));
  mkdirSync(resolve(directory, 'docs/engineering/infra'), { recursive: true });
  writeFileSync(resolve(directory, 'docs/engineering/infra/expected.yaml'), stringify(config));
  try {
    return loadConfig(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('inventory connection and capability contracts', () => {
  it('accepts stable connections and separate capability limitations offline', () => {
    expect(fixture(() => {})).toMatchObject({
      connections: [{ id: 'github.product.release' }],
      ui_only: [{ category: 'secret_not_redisplayable' }],
    });
  });
  it.each(['check_ids', 'contract_refs', 'secret_refs'])(
    'rejects a dangling connection %s',
    (field) => {
      expect(() =>
        fixture((config) => {
          config.connections[0][field] = ['missing'];
        }),
      ).toThrow();
    },
  );
  it.each(['connections', 'ui_only'])('rejects duplicate IDs in %s', (field) => {
    expect(() =>
      fixture((config) => {
        config[field].push(config[field][0]);
      }),
    ).toThrow();
  });
  it.each(['connections', 'ui_only'])('rejects an unknown service in %s', (field) => {
    expect(() =>
      fixture((config) => {
        config[field][0].service = 'unknown';
      }),
    ).toThrow();
  });
  it('rejects an unknown UI check and an unrecognized limitation category', () => {
    expect(() =>
      fixture((config) => {
        config.ui_only[0].check_ids = ['missing'];
      }),
    ).toThrow();
    expect(() =>
      fixture((config) => {
        config.ui_only[0].category = 'everything_ui_only';
      }),
    ).toThrow();
  });
  it('does not allow a raw secret in an op_ref field', () => {
    expect(() =>
      fixture((config) => {
        config.secret_refs.product_bypass.op_ref = 'FAKE_SECRET';
      }),
    ).toThrow();
  });
  it('keeps every inventory connection and limitation tied to checks in the real contract', () => {
    const config = loadConfig(root);
    expect(config.connections.length).toBeGreaterThan(30);
    expect(config.ui_only.length).toBeGreaterThan(10);
  });
});
