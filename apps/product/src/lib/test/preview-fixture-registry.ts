import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { validatePreviewOrigin } from './preview-access';
import { resolvePreviewCloudUserId } from './preview-cloud-identity';
import { resolveServiceRoleTarget } from './service-role-target-guard';

type Environment = Readonly<Record<string, string | undefined>>;
interface PreviewFixtureIdentity {
  userId: string;
  email: string;
  password: string;
  activityName: string;
  categoryName: string;
}
interface PreviewFixtureRegistry {
  schemaVersion: 1;
  operation: 'provision';
  runId: string;
  origin: string;
  supabaseProjectRef: string;
  users: { desktop: PreviewFixtureIdentity; mobile: PreviewFixtureIdentity };
}

const FORBIDDEN = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'VERCEL_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];
const PRODUCTION_REF = 'yvglwblxrnrenfifsnje';
const SHARED_REF = 'tilwaprottpyhlfoggbb';

function invalid(): never {
  throw new Error('Preview fixture registry is invalid');
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
}
function inside(path: string, parent: string) {
  const part = relative(parent, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}

/** Node-only private login input. Never accepts an admin key or creates/deletes users. */
export function loadPreviewFixtureRegistry(
  env: Environment = process.env,
): PreviewFixtureRegistry | undefined {
  const path = env.E2E_PREVIEW_FIXTURE_REGISTRY;
  if (path === undefined) return undefined;
  let fd: number | undefined;
  try {
    if (!path || !isAbsolute(path) || FORBIDDEN.some((key) => env[key] !== undefined)) invalid();
    const ref = env.E2E_SUPABASE_PROJECT_REF;
    if (
      env.E2E_PREVIEW_DB_MODE !== 'ephemeral' ||
      env.E2E_ALLOW_NONLOCAL_SUPABASE !== '1' ||
      env.E2E_PREVIEW_CLOUD_INTENT !== '1' ||
      !ref ||
      !/^[a-z]{20}$/.test(ref) ||
      ref === PRODUCTION_REF ||
      ref === SHARED_REF ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${ref}.supabase.co`
    )
      invalid();
    const origin = validatePreviewOrigin(env.E2E_PREVIEW_ORIGIN);
    const canonical = realpathSync(path);
    // macOS /var can itself be an OS symlink. Resolve the parent but never a file symlink.
    if (canonical !== resolve(realpathSync(dirname(path)), basename(path))) invalid();
    if ((statSync(dirname(canonical)).mode & 0o077) !== 0) invalid();
    // Playwright clears outputDir. Keep credentials outside both private test output
    // and the publicly uploaded evidence directory.
    for (const key of ['E2E_PREVIEW_PRIVATE_DIR', 'E2E_PREVIEW_EVIDENCE_DIR']) {
      if (!env[key] || inside(canonical, realpathSync(env[key]))) invalid();
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384 || stat.size === 0)
      invalid();
    const registry: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    exact(registry, [
      'schemaVersion',
      'operation',
      'runId',
      'origin',
      'supabaseProjectRef',
      'users',
    ]);
    if (
      registry.schemaVersion !== 1 ||
      registry.operation !== 'provision' ||
      registry.runId !== env.E2E_PREVIEW_RUN_ID ||
      registry.origin !== origin ||
      registry.supabaseProjectRef !== ref
    )
      invalid();
    exact(registry.users, ['desktop', 'mobile']);
    for (const [slot, prefix] of [
      ['desktop', 'critical-path'],
      ['mobile', 'mobile-critical-path'],
    ] as const) {
      const user = registry.users[slot];
      exact(user, ['userId', 'email', 'password', 'activityName', 'categoryName']);
      const id = resolvePreviewCloudUserId(prefix, env);
      if (
        !id ||
        user.userId !== id ||
        user.email !== `${prefix}-${id}@example.com` ||
        user.activityName !== `Journey ${id.slice(0, 8)}` ||
        user.categoryName !== `Cat ${id.slice(0, 8)}` ||
        typeof user.password !== 'string' ||
        !/^E2e![A-Za-z0-9_-]{43}$/.test(user.password)
      )
        invalid();
    }
    return registry as unknown as PreviewFixtureRegistry;
  } catch {
    return invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveCriticalPathTarget(env: Environment = process.env) {
  if (loadPreviewFixtureRegistry(env)) return { safe: true } as const;
  return resolveServiceRoleTarget(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    ...env,
    NODE_ENV: 'test',
  });
}
