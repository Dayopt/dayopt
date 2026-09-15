/**
 * 実装どうしの関係を集める（正規表現で高信頼に取れるものだけ）。
 *
 * 型チェッカーが要る経路（procedure → service → テーブル、画面 → procedure）はここでは扱わない。
 * ここで扱うのは、呼び出し名がそのまま file に現れる関係だけ:
 *   - MCP tool file → tRPC procedure
 *   - tRPC procedure → 呼び出し元（client / server prefetch / MCP）と、どこからも呼ばれない候補
 *   - store → 利用 file
 *   - docs の frontmatter `code:` → feature
 *   - E2E spec → route
 *   - integration test → DB 関数
 *   - feature ごとの test / Story 被覆
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path/posix';

import type { InventoryItem } from './inventory.ts';
import { featureOf } from './inventory.ts';
import type { SourceFile } from './references.ts';

export interface ProcedureUsage {
  id: string;
  /** 呼び出し元の分類ごとの file 数 */
  callers: { app: string[]; mcp: string[] };
}

export interface McpToolProcedures {
  /** tool file（1 file が複数 tool を登録することがある） */
  path: string;
  tools: string[];
  procedures: string[];
}

export interface StoreUsage {
  id: string;
  consumers: string[];
}

export interface DocCodeLink {
  doc: string;
  codePaths: string[];
  features: string[];
}

export interface E2eRouteLink {
  spec: string;
  routes: string[];
  unmatched: string[];
}

export interface DbFunctionTestLink {
  id: string;
  tests: string[];
}

export interface FeatureCoverage {
  feature: string;
  sourceFiles: number;
  testFiles: number;
  components: number;
  componentsWithStory: number;
}

export interface Relations {
  procedureUsage: ProcedureUsage[];
  unusedProcedures: string[];
  mcpToolProcedures: McpToolProcedures[];
  storeUsage: StoreUsage[];
  docCodeLinks: DocCodeLink[];
  e2eRoutes: E2eRouteLink[];
  dbFunctionTests: DbFunctionTestLink[];
  featureCoverage: FeatureCoverage[];
}

const PRODUCT_SRC = 'apps/product/src';
const MCP_REGISTRY_PATH = `${PRODUCT_SRC}/app/api/mcp/_tools/registry.ts`;
const E2E_DIR = `${PRODUCT_SRC}/lib/test/e2e`;
const INTEGRATION_DIR = `${PRODUCT_SRC}/lib/test/integration`;

function isTestOrStory(path: string): boolean {
  return /\.(test|spec|stories)\.tsx?$/.test(path);
}

function isRouterDefinition(path: string): boolean {
  return /\/server\/[\w-]*router[\w-]*\.ts$/.test(path) || path.endsWith('/server/router.ts');
}

// ─────────────────────────────────────────────────────────
// tRPC procedure の呼び出し元
// ─────────────────────────────────────────────────────────

/**
 * client / server / MCP から procedure がどう呼ばれているかを集める。
 *
 * 拾う形: `api.ns.proc.useQuery` `utils.ns.proc.invalidate` `helpers.ns.proc.prefetch`
 * `vanillaTrpc.ns.proc.mutate` `trpc.ns.proc(`（MCP bridge）。
 */
