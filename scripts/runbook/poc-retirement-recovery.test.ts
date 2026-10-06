import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderPocRetirementRecovery } from './poc-retirement-recovery.mjs';

const original = readFileSync(
  new URL(
    '../../supabase/migrations/_archive/20261003073817_supabase_rate_limit_idempotency_poc.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('offline POC RPC recovery', () => {
  it('recreates exactly five original RPCs and original execution grants, without recreating state', () => {
    const sql = renderPocRetirementRecovery(original);
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\./g)).toHaveLength(5);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\./g)).toHaveLength(5);
    expect(sql).toContain('DO $poc_contract$');
    expect(sql).not.toMatch(/CREATE (?:TABLE|SCHEMA)|DROP (?:TABLE|SCHEMA)/i);
    expect(sql).toMatch(/^BEGIN;/);
    expect(sql).toMatch(/COMMIT;\n$/);
  });
  it('refuses changed or missing archive source before producing recovery SQL', () => {
    expect(() => renderPocRetirementRecovery(original + '-- changed')).toThrow('byte-identical');
    expect(() => renderPocRetirementRecovery('')).toThrow('byte-identical');
  });
});
