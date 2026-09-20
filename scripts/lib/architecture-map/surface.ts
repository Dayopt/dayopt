/**
 * System Surface — 実装から「外部との接点・権限・設定」を自動発見する。
 *
 * Inventory（`inventory.ts`）が概念に紐づく実装を扱うのに対し、ここは概念を持たない
 * 運用面の事実を集める。どれも正本はコードで、この module は読み手にすぎない。
 *
 * 発見元:
 *   - HTTP route      apps/{product,web}/src/app/**\/route.ts の method export
 *   - 定期実行        apps/product/vercel.json / .github/workflows/*.yml / migrations の cron.schedule
 *   - Supabase        supabase/config.toml の [functions.*] / [auth.hook.*] / [storage.buckets.*]
 *   - DB エラーコード  migrations の `USING ERRCODE = 'DTnnn'` と app 側の参照
 *   - OAuth scope     lib/oauth-server/scopes.ts + MCP registry + procedures.ts の scope 要求表
 *   - rate limit      lib/rate-limit/upstash.ts の createRateLimiter
 *   - 分析イベント     lib/analytics/product-events.ts（SQL の CHECK 制約と突き合わせる）
 *   - env 変数        scripts/tasks/env/schema.ts（名前と所在だけ。値は読まない）
 *   - package         packages/*\/package.json の name / exports
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path/posix';

import { onePasswordEnvSchema } from '../../tasks/env/schema.ts';
import type { SourceFile } from './references.ts';

export interface HttpRoute {
  /** URL path（route group を除いたもの） */
  id: string;
  app: 'product' | 'web';
  methods: string[];
  path: string;
  runtime?: string;
  maxDuration?: string;
}

export interface ScheduledJob {
  id: string;
  source: 'vercel' | 'github-actions' | 'pg_cron';
  schedule: string;
  target: string;
  path: string;
  /** repo が production の正本かどうか（pg_cron は Dashboard 側が正） */
  authoritative: boolean;
}

export interface SupabaseFeature {
  kind: 'edge-function' | 'auth-hook' | 'storage-bucket';
  id: string;
  detail?: string;
}

export interface DbErrorCode {
  code: string;
  /** migration が RAISE する時の message（重複排除） */
  messages: string[];
  raisedIn: number;
  referencedIn: string[];
}

export interface OAuthScopeItem {
  scope: string;
  mcpTools: string[];
  trpcPaths: string[];
}

export interface RateLimitItem {
  id: string;
  limit: number;
  window: string;
  usedIn: string[];
}

export interface ProcedureBuilderItem {
  id: string;
  path: string;
}

export interface AnalyticsEventItem {
  id: string;
  /** DB の CHECK 制約でも許可されているか */
  allowedInDb: boolean;
}

export interface EnvVarItem {
  id: string;
  required: boolean;
  visibility: string;
  environments: string[];
  /** 1Password の item 名（vault / field は読まない） */
  items: string[];
  inProductEnvSchema: boolean;
}

export interface WorkspacePackageItem {
  id: string;
  path: string;
  exports: string[];
  dependents: string[];
}

export interface SystemSurface {
  httpRoutes: HttpRoute[];
  schedules: ScheduledJob[];
  supabase: SupabaseFeature[];
  errorCodes: DbErrorCode[];
  scopes: OAuthScopeItem[];
  rateLimits: RateLimitItem[];
  procedureBuilders: ProcedureBuilderItem[];
  analyticsEvents: AnalyticsEventItem[];
  envVars: EnvVarItem[];
  packages: WorkspacePackageItem[];
}

const MIGRATIONS_DIR = 'supabase/migrations';
const PRODUCT_SRC = 'apps/product/src';

function readIfExists(root: string, path: string): string | undefined {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

function listMigrations(root: string): Array<{ path: string; text: string }> {
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => ({
      path: `${MIGRATIONS_DIR}/${entry}`,
      text: readFileSync(join(dir, entry), 'utf8'),
    }));
}

// ─────────────────────────────────────────────────────────
// HTTP route
// ─────────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/** route.ts から公開 method を取り出す。`export { handler as GET }` の再 export 形も拾う。 */
export function parseRouteMethods(text: string): string[] {
  const methods = new Set<string>();
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Z]+)\b/g)) {
    if (HTTP_METHODS.includes(match[1])) methods.add(match[1]);
  }
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.includes(' as ') ? part.split(' as ')[1] : part;
      const trimmed = name.trim();
      if (HTTP_METHODS.includes(trimmed)) methods.add(trimmed);
    }
  }
  return HTTP_METHODS.filter((method) => methods.has(method));
}