const CALL_RE = /\b(?:api|trpc|utils|helpers|vanillaTrpc|caller)\.([a-zA-Z]+)\.([a-zA-Z]+)\s*[.(]/g;

export function collectProcedureUsage(
  sources: SourceFile[],
  procedures: InventoryItem[],
): { usage: ProcedureUsage[]; unused: string[] } {
  const known = new Set(procedures.map((procedure) => procedure.id));
  const usage = new Map<string, { app: Set<string>; mcp: Set<string> }>();
  for (const id of known) usage.set(id, { app: new Set(), mcp: new Set() });

  for (const file of sources) {
    if (isTestOrStory(file.path) || isRouterDefinition(file.path)) continue;
    if (file.path.startsWith(`${PRODUCT_SRC}/lib/test/`)) continue;
    const bucket = file.path.startsWith(`${PRODUCT_SRC}/app/api/mcp/`) ? 'mcp' : 'app';
    for (const match of file.text.matchAll(CALL_RE)) {
      const id = `${match[1]}.${match[2]}`;
      const entry = usage.get(id);
      if (entry !== undefined) entry[bucket].add(file.path);
    }
  }

  const items = [...usage.entries()]
    .map(([id, entry]) => ({
      id,
      callers: { app: [...entry.app].sort(), mcp: [...entry.mcp].sort() },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    usage: items,
    unused: items
      .filter((item) => item.callers.app.length === 0 && item.callers.mcp.length === 0)
      .map((item) => item.id),
  };
}

// ─────────────────────────────────────────────────────────
// MCP tool → procedure
// ─────────────────────────────────────────────────────────

export function collectMcpToolProcedures(sources: SourceFile[]): McpToolProcedures[] {
  const registry = sources.find((file) => file.path === MCP_REGISTRY_PATH);
  if (registry === undefined) return [];

  const importOf = new Map<string, string>();
  for (const match of registry.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed.length > 0) importOf.set(trimmed, match[2]);
    }
  }

  const toolsByPath = new Map<string, Set<string>>();
  for (const match of registry.text.matchAll(
    /name:\s*'([a-z.]+)',[\s\S]{0,200}?register:\s*(\w+)/g,
  )) {
    const specifier = importOf.get(match[2]);
    if (specifier === undefined) continue;
    const path = `${PRODUCT_SRC}/app/api/mcp/_tools/${specifier.replace('./', '')}.ts`;
    let tools = toolsByPath.get(path);
    if (tools === undefined) {
      tools = new Set();
      toolsByPath.set(path, tools);
    }
    tools.add(match[1]);
  }

  const items: McpToolProcedures[] = [];
  for (const [path, tools] of toolsByPath) {
    const file = sources.find((candidate) => candidate.path === path);
    if (file === undefined) continue;
    const procedures = new Set<string>();
    for (const match of file.text.matchAll(/\btrpc\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g)) {
      procedures.add(`${match[1]}.${match[2]}`);
    }
    items.push({
      path,
      tools: [...tools].sort(),
      procedures: [...procedures].sort(),
    });
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

// ─────────────────────────────────────────────────────────
// store → 利用 file
// ─────────────────────────────────────────────────────────

export function collectStoreUsage(sources: SourceFile[], stores: InventoryItem[]): StoreUsage[] {
  return stores
    .map((store) => ({
      id: store.id,
      consumers: sources
        .filter(
          (file) =>
            file.path !== store.path &&
            !isTestOrStory(file.path) &&
            new RegExp(`\\b${store.id}\\b`).test(file.text),
        )
        .map((file) => file.path)
        .sort(),
    }))
    .sort((a, b) => b.consumers.length - a.consumers.length || a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────
// docs → feature
// ─────────────────────────────────────────────────────────

function listMarkdown(root: string, relativeDir: string): string[] {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full.slice(root.length + 1));
    }
  };
  walk(dir);
  return found;
}

/** frontmatter の `code:`（scalar / 配列）を読む。 */
export function parseFrontmatterCodePaths(text: string): string[] {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (frontmatter === undefined) return [];
  // `code:` の後ろが同じ行に続く scalar 形だけを拾う（`\s*` にすると配列形の 1 件目を食う）
  const scalar = frontmatter.match(/^code:[ \t]+(\S.*)$/m);
  if (scalar) return [scalar[1].trim()];
  const listStart = frontmatter.match(/^code:\s*$/m);
  if (!listStart) return [];
  const lines = frontmatter.slice(frontmatter.indexOf(listStart[0])).split('\n').slice(1);
  const paths: string[] = [];
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(\S.*)$/);
    if (!item) break;
    paths.push(item[1].trim());
  }
  return paths;
}

export function collectDocCodeLinks(root: string): DocCodeLink[] {
  const links: DocCodeLink[] = [];
  for (const doc of listMarkdown(root, 'docs')) {
    const codePaths = parseFrontmatterCodePaths(readFileSync(join(root, doc), 'utf8'));
    if (codePaths.length === 0) continue;
    const features = [
      ...new Set(
        codePaths
          .map((path) => path.match(/^apps\/product\/src\/features\/([a-z-]+)/)?.[1])
          .filter((feature): feature is string => feature !== undefined),
      ),
    ].sort();
    links.push({ doc, codePaths, features });
  }
  return links;
}

// ─────────────────────────────────────────────────────────
// E2E spec → route
// ─────────────────────────────────────────────────────────

/** `page.goto('/ja/calendar?view=day')` → `/calendar`。変数や外部 URL は取らない。 */
export function normalizeGotoUrl(raw: string): string | undefined {
  if (!raw.startsWith('/')) return undefined;
  const path = raw.split('?')[0].split('#')[0];
  const withoutLocale = path.replace(/^\/(ja|en)(?=\/|$)/, '');
  const normalized = withoutLocale.length === 0 ? '/' : withoutLocale;
  return normalized.includes('${') ? undefined : normalized;
}

