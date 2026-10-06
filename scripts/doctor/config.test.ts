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
  it('preserves the exact item label without trimming its spaces', () => {
    const result = fixture((config) => {
      config.resources.human_onepassword_items.items.vercel.item = ' existing item ';
    });
    expect(result.resources.human_onepassword_items?.items.vercel.item).toBe(' existing item ');
  });
  it('rejects confirmed item presence without a confirming actor', () => {
    expect(() =>
      fixture((config) => {
        delete config.resources.human_onepassword_items.confirmed_by;
      }),
    ).toThrow();
  });
  it.each(['human_onepassword_items', 'ci_onepassword_items'])(
    'rejects a missing or impossible confirmation date in %s',
    (group) => {
      for (const value of [undefined, '2026-02-30', '2026-13-01']) {
        expect(() =>
          fixture((config) => {
            config.resources[group].verified_at = value;
          }),
        ).toThrow();
      }
    },
  );
  it('rejects an incomplete complete-locator and a missing explanation', () => {
    expect(() =>
      fixture((config) => {
        config.resources.human_onepassword_items.items.vercel.item = null;
      }),
    ).toThrow();
    expect(() =>
      fixture((config) => {
        delete config.resources.human_onepassword_items.items.github.reason;
      }),
    ).toThrow();
  });
  it('rejects unknown services, contract references and duplicate ci items', () => {
    expect(() =>
      fixture((config) => {
        config.resources.human_onepassword_items.items.missing =
          config.resources.human_onepassword_items.items.vercel;
      }),
    ).toThrow();
    expect(() =>
      fixture((config) => {
        config.resources.ci_onepassword_items.contract_refs = ['missing'];
      }),
    ).toThrow();
    expect(() =>
      fixture((config) => {
        config.resources.ci_onepassword_items.items.push(
          config.resources.ci_onepassword_items.items[0],
        );
      }),
    ).toThrow();
  });
  it('rejects secret fields and personal email or URL in item labels', () => {
    for (const value of [
      'account person@example.test',
      'https://example.test/item',
      'op://human/item/password',
    ]) {
      expect(() =>
        fixture((config) => {
          config.resources.human_onepassword_items.items.vercel.item = value;
        }),
      ).toThrow();
    }
    expect(() =>
      fixture((config) => {
        config.resources.human_onepassword_items.items.vercel.password = 'FAKE_SECRET';
      }),
    ).toThrow();
  });
  it('accepts unknown presence without human confirmation and absent legacy locator records', () => {
    expect(
      fixture((config) => {
        for (const entry of Object.values(config.resources.human_onepassword_items.items) as {
          presence_status: string;
        }[])
          entry.presence_status = 'unknown';
        delete config.resources.human_onepassword_items.confirmed_by;
        delete config.resources.human_onepassword_items.verified_at;
        config.resources.ci_onepassword_items.presence_status = 'unknown';
        delete config.resources.ci_onepassword_items.confirmed_by;
        delete config.resources.ci_onepassword_items.verified_at;
      }),
    ).toBeDefined();
    expect(
      fixture((config) => {
        delete config.resources.human_onepassword_items;
        delete config.resources.ci_onepassword_items;
      }),
    ).toBeDefined();
  });
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
  it('rejects a service without its role or canonical design references', () => {
    expect(() =>
      fixture((config) => {
        delete config.services.github.purpose;
      }),
    ).toThrow();
    expect(() =>
      fixture((config) => {
        config.services.github.contract_refs = ['missing'];
      }),
    ).toThrow();
  });
  it('rejects a check whose service has no design entry', () => {
    expect(() =>
      fixture((config) => {
        delete config.services.github;
      }),
    ).toThrow();
  });
});
