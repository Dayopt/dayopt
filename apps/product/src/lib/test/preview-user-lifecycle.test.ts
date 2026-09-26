import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordPreviewUser } from './preview-user-lifecycle';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('Preview synthetic user evidence', () => {
  it('再取得に必要な合成IDと状態だけを記録する', () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-user-'));
    roots.push(root);
    const id = '11111111-1111-1111-1111-111111111111';
    vi.stubEnv('E2E_PREVIEW_EVIDENCE_DIR', root);
    vi.stubEnv('E2E_PREVIEW_RUN_ID', id);
    recordPreviewUser(id, 'creating');
    expect(JSON.parse(readFileSync(join(root, 'users', `${id}.json`), 'utf8'))).toMatchObject({
      runId: id,
      userId: id,
      status: 'creating',
    });
    recordPreviewUser(id, 'deleted');
    const result = JSON.parse(readFileSync(join(root, 'users', `${id}.json`), 'utf8'));
    expect(Object.keys(result).sort()).toEqual(['observedAt', 'runId', 'status', 'userId']);
    expect(result.status).toBe('deleted');
    expect(readdirSync(join(root, 'users'))).toEqual([`${id}.json`]);
  });
  it('不正IDをファイルpathに使わない', () => {
    vi.stubEnv('E2E_PREVIEW_EVIDENCE_DIR', '/unused');
    vi.stubEnv('E2E_PREVIEW_RUN_ID', 'invalid');
    expect(() => recordPreviewUser('../secret', 'creating')).toThrow();
  });
});
