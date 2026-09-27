/** Shared by smoke, batch and interactive entrypoints. No process-local rate assumption. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function jevStoreRoot(cwd = process.cwd()): string {
  return join(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
    }).trim(),
    'jev',
  );
}

export type JevSendBlock =
  | 'cooldown'
  | 'rate_locked'
  | 'rate_state_invalid'
  | 'rate_state_unreadable'
  | 'rate_state_unwritable';

/** Serialize the check+reservation, including callers straddling a minute boundary. */
export function reserveJevSend(root: string, now = Date.now()): JevSendBlock | null {
  const slots = join(root, 'send-slots');
  try {
    mkdirSync(slots, { recursive: true });
  } catch {
    return 'rate_state_unwritable';
  }
  const lock = join(slots, 'reservation.lock');
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, reservedAt: now }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    return errorCode(error) === 'EEXIST' ? 'rate_locked' : 'rate_state_unwritable';
  }
  try {
    return reserveSlot(slots, now);
  } finally {
    // Never reclaim another caller's lock by age. A crash requires explicit operator recovery.
    unlinkSync(lock);
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' ? code : null;
}

function reserveSlot(slots: string, now: number): JevSendBlock | null {
  const slot = Math.floor(now / 60_000);
  const previous = join(slots, `${slot - 1}.json`);
  if (existsSync(previous)) {
    try {
      const value: unknown = JSON.parse(readFileSync(previous, 'utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('sentAt' in value) ||
        typeof value.sentAt !== 'number' ||
        !Number.isFinite(value.sentAt)
      )
        return 'rate_state_invalid';
      if (now - value.sentAt < 60_000) return 'cooldown';
    } catch {
      return 'rate_state_unreadable';
    }
  }
  try {
    writeFileSync(join(slots, `${slot}.json`), JSON.stringify({ sentAt: now }), {
      flag: 'wx',
      mode: 0o600,
    });
    return null;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EEXIST'
      ? 'cooldown'
      : 'rate_state_unwritable';
  }
}
