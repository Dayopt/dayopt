import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Synthetic identifiers only; preserves recovery evidence if the runner is interrupted. */
export function recordPreviewUser(
  userId: string,
  status: 'creating' | 'creation-unconfirmed' | 'created' | 'cleanup-failed' | 'deleted',
): void {
  const directory = process.env.E2E_PREVIEW_EVIDENCE_DIR;
  if (!directory) return;
  const runId = process.env.E2E_PREVIEW_RUN_ID;
  if (!runId || !UUID.test(runId) || !UUID.test(userId)) {
    throw new Error('Preview lifecycle requires valid synthetic run/user IDs');
  }
  const users = join(directory, 'users');
  mkdirSync(users, { recursive: true, mode: 0o700 });
  const path = join(users, `${userId}.json`);
  writeFileSync(
    `${path}.tmp`,
    JSON.stringify({ runId, userId, status, observedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  renameSync(`${path}.tmp`, path);
}