/** app router の file path から URL を作る（route group を除去する）。 */
export function routeUrlOf(relativePath: string): string {
  const segments = relativePath
    .replace(/^apps\/(product|web)\/src\/app\/?/, '')
    .replace(/\/(route|page)\.tsx?$/, '')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.+\)$/.test(segment));
  return `/${segments.join('/')}`;
}

function walkFiles(root: string, relativeDir: string, fileName: string): string[] {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  // `.well-known/` のように dot で始まる route ディレクトリが実在するため、
  // 除外は build 生成物と node_modules だけに絞る（#2775 で .well-known 2 route を落としていた）
  const skipped = new Set(['node_modules', '.next', '.turbo', '.git', '.vercel']);
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (skipped.has(entry)) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === fileName) found.push(full.slice(root.length + 1));
    }
  };
  walk(dir);
  return found.sort();
}

export function discoverHttpRoutes(root: string): HttpRoute[] {
  const routes: HttpRoute[] = [];
  for (const app of ['product', 'web'] as const) {
    for (const path of walkFiles(root, `apps/${app}/src/app`, 'route.ts')) {
      const text = readFileSync(join(root, path), 'utf8');
      routes.push({
        id: routeUrlOf(path),
        app,
        methods: parseRouteMethods(text),
        path,
        runtime: text.match(/export const runtime\s*=\s*'([^']+)'/)?.[1],
        maxDuration: text.match(/export const maxDuration\s*=\s*(\d+)/)?.[1],
      });
    }
  }
  return routes.sort((a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────
// 定期実行
// ─────────────────────────────────────────────────────────

/** pg_cron は schedule / unschedule を migration 順に畳んで現在の定義を出す。 */
export function foldPgCronJobs(
  migrations: Array<{ path: string; text: string }>,
): Map<string, { schedule: string; path: string }> {
  const jobs = new Map<string, { schedule: string; path: string }>();
  for (const migration of migrations) {
    if (migration.path.includes('/_archive/')) continue;
    for (const match of migration.text.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      jobs.set(match[1], { schedule: match[2], path: migration.path });
    }
    for (const match of migration.text.matchAll(/cron\.unschedule\(\s*'([^']+)'/g)) {
      jobs.delete(match[1]);
    }
  }
  return jobs;
}

/** workflow YAML の `on.schedule` から cron を取り出す（`- cron: '...'` の行だけを見る）。 */
export function parseWorkflowSchedules(text: string): string[] {
  const schedules: string[] = [];
  let inSchedule = false;
  for (const line of text.split('\n')) {
    if (/^\s{0,4}schedule:\s*$/.test(line)) {
      inSchedule = true;
      continue;
    }
    if (inSchedule) {
      const cron = line.match(/^\s*-\s*cron:\s*'([^']+)'/);
      if (cron) {
        schedules.push(cron[1]);
        continue;
      }
      if (/^\s*#/.test(line) || line.trim() === '') continue;
      inSchedule = false;
    }
  }
  return schedules;
}

export function discoverSchedules(root: string): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];

  const vercelPath = 'apps/product/vercel.json';
  const vercel = readIfExists(root, vercelPath);
  if (vercel !== undefined) {
    const config = JSON.parse(vercel) as { crons?: Array<{ path: string; schedule: string }> };
    for (const cron of config.crons ?? []) {
      jobs.push({
        id: cron.path,
        source: 'vercel',
        schedule: cron.schedule,
        target: cron.path,
        path: vercelPath,
        authoritative: true,
      });
    }
  }

  const workflowsDir = join(root, '.github/workflows');
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir).sort()) {
      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
      const path = `.github/workflows/${entry}`;
      for (const schedule of parseWorkflowSchedules(
        readFileSync(join(workflowsDir, entry), 'utf8'),
      )) {
        jobs.push({
          id: `${entry} (${schedule})`,
          source: 'github-actions',
          schedule,
          target: entry,
          path,
          authoritative: true,
        });
      }
    }
  }

  for (const [name, job] of foldPgCronJobs(listMigrations(root))) {
    jobs.push({
      id: name,
      source: 'pg_cron',
      schedule: job.schedule,
      target: name,
      path: job.path,
      // production の pg_cron は Supabase Dashboard 側が正本。migration の定義は参考値
      authoritative: false,
    });
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────
// Supabase（Edge Function / auth hook / storage bucket）
// ─────────────────────────────────────────────────────────

export function parseSupabaseConfig(text: string): SupabaseFeature[] {
  const features: SupabaseFeature[] = [];
  const sections = text.split(/^\[/m);
  for (const section of sections) {
    const header = section.split('\n')[0];
    const enabled = /^\s*enabled\s*=\s*true/m.test(section) ? 'enabled' : 'disabled';
    const fn = header.match(/^functions\.([a-z0-9-]+)\]/);
    if (fn) features.push({ kind: 'edge-function', id: fn[1] });
    const hook = header.match(/^auth\.hook\.([a-z_]+)\]/);
    if (hook) features.push({ kind: 'auth-hook', id: hook[1], detail: enabled });
    const bucket = header.match(/^storage\.buckets\.([a-z0-9_-]+)\]/);
    if (bucket) features.push({ kind: 'storage-bucket', id: bucket[1] });
  }
  return features;
}

