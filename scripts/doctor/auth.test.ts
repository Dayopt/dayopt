import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectAuthenticated, collectorEnvironment } from './auth';
import { ReadFailure } from './safety';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

function collectorChild() {
  return Object.assign(new EventEmitter(), {
    pid: 987654321,
    exitCode: null as number | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('authenticated collector timeout', () => {
  it('resolves only the selected Stripe mode credentials', () => {
    expect(collectorEnvironment('stripe', {}, 'integration')).toMatchObject({
      STRIPE_TEST_SECRET_KEY: 'op://agent/stripe-test/STRIPE_SECRET_KEY',
    });
    expect(collectorEnvironment('stripe', {}, 'integration')).not.toHaveProperty(
      'STRIPE_LIVE_SECRET_KEY',
    );
    expect(collectorEnvironment('stripe', {}, 'production')).not.toHaveProperty(
      'STRIPE_TEST_SECRET_KEY',
    );
  });

  it('keeps Stripe Test observations when Live authentication fails without switching authentication paths', async () => {
    const live = collectorChild();
    const test = collectorChild();
    mocks.spawn.mockReturnValueOnce(live).mockReturnValueOnce(test);
    const pending = collectAuthenticated('stripe', 'all', resolve(import.meta.dirname, '../..'));
    live.stderr.emit('data', Buffer.from('FAKE_AUTH_DIAGNOSTIC'));
    live.exitCode = 1;
    live.emit('close', 1);
    await vi.advanceTimersByTimeAsync(0);
    test.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify([
          {
            key: 'stripe.account',
            environment: 'integration',
            source: 'stripe.account',
            value: { id: 'test-account' },
          },
        ]),
      ),
    );
    test.exitCode = 0;
    test.emit('close', 0);
    const result = await pending;
    expect(result.filter((row) => row.environment === 'production')).toHaveLength(5);
    expect(result.find((row) => row.environment === 'production')).toMatchObject({
      status: 'blocked',
      reason: 'credential_or_collector_failed',
    });
    expect(result.find((row) => row.environment === 'integration')?.value).toEqual({
      id: 'test-account',
    });
    expect(mocks.spawn.mock.calls.map((call) => call[0])).toEqual(['op', 'op']);
    expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty('STRIPE_TEST_SECRET_KEY');
    expect(mocks.spawn.mock.calls[1][2].env).not.toHaveProperty('STRIPE_LIVE_SECRET_KEY');
    expect(JSON.stringify(result)).not.toContain('FAKE_AUTH_DIAGNOSTIC');
  });
  it('preserves the Codex identity required by the agent-only op wrapper without inheriting auth overrides', () => {
    const environment = collectorEnvironment('github', {
      PATH: '/bin',
      CODEX_THREAD_ID: 'audit-thread',
      CODEX_SESSION_ID: 'audit-session',
      OP_SERVICE_ACCOUNT_TOKEN: 'FAKE_UNRELATED_TOKEN',
      OP_CONFIG_DIR: '/alternate-auth',
      UNRELATED: 'op://human/unrelated/password',
    });
    expect(environment).toEqual({
      PATH: '/bin',
      CODEX_THREAD_ID: 'audit-thread',
      CODEX_SESSION_ID: 'audit-session',
      GH_TOKEN: 'op://agent/github-agent/credential',
      DOCTOR_INTERNAL: '1',
    });
  });

  it('waits at most 120 seconds and stops the process group, then hard-stops an unresponsive child', async () => {
    const child = collectorChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let settled = false;
    const failure = collectAuthenticated('github', 'all', '/repository').catch((error) => {
      settled = true;
      return error;
    });
    child.stderr.emit('data', Buffer.from('authorization timeout FAKE_STDERR_SECRET'));
    child.stdout.emit('data', Buffer.from('FAKE_STDOUT_SECRET'));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toBeInstanceOf(ReadFailure);
    expect((await failure).message).toBe('authorization_or_service_timeout');
    expect(kill).toHaveBeenNthCalledWith(1, -child.pid, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1999);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenNthCalledWith(2, -child.pid, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(JSON.stringify(await failure)).not.toContain('FAKE_STDERR_SECRET');
    expect(JSON.stringify(await failure)).not.toContain('FAKE_STDOUT_SECRET');
  });

  it('falls back to child.kill when stopping the detached group fails', async () => {
    const child = collectorChild();
    mocks.spawn.mockReturnValue(child);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('FAKE_GROUP_ERROR_SECRET');
    });
    const failure = collectAuthenticated('github', 'production', '/repository').catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await failure).message).toBe('authorization_or_service_timeout');
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(JSON.stringify(await failure)).not.toContain('FAKE_GROUP_ERROR_SECRET');
  });

  it('does not send SIGKILL after the child has exited following timeout', async () => {
    const child = collectorChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const failure = collectAuthenticated('github', 'all', '/repository').catch((error) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    await failure;
    child.exitCode = 143;
    child.emit('close', 143);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGTERM');
  });

  it('classifies op authorization stderr without exposing it and cancels the timer on close', async () => {
    const child = collectorChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const failure = collectAuthenticated('github', 'all', '/repository').catch((error) => error);
    child.stderr.emit('data', Buffer.from('authorization timeout: FAKE_STDERR_SECRET'));
    child.exitCode = 1;
    child.emit('close', 1);
    expect((await failure).message).toBe('authorization_timeout');
    expect(JSON.stringify(await failure)).not.toContain('FAKE_STDERR_SECRET');
    await vi.advanceTimersByTimeAsync(122_000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('runs only op run with service-specific refs and isolated collector environment', async () => {
    const child = collectorChild();
    mocks.spawn.mockReturnValue(child);
    const pending = collectAuthenticated('github', 'preview', '/repository');
    child.stdout.emit('data', Buffer.from('[]'));
    child.exitCode = 0;
    child.emit('close', 0);
    expect(await pending).toEqual([]);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe('op');
    expect(args.slice(0, 2)).toEqual(['run', '--']);
    expect(args).toContain('--collector');
    expect(options).toMatchObject({
      detached: true,
      cwd: '/repository',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const isolated = collectorEnvironment('github', {
      PATH: '/bin',
      HOME: '/home/user',
      UNRELATED: 'op://private/item/field',
      GH_TOKEN: 'FAKE_INHERITED_SECRET',
    });
    expect(isolated).toEqual({
      PATH: '/bin',
      HOME: '/home/user',
      GH_TOKEN: 'op://agent/github-agent/credential',
      DOCTOR_INTERNAL: '1',
    });
  });
});
