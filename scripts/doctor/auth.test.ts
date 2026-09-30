import { EventEmitter } from 'node:events';
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
