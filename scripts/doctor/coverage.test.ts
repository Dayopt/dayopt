import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { designCoverage, renderCoverage } from './coverage.ts';

const config = loadConfig(resolve(import.meta.dirname, '../..'));
describe('design coverage', () => {
  it('describes every registered service without claiming current provider verification', () => {
    const report = designCoverage(config, { environment: 'all' });
    expect(report).toMatchObject({
      network_attempted: false,
      declaration_only: true,
      configuration_verified: false,
    });
    expect(report.service_count).toBe(new Set(config.checks.map((check) => check.service)).size);
    expect(report.check_count).toBe(config.checks.length);
    const vault = report.services.find((entry) => entry.service === 'onepassword');
    expect(
      vault?.checks.find((check) => check.id === 'onepassword.access_and_recovery')?.method,
    ).toBe('manual_verification');
    expect(
      report.services
        .find((entry) => entry.service === 'stripe')
        ?.checks.find((check) => check.id === 'stripe.portal')?.method,
    ).toBe('metadata_or_source_only');
    expect(
      report.services.every(
        (entry) => entry.contracts.length && entry.failure_impact && entry.review_triggers.length,
      ),
    ).toBe(true);
  });
  it('filters checks by environment and retains shared constraints and cross-service connections', () => {
    const report = designCoverage(config, { service: 'supabase', environment: 'integration' });
    expect(report.service_count).toBe(1);
    expect(
      report.services[0].checks.some((check) => check.id === 'supabase.production.project'),
    ).toBe(false);
    expect(
      report.services[0].checks.some((check) => check.id === 'supabase.integration.project'),
    ).toBe(true);
    expect(
      report.services[0].connections.some((entry) => entry.id === 'vercel.integration.supabase'),
    ).toBe(true);
  });
  it.each(['text', 'json'] as const)('sanitizes metadata and secrets in %s coverage', (format) => {
    const fixture = structuredClone(config);
    fixture.services.github.expected.endpoint =
      'https://user:FAKE_PASS@example.test/hooks/FAKE_PATH?key=FAKE_QUERY';
    fixture.services.github.expected.token = 'FAKE_SECRET';
    const text = renderCoverage(fixture, format, { service: 'github', environment: 'all' });
    expect(text).not.toMatch(/FAKE_PASS|FAKE_PATH|FAKE_QUERY|FAKE_SECRET/);
  });
});