/** route id（`/[locale]/(app)/calendar` は inventory 側で group 除去済み）を比較用に均す。 */
function routeMatcher(routeId: string): RegExp {
  const pattern = routeId
    .replace(/^\/\[locale\]/, '')
    .split('/')
    .map((segment) =>
      /^\[.+\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern === '' ? '/' : pattern}$`);
}

export function collectE2eRoutes(root: string, routes: InventoryItem[]): E2eRouteLink[] {
  const dir = join(root, E2E_DIR);
  if (!existsSync(dir)) return [];
  const matchers = routes.map((route) => ({ id: route.id, matcher: routeMatcher(route.id) }));
  const links: E2eRouteLink[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.spec.ts')) continue;
      const text = readFileSync(full, 'utf8');
      const matched = new Set<string>();
      const unmatched = new Set<string>();
      for (const match of text.matchAll(/page\.goto\(\s*[`'"]([^`'"]+)[`'"]/g)) {
        const url = normalizeGotoUrl(match[1]);
        if (url === undefined) continue;
        const route = matchers.find((candidate) => candidate.matcher.test(url));
        if (route) matched.add(route.id);
        else unmatched.add(url);
      }
      if (matched.size > 0 || unmatched.size > 0) {
        links.push({
          spec: full.slice(root.length + 1),
          routes: [...matched].sort(),
          unmatched: [...unmatched].sort(),
        });
      }
    }
  };
  walk(dir);
  return links;
}

// ─────────────────────────────────────────────────────────
// integration test → DB 関数
// ─────────────────────────────────────────────────────────

export function collectDbFunctionTests(
  root: string,
  sources: SourceFile[],
  dbFunctions: InventoryItem[],
): DbFunctionTestLink[] {
  const names = new Set(dbFunctions.map((fn) => fn.id));
  const tests = new Map<string, Set<string>>();
  const add = (name: string, path: string): void => {
    if (!names.has(name)) return;
    let set = tests.get(name);
    if (set === undefined) {
      set = new Set();
      tests.set(name, set);
    }
    set.add(path);
  };

  for (const file of sources) {
    if (!file.path.startsWith(INTEGRATION_DIR)) continue;
    for (const match of file.text.matchAll(/\.rpc(?:<[^>]*>)?\(\s*'([a-z_0-9]+)'/g)) {
      add(match[1], file.path);
    }
  }

  const sqlDir = join(root, 'supabase/tests');
  if (existsSync(sqlDir)) {
    for (const entry of readdirSync(sqlDir).sort()) {
      if (!entry.endsWith('.sql')) continue;
      const text = readFileSync(join(sqlDir, entry), 'utf8');
      for (const match of text.matchAll(/\b(?:public\.)?([a-z_][a-z_0-9]*)\s*\(/g)) {
        add(match[1], `supabase/tests/${entry}`);
      }
    }
  }

  return [...tests.entries()]
    .map(([id, paths]) => ({ id, tests: [...paths].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────
// feature ごとの被覆
// ─────────────────────────────────────────────────────────

export function collectFeatureCoverage(sources: SourceFile[]): FeatureCoverage[] {
  const features = new Map<string, FeatureCoverage>();
  const storyPaths = new Set(
    sources.filter((file) => file.path.endsWith('.stories.tsx')).map((file) => file.path),
  );

  for (const file of sources) {
    const feature = featureOf(file.path);
    if (feature === undefined) continue;
    let coverage = features.get(feature);
    if (coverage === undefined) {
      coverage = {
        feature,
        sourceFiles: 0,
        testFiles: 0,
        components: 0,
        componentsWithStory: 0,
      };
      features.set(feature, coverage);
    }
    if (/\.test\.tsx?$/.test(file.path)) {
      coverage.testFiles += 1;
      continue;
    }
    if (isTestOrStory(file.path)) continue;
    coverage.sourceFiles += 1;
    if (/\/components\/.*\.tsx$/.test(file.path)) {
      coverage.components += 1;
      if (storyPaths.has(file.path.replace(/\.tsx$/, '.stories.tsx'))) {
        coverage.componentsWithStory += 1;
      }
    }
  }

  return [...features.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

export function collectRelations(
  root: string,
  sources: SourceFile[],
  items: InventoryItem[],
): Relations {
  const ofKind = (kind: InventoryItem['kind']): InventoryItem[] =>
    items.filter((item) => item.kind === kind);
  const { usage, unused } = collectProcedureUsage(sources, ofKind('trpc-procedure'));

  return {
    procedureUsage: usage,
    unusedProcedures: unused,
    mcpToolProcedures: collectMcpToolProcedures(sources),
    storeUsage: collectStoreUsage(sources, ofKind('store')),
    docCodeLinks: collectDocCodeLinks(root),
    e2eRoutes: collectE2eRoutes(root, ofKind('route')),
    dbFunctionTests: collectDbFunctionTests(root, sources, ofKind('db-function')),
    featureCoverage: collectFeatureCoverage(sources),
  };
}
