import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectorEnvironment } from './auth.ts';
import { parseArgs } from './cli.ts';
import { loadConfig } from './config.ts';
const root = resolve(import.meta.dirname, '../..');
describe('doctor CLI contracts', () => {
  it('rejects unsupported flags and invalid selectors', () => {
    for (const args of [
      ['--fix'],
      ['--environment', 'test'],
      ['--format', 'csv'],
      ['--service'],
      ['--collector', 'github'],
    ])
      expect(() => parseArgs(args)).toThrow();
  });
  it('lists every service and stable check once without auth or network', () => {
    const text = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/doctor/cli.ts', '--list', '--format', 'json'],
      { cwd: root, encoding: 'utf8' },
    );
    const checks = JSON.parse(text);
    const services = new Set(checks.map((entry: { service: string }) => entry.service));
    for (const service of [
      'github',
      'vercel',
      'supabase',
      'stripe',
      'resend',
      'cloudflare',
      'sentry',
      'posthog',
      'upstash',
      'uptimerobot',
      'google',
      'mcp_oauth',
      'telemetry',
      'pwned_passwords',
      'support_smtp',
      'optional',
    ])
      expect(services.has(service)).toBe(true);
    expect(new Set(checks.map((entry: { id: string }) => entry.id)).size).toBe(checks.length);
  });
  it('offline validates references without needing op or inherited credentials', () => {
    const text = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/doctor/cli.ts', '--offline', '--format', 'json'],
      { cwd: root, encoding: 'utf8', env: { PATH: '/nonexistent' } },
    );
    expect(JSON.parse(text)).toMatchObject({
      mode: 'offline',
      schema_valid: true,
      network_attempted: false,
    });
  });
  it('does not inherit unrelated credentials or op:// variables into child auth', () => {
    const env = collectorEnvironment('github', {
      PATH: '/bin',
      HOME: '/fixture',
      OTHER_TOKEN: 'secret-fixture',
      UNRELATED: 'op://other/item/field',
      GH_TOKEN: 'raw-fixture',
    });
    expect(env.GH_TOKEN).toBe('op://agent/github-agent/credential');
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env).not.toHaveProperty('UNRELATED');
  });
  it('all contract references and secret master strings are parseable offline', () => {
    const config = loadConfig(root);
    expect(config.scope.project).toBe('Dayopt');
    expect(config.secret_refs.integration_managed_supabase).toMatchObject({ op_ref: null });
    expect(config.secret_refs.posthog_delete).toMatchObject({
      op_ref: 'op://human/posthog-delete/credential',
    });
  });
});
