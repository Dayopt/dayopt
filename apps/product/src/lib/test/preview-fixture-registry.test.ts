import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminSupabase, createCriticalPathIdentity } from './e2e/critical-path-fixture';

vi.mock('@playwright/test', () => ({ expect: vi.fn() }));

import { loadPreviewFixtureRegistry, resolveCriticalPathTarget } from './preview-fixture-registry';

const ids = {
  desktop: '22222222-2222-4222-8222-222222222222',
  mobile: '33333333-3333-4333-8333-333333333333',
};
const ref = 'abcdefghijklmnopqrst';
const runId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://product-abc123-dayopt.vercel.app';
let root: string;
let env: Record<string, string>;
let registry: ReturnType<typeof fixture>;
function fixture() {
  return {
    schemaVersion: 1,
    operation: 'provision',
    runId,
    origin,
    supabaseProjectRef: ref,
    users: Object.fromEntries(
      Object.entries(ids).map(([slot, id]) => [
        slot,
        {
          userId: id,
          email: `${slot === 'desktop' ? 'critical-path' : 'mobile-critical-path'}-${id}@example.com`,
          password: `E2e!${'a'.repeat(43)}`,
          activityName: `Journey ${id.slice(0, 8)}`,
          categoryName: `Cat ${id.slice(0, 8)}`,
        },
      ]),
    ),
  };
}
function save() {
  writeFileSync(env.E2E_PREVIEW_FIXTURE_REGISTRY!, JSON.stringify(registry), { mode: 0o600 });
}
function rejected() {
  expect(() => loadPreviewFixtureRegistry(env)).toThrow(/^Preview fixture registry is invalid$/);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preview-login-registry-'));
  for (const dir of ['credentials', 'private', 'evidence'])
    mkdirSync(join(root, dir), { mode: 0o700 });
  registry = fixture();
  env = {
    E2E_PREVIEW_FIXTURE_REGISTRY: join(root, 'credentials', 'login.json'),
    E2E_PREVIEW_PRIVATE_DIR: join(root, 'private'),
    E2E_PREVIEW_EVIDENCE_DIR: join(root, 'evidence'),
    E2E_PREVIEW_CLOUD_INTENT: '1',
    E2E_ALLOW_NONLOCAL_SUPABASE: '1',
    E2E_PREVIEW_DB_MODE: 'ephemeral',
    E2E_PREVIEW_ORIGIN: origin,
    E2E_PREVIEW_RUN_ID: runId,
    E2E_SUPABASE_PROJECT_REF: ref,
    NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    E2E_PREVIEW_DESKTOP_USER_ID: ids.desktop,
    E2E_PREVIEW_MOBILE_USER_ID: ids.mobile,
  };
  save();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('private preprovisioned Preview logins', () => {
  it('uses the same provisioned identities and refuses admin client creation', () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(createCriticalPathIdentity('critical-path')).toEqual({
      prefix: 'critical-path',
      ...registry.users.desktop,
    });
    expect(createCriticalPathIdentity('mobile-critical-path')).toEqual({
      prefix: 'mobile-critical-path',
      ...registry.users.mobile,
    });
    expect(() => createCriticalPathIdentity('other')).toThrow('identity slot is invalid');
    expect(() => createAdminSupabase(env.NEXT_PUBLIC_SUPABASE_URL!, 'must-not-leak')).toThrow(
      'cannot construct an admin client',
    );
  });
  it('loads only the predeclared two normal logins without admin authority', () => {
    expect(loadPreviewFixtureRegistry(env)).toEqual(registry);
    expect(resolveCriticalPathTarget(env)).toEqual({ safe: true });
  });
  it('preserves legacy service-role target selection only when registry mode is absent', () => {
    expect(loadPreviewFixtureRegistry({})).toBeUndefined();
    expect(resolveCriticalPathTarget({}).safe).toBe(false);
    expect(
      resolveCriticalPathTarget({
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SECRET_KEY: 'local',
      }).safe,
    ).toBe(true);
    env.E2E_PREVIEW_FIXTURE_REGISTRY = '';
    rejected();
  });
  it.each([
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ACCESS_TOKEN',
    'VERCEL_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ])('rejects candidate authority %s before opening the file', (key) => {
    env[key] = 'must-not-leak';
    rejected();
  });
  it.each(['tilwaprottpyhlfoggbb', 'yvglwblxrnrenfifsnje'])(
    'rejects non-ephemeral DB %s',
    (value) => {
      env.E2E_SUPABASE_PROJECT_REF = value;
      env.NEXT_PUBLIC_SUPABASE_URL = `https://${value}.supabase.co`;
      registry.supabaseProjectRef = value;
      save();
      rejected();
    },
  );
  it.each([
    'E2E_PREVIEW_CLOUD_INTENT',
    'E2E_ALLOW_NONLOCAL_SUPABASE',
    'E2E_PREVIEW_RUN_ID',
    'E2E_PREVIEW_DB_MODE',
    'E2E_PREVIEW_DESKTOP_USER_ID',
    'E2E_PREVIEW_ORIGIN',
    'NEXT_PUBLIC_SUPABASE_URL',
  ])('rejects stale or missing binding %s', (key) => {
    delete env[key];
    rejected();
  });
  it('rejects a stale registry and a foreign mobile slot before returning either login', () => {
    registry.runId = '44444444-4444-4444-8444-444444444444';
    save();
    rejected();
    registry.runId = runId;
    registry.users.mobile!.userId = ids.desktop;
    save();
    rejected();
  });
  it('rejects unknown secret fields and malformed password without printing their values', () => {
    Object.assign(registry, { adminKey: 'must-not-leak' });
    save();
    rejected();
    registry = fixture();
    registry.users.desktop!.password = 'must-not-leak';
    save();
    rejected();
  });
  it('rejects public permissions and a shared credentials directory', () => {
    chmodSync(env.E2E_PREVIEW_FIXTURE_REGISTRY!, 0o644);
    rejected();
    chmodSync(env.E2E_PREVIEW_FIXTURE_REGISTRY!, 0o600);
    chmodSync(join(root, 'credentials'), 0o755);
    rejected();
  });
  it('rejects a symlink, oversized file, or malformed JSON using a fixed error', () => {
    const original = env.E2E_PREVIEW_FIXTURE_REGISTRY!;
    symlinkSync(original, join(root, 'credentials', 'link.json'));
    env.E2E_PREVIEW_FIXTURE_REGISTRY = join(root, 'credentials', 'link.json');
    rejected();
    env.E2E_PREVIEW_FIXTURE_REGISTRY = original;
    writeFileSync(original, 's'.repeat(16385));
    rejected();
    writeFileSync(original, 'must-not-leak');
    rejected();
  });
  it.each(['private', 'evidence'])(
    'refuses credentials in the %s output tree including directory aliases',
    (dir) => {
      env.E2E_PREVIEW_FIXTURE_REGISTRY = join(root, dir, 'login.json');
      save();
      rejected();
      const alias = join(root, 'alias');
      symlinkSync(join(root, dir), alias);
      env[dir === 'private' ? 'E2E_PREVIEW_PRIVATE_DIR' : 'E2E_PREVIEW_EVIDENCE_DIR'] = alias;
      rejected();
    },
  );
});
