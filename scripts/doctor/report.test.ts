import { describe, expect, it } from 'vitest';
import { exitCode, renderReport } from './report';
import type { Result, Status } from './types';

const result = (status: Status, required = true): Result => ({
  check_id: 'fixture:production',
  service: 'fixture',
  environment: 'production',
  expected: true,
  observed: true,
  source: 'fixture',
  checked_at: '2026-09-30T00:00:00Z',
  status,
  reason: 'fixture',
  next_step: 'Inspect settings.',
  required,
});
describe('doctor report', () => {
  it('returns 0 for pass and optional/manual, 1 for drift, 2 for required unknown', () => {
    expect(exitCode([result('pass'), result('not_applicable')])).toBe(0);
    expect(exitCode([result('manual', false), result('blocked', false)])).toBe(0);
    expect(exitCode([result('drift')])).toBe(1);
    expect(exitCode([result('blocked')])).toBe(2);
    expect(exitCode([result('manual')])).toBe(2);
    expect(exitCode([result('drift'), result('blocked')])).toBe(1);
  });
  it.each(['text', 'json'] as const)('sanitizes secrets and URLs in %s output', (format) => {
    const fixture = {
      ...result('manual'),
      observed: {
        secret: 'FAKE_NESTED_SECRET',
        endpoint:
          'https://FAKE_USER:FAKE_PASS@example.test/api/webhooks/stripe?token=FAKE_QUERY#FAKE_FRAGMENT',
        raw: 'whsec_FAKE_SIGNING',
      },
      reason: 'https://example.test/deploy-hook/FAKE_PATH',
    };
    const report = renderReport([fixture], format, { source: 'fixture' });
    for (const sentinel of [
      'FAKE_NESTED_SECRET',
      'FAKE_USER',
      'FAKE_PASS',
      'FAKE_QUERY',
      'FAKE_FRAGMENT',
      'FAKE_SIGNING',
      'FAKE_PATH',
    ])
      expect(report).not.toContain(sentinel);
    expect(report).toContain('manual');
  });
  it('includes counts and required manual classification in JSON', () => {
    const report = JSON.parse(
      renderReport([result('pass'), result('manual')], 'json', { revision: 'abcdef1' }),
    );
    expect(report).toMatchObject({
      exit_code: 2,
      revision: 'abcdef1',
      counts: { pass: 1, manual: 1 },
    });
    expect(report.results[1].required).toBe(true);
  });
});