// ─────────────────────────────────────────────────────────
// DB エラーコード
// ─────────────────────────────────────────────────────────

export function discoverErrorCodes(root: string, sources: SourceFile[]): DbErrorCode[] {
  const byCode = new Map<string, { messages: Set<string>; files: Set<string> }>();
  const entry = (code: string) => {
    let value = byCode.get(code);
    if (value === undefined) {
      value = { messages: new Set(), files: new Set() };
      byCode.set(code, value);
    }
    return value;
  };

  for (const migration of listMigrations(root)) {
    if (migration.path.includes('/_archive/')) continue;
    for (const match of migration.text.matchAll(
      /RAISE\s+EXCEPTION\s+'([^']*)'[^;]*?ERRCODE\s*=\s*'(DT\d{3})'/gis,
    )) {
      const value = entry(match[2]);
      value.messages.add(match[1].trim());
      value.files.add(migration.path);
    }
  }

  const referenced = new Map<string, Set<string>>();
  for (const file of sources) {
    if (/\.(test|stories)\.tsx?$/.test(file.path)) continue;
    for (const match of file.text.matchAll(/['"`](DT\d{3})['"`]/g)) {
      let files = referenced.get(match[1]);
      if (files === undefined) {
        files = new Set();
        referenced.set(match[1], files);
      }
      files.add(file.path);
    }
  }

  const codes = new Set([...byCode.keys(), ...referenced.keys()]);
  return [...codes].sort().map((code) => {
    const raised = byCode.get(code);
    return {
      code,
      messages: [...(raised?.messages ?? [])].sort(),
      raisedIn: raised?.files.size ?? 0,
      referencedIn: [...(referenced.get(code) ?? [])].sort(),
    };
  });
}

// ─────────────────────────────────────────────────────────
// 権限と上限
// ─────────────────────────────────────────────────────────

export function parseSupportedScopes(text: string): string[] {
  const block = text.match(/SUPPORTED_SCOPES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/'([a-z:]+)'/g)].map((match) => match[1]);
}

