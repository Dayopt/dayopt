vi.mock('../runbook/doctor-trusted.mjs', () => ({ assertTrustedRuntime: vi.fn() }));
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './cli.ts';

const state = vi.hoisted(() => ({ value: true, blocked: false }));
vi.mock('./config.ts', () => ({
  loadConfig: () => ({
    scope: { repository_baseline: 'fixture-baseline' },
    advisories: [],
    source_contracts: {},
    checks: [
      {
        id: 'onepassword.fixture',
        service: 'onepassword',
        environments: ['all'],
        rule: 'subset',
        expected: { ready: true },
        required: true,
        next_step: 'Review fixture.',
      },
    ],
  }),
}));
vi.mock('./provenance.ts', () => ({ contractFingerprint: () => 'b'.repeat(64) }));
vi.mock('./readers/local.ts', () => ({
  readLocal: async () => [
    {
      key: 'onepassword.fixture',
      environment: 'production',
      value: state.blocked ? null : { ready: state.value },
      source: 'fixture',
      ...(state.blocked ? { status: 'blocked', reason: 'permission_denied' } : {}),
    },
  ],
}));
vi.mock('./auth.ts', () => ({ CREDENTIALS: {}, collectAuthenticated: vi.fn() }));

let output = '';
let writeSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doctor-cli-history-'));
  await mkdir(join(root, 'docs', 'engineering', 'infra'), { recursive: true });
  await (
    await import('node:fs/promises')
  ).writeFile(join(root, 'docs/engineering/infra/expected.yaml'), 'fixture expected\\n');
  output = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  return root;
}
afterEach(() => {
  writeSpy?.mockRestore();
  errorSpy?.mockRestore();
});

describe('doctor CLI history recording', () => {
  it('keeps the sanitized current report on stdout when stored history is invalid', async () => {
    const root = await fixture();
    const historyDir = join(root, '.local/infra-doctor/history');
    await mkdir(historyDir, { recursive: true });
    await (
      await import('node:fs/promises')
    ).writeFile(join(historyDir, 'bad.json'), '{"token":"FAKE_SECRET_VALUE"');
    let stderr = '';
    errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    state.blocked = false;
    state.value = true;
    expect(await run(['--record', '--format', 'json'], root)).toBe(3);
    const emitted = JSON.parse(output);
    expect(emitted.history_saved).toBe(false);
    expect(emitted.history_error).toBe('history_invalid_file');
    expect(emitted.results).toHaveLength(1);
    expect(emitted.exit_code).toBe(0);
    expect(output).not.toContain('FAKE_SECRET_VALUE');
    expect(stderr).not.toContain('FAKE_SECRET_VALUE');
  });
  it('records default text and JSON runs, preserves unknown exit code, and compares actual changes', async () => {
    const root = await fixture();
    state.blocked = true;
    expect(await run(['--record'], root)).toBe(2);
    expect(output).toContain('前回比較: なし (no_previous_record)');
    const historyDir = join(root, '.local/infra-doctor/history');
    let names = await readdir(historyDir);
    const first = JSON.parse(await readFile(join(historyDir, names[0]), 'utf8'));
    expect(first.exit_code).toBe(2);
    expect(first.comparison_available).toBe(false);
    expect(first.comparison_reason).toBe('no_previous_record');

    writeSpy.mockRestore();
    output = '';
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.blocked = false;
    state.value = false;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    expect(await run(['--record', '--format', 'json'], root)).toBe(1);
    const emitted = JSON.parse(output);
    expect(emitted.comparison_available).toBe(true);
    expect(emitted.history_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_id: 'onepassword.fixture',
          environment: 'production',
          kind: 'status_changed',
        }),
        expect.objectContaining({
          check_id: 'onepassword.fixture',
          environment: 'production',
          kind: 'observed_changed',
        }),
      ]),
    );
    names = await readdir(historyDir);
    const latest = JSON.parse(
      await readFile(
        join(
          historyDir,
          names.find((name) => name !== names[0])!,
        ),
        'utf8',
      ),
    );
    expect(latest.exit_code).toBe(1);
    expect(latest.comparison_available).toBe(true);
  });
});