export function parseMcpTrpcScopeRequirements(text: string): Map<string, string> {
  const block = text.match(/MCP_TRPC_SCOPE_REQUIREMENTS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const map = new Map<string, string>();
  for (const match of block.matchAll(/'([A-Za-z.]+)':\s*'([a-z:]+)'/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

export function parseRateLimits(
  text: string,
): Array<{ id: string; limit: number; window: string }> {
  const limits: Array<{ id: string; limit: number; window: string }> = [];
  for (const match of text.matchAll(
    /export const (\w+) = createRateLimiter\(\s*Ratelimit\.\w+\(\s*([\d_]+),\s*'([^']+)'/g,
  )) {
    limits.push({
      id: match[1],
      limit: Number.parseInt(match[2].replace(/_/g, ''), 10),
      window: match[3],
    });
  }
  return limits;
}

export function parseProcedureBuilders(text: string): string[] {
  return [...text.matchAll(/export (?:const|function) (\w+Procedure)\b/g)].map((match) => match[1]);
}

// ─────────────────────────────────────────────────────────
// 分析イベント / env / package
// ─────────────────────────────────────────────────────────

export function parseAnalyticsEventNames(text: string): string[] {
  const block = text.match(/PRODUCT_EVENT_NAMES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

/** product_events の CHECK 制約が許可するイベント名（最後に定義した migration が現在の値）。 */
export function parseAnalyticsEventCheck(
  migrations: Array<{ path: string; text: string }>,
): string[] | undefined {
  let latest: string[] | undefined;
  for (const migration of migrations) {
    if (migration.path.includes('/_archive/')) continue;
    const match = migration.text.match(
      /product_events_event_name_check\s+CHECK\s*\(\s*\n?\s*event_name IN \(([\s\S]*?)\)/,
    );
    if (match) latest = [...match[1].matchAll(/'([a-z_]+)'/g)].map((event) => event[1]);
  }
  return latest;
}

export function discoverAnalyticsEvents(root: string, sources: SourceFile[]): AnalyticsEventItem[] {
  const file = sources.find(
    (candidate) => candidate.path === `${PRODUCT_SRC}/lib/analytics/product-events.ts`,
  );
  if (file === undefined) return [];
  const allowed = new Set(parseAnalyticsEventCheck(listMigrations(root)) ?? []);
  return parseAnalyticsEventNames(file.text).map((id) => ({ id, allowedInDb: allowed.has(id) }));
}

export function discoverPackages(root: string): WorkspacePackageItem[] {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  const manifests: Array<{ dir: string; name: string; exports: string[] }> = [];
  for (const entry of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      exports?: string | Record<string, unknown>;
    };
    if (manifest.name === undefined) continue;
    const exports =
      typeof manifest.exports === 'string' ? ['.'] : Object.keys(manifest.exports ?? {}).sort();
    manifests.push({ dir: `packages/${entry}`, name: manifest.name, exports });
  }

  const dependentsOf = new Map<string, Set<string>>();
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const manifestPath = join(groupDir, entry, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const dependency of Object.keys(all)) {
        if (!dependency.startsWith('@dayopt/')) continue;
        let set = dependentsOf.get(dependency);
        if (set === undefined) {
          set = new Set();
          dependentsOf.set(dependency, set);
        }
        set.add(manifest.name ?? `${group}/${entry}`);
      }
    }
  }

  return manifests.map((manifest) => ({
    id: manifest.name,
    path: manifest.dir,
    exports: manifest.exports,
    dependents: [...(dependentsOf.get(manifest.name) ?? [])].sort(),
  }));
}

// ─────────────────────────────────────────────────────────
// 全体
// ─────────────────────────────────────────────────────────

export function discoverSystemSurface(
  root: string,
  sources: SourceFile[],
  mcpTools: Array<{ id: string; detail?: string }>,
): SystemSurface {
  const read = (path: string): string => readIfExists(root, path) ?? '';

  const scopeNames = parseSupportedScopes(read(`${PRODUCT_SRC}/lib/oauth-server/scopes.ts`));
  const trpcScopes = parseMcpTrpcScopeRequirements(read(`${PRODUCT_SRC}/lib/trpc/procedures.ts`));
  const scopes: OAuthScopeItem[] = scopeNames.map((scope) => ({
    scope,
    mcpTools: mcpTools.filter((tool) => tool.detail === scope).map((tool) => tool.id),
    trpcPaths: [...trpcScopes].filter(([, value]) => value === scope).map(([path]) => path),
  }));

  const rateLimitText = read(`${PRODUCT_SRC}/lib/rate-limit/upstash.ts`);
  const rateLimits: RateLimitItem[] = parseRateLimits(rateLimitText).map((limit) => ({
    ...limit,
    usedIn: sources
      .filter(
        (file) =>
          !/\.(test|stories)\.tsx?$/.test(file.path) &&
          !file.path.endsWith('lib/rate-limit/upstash.ts') &&
          new RegExp(`\\b${limit.id}\\b`).test(file.text),
      )
      .map((file) => file.path)
      .sort(),
  }));

  const envSchema = loadEnvSchema(root);

  return {
    httpRoutes: discoverHttpRoutes(root),
    schedules: discoverSchedules(root),
    supabase: parseSupabaseConfig(read('supabase/config.toml')),
    errorCodes: discoverErrorCodes(root, sources),
    scopes,
    rateLimits,
    procedureBuilders: parseProcedureBuilders(read(`${PRODUCT_SRC}/lib/trpc/procedures.ts`)).map(
      (id) => ({ id, path: `${PRODUCT_SRC}/lib/trpc/procedures.ts` }),
    ),
    analyticsEvents: discoverAnalyticsEvents(root, sources),
    envVars: envSchema,
    packages: discoverPackages(root),
  };
}

/**
 * env 変数の名前と所在だけを読む（値は読まない。`docs/operations/secrets.md` の境界）。
 * 正本の配列をそのまま import する（文字列 parse だと `.map` で組み立てる entry を落とす）。
 */
function loadEnvSchema(root: string): EnvVarItem[] {
  const productEnv = readIfExists(root, `${PRODUCT_SRC}/env.ts`) ?? '';
  const productKeys = new Set(
    [...productEnv.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*z\./gm)].map((match) => match[1]),
  );

  const merged = new Map<string, EnvVarItem>();
  for (const entry of onePasswordEnvSchema) {
    const existing = merged.get(entry.envName);
    if (existing === undefined) {
      merged.set(entry.envName, {
        id: entry.envName,
        required: entry.required,
        visibility: entry.visibility,
        environments: [entry.environment],
        items: [entry.item],
        inProductEnvSchema: productKeys.has(entry.envName),
      });
      continue;
    }
    existing.required = existing.required || entry.required;
    if (!existing.environments.includes(entry.environment)) {
      existing.environments.push(entry.environment);
    }
    if (!existing.items.includes(entry.item)) existing.items.push(entry.item);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}
