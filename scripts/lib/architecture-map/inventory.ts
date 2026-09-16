/**
 * Architecture Inventory — 実装から「何があるか」を自動発見する。
 *
 * ここは事実だけを集める層で、意味（どの概念に属するか）は付けない。意味付けは
 * `concept-map.ts` が用語集（`scripts/lib/glossary/terms.ts`）を使って行う。
 *
 * 発見する種別と発見元:
 *   - feature          apps/product/src/features/<f>/
 *   - trpc-router      app-router.ts の createTRPCRouter({ namespace: xRouter })
 *   - trpc-procedure   createTRPCRouter({ name: protectedProcedure... }) を持つ file
 *   - mcp-tool         app/api/mcp/_tools/registry.ts の MCP_TOOL_DESCRIPTORS
 *   - table / db-function   database.types.ts（schema model）。関数は .rpc('name') の呼び元も持つ
 *   - store            <dir>/stores/use*Store.ts
 *   - story            *.stories.tsx の meta title
 *   - route            app/ 配下の page.tsx（route group を除いた path）
 *   - i18n-namespace   apps/product/messages/en/*.json
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path/posix';

import ts from 'typescript';

import type { SourceFile } from './references.ts';
import type { SchemaModel } from './schema-model.ts';

export type InventoryKind =
  | 'feature'
  | 'trpc-router'
  | 'trpc-procedure'
  | 'mcp-tool'
  | 'table'
  | 'db-function'
  | 'store'
  | 'story'
  | 'route'
  | 'i18n-namespace';

export const INVENTORY_KINDS: readonly InventoryKind[] = [
  'feature',
  'table',
  'db-function',
  'trpc-router',
  'trpc-procedure',
  'mcp-tool',
  'store',
  'story',
  'route',
  'i18n-namespace',
];

export const INVENTORY_KIND_LABELS: Record<InventoryKind, string> = {
  feature: 'feature',
  table: 'DB テーブル',
  'db-function': 'DB 関数',
  'trpc-router': 'tRPC router',
  'trpc-procedure': 'tRPC procedure',
  'mcp-tool': 'MCP tool',
  store: 'Zustand store',
  story: 'Story',
  route: 'route',
  'i18n-namespace': 'i18n namespace',
};

export interface InventoryItem {
  kind: InventoryKind;
  id: string;
  /** repo-relative path（発見元） */
  path: string;
  /** 所属 feature（path から決まる場合） */
  feature?: string;
  /** 利用元 feature（DB 関数など、複数 feature から使われるもの） */
  usedBy?: string[];
  detail?: string;
}

const PRODUCT_SRC = 'apps/product/src';
const APP_ROUTER_PATH = `${PRODUCT_SRC}/app/api/trpc/_server/app-router.ts`;
const MCP_REGISTRY_PATH = `${PRODUCT_SRC}/app/api/mcp/_tools/registry.ts`;
const MESSAGES_DIR = 'apps/product/messages/en';

export function featureOf(path: string): string | undefined {
  return path.match(/^apps\/product\/src\/features\/([a-z-]+)\//)?.[1];
}

function isRuntimeSource(file: SourceFile): boolean {
  return !/\.(test|stories)\.tsx?$/.test(file.path);
}

function specifierToPath(specifier: string): string | undefined {
  if (!specifier.startsWith('@/')) return undefined;
  return `${PRODUCT_SRC}/${specifier.slice(2)}.ts`;
}

/** app-router.ts の createTRPCRouter({ ns: xRouter }) から namespace → router file を引く。 */
export function discoverTrpcRouters(appRouter: SourceFile): InventoryItem[] {
  const sourceFile = ts.createSourceFile(
    'app-router.ts',
    appRouter.text,
    ts.ScriptTarget.Latest,
    true,
  );
  const importOf = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        importOf.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  // `const userRouter = createUserRouter({...})` のように local で組み立てる router は
  // factory の import 元を router file とみなす
  const factoryOf = new Map<string, string>();
  for (const match of appRouter.text.matchAll(/const\s+([A-Za-z]+)\s*=\s*([A-Za-z]+)\(/g)) {
    factoryOf.set(match[1], match[2]);
  }

  const items: InventoryItem[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createTRPCRouter' &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const member of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
        if (!ts.isIdentifier(member.initializer)) continue;
        const identifier = member.initializer.text;
        const specifier =
          importOf.get(identifier) ?? importOf.get(factoryOf.get(identifier) ?? '') ?? '';
        const path = specifierToPath(specifier) ?? appRouter.path;
        items.push({
          kind: 'trpc-router',
          id: member.name.text,
          path,
          feature: featureOf(path),
          detail: identifier,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return items;
}

/** 呼び出し / property chain の根にある識別子を返す（`protectedProcedure.meta().query()` → `protectedProcedure`）。 */
function rootIdentifier(node: ts.Expression): string | undefined {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

/**
 * router file の namespace を解決する。
 *
 * app-router が直接 import する file は namespace が確定している。`statistics.ts` のように
 * `mergeRouters` で束ねる中間 file があるため、そこから router 系の import を辿って同じ
 * namespace を伝播させる（辿る先は `createTRPCRouter` / `mergeRouters` を含む file だけ）。
 */
export function resolveRouterNamespaces(
  sources: SourceFile[],
  routers: InventoryItem[],
): Map<string, string> {
  const byPath = new Map(sources.map((file) => [file.path, file]));
  const namespaceOfPath = new Map<string, string>();
  const queue: Array<{ path: string; namespace: string }> = [];
  for (const router of routers) {
    if (namespaceOfPath.has(router.path)) continue;
    namespaceOfPath.set(router.path, router.id);
    queue.push({ path: router.path, namespace: router.id });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const file = byPath.get(current.path);
    if (file === undefined) continue;
    for (const match of file.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImportPath(match[1], current.path, byPath);
      if (target === undefined || namespaceOfPath.has(target)) continue;
      const imported = byPath.get(target);
      if (imported === undefined) continue;
      if (
        !imported.text.includes('createTRPCRouter(') &&
        !imported.text.includes('mergeRouters(')
      ) {
        continue;
      }
      namespaceOfPath.set(target, current.namespace);
      queue.push({ path: target, namespace: current.namespace });
    }
  }
  return namespaceOfPath;
}

function resolveImportPath(
  specifier: string,
  fromPath: string,
  byPath: Map<string, SourceFile>,
): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = `${PRODUCT_SRC}/${specifier.slice(2)}`;
  } else if (specifier.startsWith('.')) {
    const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
    base = join(dir, specifier).replace(/\\/g, '/');
  } else {
    return undefined;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (byPath.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * router file の `createTRPCRouter({...})` から procedure を取り出す。
 *
 * 正規表現ではなく AST を使う（`createUserRouter` のように関数の中で組み立てる router は
 * インデントが 2 space ではなく、行頭一致だと丸ごと落ちる。#2775 で `user.*` 6 件を実際に落としていた）。
 */
export function discoverTrpcProcedures(
  sources: SourceFile[],
  routers: InventoryItem[],
): InventoryItem[] {
  const namespaceOfPath = resolveRouterNamespaces(sources, routers);
  const items: InventoryItem[] = [];

  for (const file of sources) {
    if (!isRuntimeSource(file) || !file.text.includes('createTRPCRouter(')) continue;
    const routerName =
      namespaceOfPath.get(file.path) ?? file.path.replace(/^.*\//, '').replace(/\.tsx?$/, '');
    const sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);

    // `const x = protectedProcedure...` を経由して登録される procedure（statistics-kpi-router）
    const builderOfConst = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const root = rootIdentifier(declaration.initializer);
        if (root?.endsWith('Procedure') === true) builderOfConst.set(declaration.name.text, root);
      }
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createTRPCRouter' &&
        node.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const member of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) continue;
          const root = rootIdentifier(member.initializer);
          if (root === undefined) continue;
          const builder = root.endsWith('Procedure') ? root : builderOfConst.get(root);
          if (builder === undefined) continue;
          items.push({
            kind: 'trpc-procedure',
            id: `${routerName}.${member.name.text}`,
            path: file.path,
            feature: featureOf(file.path),
            detail: builder,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return items;
}

export function discoverMcpTools(registry: SourceFile): InventoryItem[] {
  const items: InventoryItem[] = [];
  for (const match of registry.text.matchAll(
    /name:\s*'([a-z.]+)',\s*requiredScope:\s*'([a-z:_]+)'/g,
  )) {
    items.push({ kind: 'mcp-tool', id: match[1], path: registry.path, detail: match[2] });
  }
  if (items.length === 0) {
    throw new Error(`${registry.path} から MCP tool を 1 つも取り出せませんでした`);
  }
  return items;
}

/** `.rpc('name')` と `.rpc(CONST)`（同 file の `const CONST = 'name'`）の両方を拾う。 */
const RPC_RE = /\.rpc(?:<[^>]*>)?\(\s*(?:'([a-z_0-9]+)'|([A-Z][A-Z0-9_]*))/g;
/** `.from('table')` と `.from(databaseTables.alias)`。table 名は schema の実在テーブルで絞る。 */
const FROM_RE = /\.from\(\s*(?:'([a-z_]+)'|databaseTables\.([A-Za-z]+))/g;

function ownerOf(path: string): string | undefined {
  return featureOf(path) ?? path.match(/^apps\/product\/src\/([a-z]+)\//)?.[1];
}

function addUser(users: Map<string, Set<string>>, key: string, owner: string): void {
  let set = users.get(key);
  if (set === undefined) {
    set = new Set();
    users.set(key, set);
  }
  set.add(owner);
}

/** 同 file の `const NAME = 'value'` を解決する（`.rpc(CLAIM_STEP_RPC)` 形式のため）。 */
function stringConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z_0-9]+)'/g)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

/** DB 関数 / テーブルごとに「どの feature（または lib / app）から触られているか」を集める。 */
export function collectDatabaseUsers(
  sources: SourceFile[],
  tableAliases: Map<string, string>,
  tableNames: Set<string>,
): { rpc: Map<string, Set<string>>; table: Map<string, Set<string>> } {
  const rpc = new Map<string, Set<string>>();
  const table = new Map<string, Set<string>>();
  for (const file of sources) {
    if (!isRuntimeSource(file)) continue;
    const owner = ownerOf(file.path);
    if (owner === undefined) continue;
    const constants = stringConstants(file.text);
    for (const match of file.text.matchAll(RPC_RE)) {
      const name = match[1] ?? constants.get(match[2] ?? '');
      if (name !== undefined) addUser(rpc, name, owner);
    }
    for (const match of file.text.matchAll(FROM_RE)) {
      const name = match[1] ?? tableAliases.get(match[2] ?? '');
      if (name !== undefined && tableNames.has(name)) addUser(table, name, owner);
    }
  }
  return { rpc, table };
}

const TABLES_CONSTANT_PATH = `${PRODUCT_SRC}/lib/database/tables.ts`;

/** `databaseTables` の alias → 実テーブル名。 */
export function parseTableAliases(sources: SourceFile[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const file = sources.find((candidate) => candidate.path === TABLES_CONSTANT_PATH);
  if (file === undefined) return aliases;
  for (const match of file.text.matchAll(/^\s+([A-Za-z]+):\s*'([a-z_]+)',?$/gm)) {
    aliases.set(match[1], match[2]);
  }
  return aliases;
}

export function discoverInventory(
  root: string,
  sources: SourceFile[],
  schema: SchemaModel,
): InventoryItem[] {
  const items: InventoryItem[] = [];

  const features = new Set<string>();
  for (const file of sources) {
    const feature = featureOf(file.path);
    if (feature !== undefined) features.add(feature);
  }
  for (const feature of features) {
    items.push({ kind: 'feature', id: feature, path: `${PRODUCT_SRC}/features/${feature}` });
  }

  const tableNames = new Set(schema.tables.map((table) => table.name));
  const users = collectDatabaseUsers(sources, parseTableAliases(sources), tableNames);
  for (const table of schema.tables) {
    const usedBy = [...(users.table.get(table.name) ?? [])].sort();
    items.push({
      kind: 'table',
      id: table.name,
      path: 'apps/product/src/lib/database/generated/database.types.ts',
      usedBy,
      detail: usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'app からの直接アクセスなし',
    });
  }
  for (const fn of schema.functions) {
    if (fn === 'graphql') continue;
    const usedBy = [...(users.rpc.get(fn) ?? [])].sort();
    items.push({
      kind: 'db-function',
      id: fn,
      path: 'apps/product/src/lib/database/generated/database.types.ts',
      usedBy,
      detail: usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'app からの .rpc 呼び出しなし',
    });
  }

  const appRouter = sources.find((file) => file.path === APP_ROUTER_PATH);
  if (appRouter === undefined) throw new Error(`${APP_ROUTER_PATH} が見つかりません`);
  const routers = discoverTrpcRouters(appRouter);
  items.push(...routers, ...discoverTrpcProcedures(sources, routers));

  const registry = sources.find((file) => file.path === MCP_REGISTRY_PATH);
  if (registry === undefined) throw new Error(`${MCP_REGISTRY_PATH} が見つかりません`);
  items.push(...discoverMcpTools(registry));

  for (const file of sources) {
    const store = file.path.match(/\/stores\/(use[A-Za-z]+Store)\.ts$/);
    if (store) {
      items.push({ kind: 'store', id: store[1], path: file.path, feature: featureOf(file.path) });
    }
    if (/\.stories\.tsx$/.test(file.path)) {
      const title = file.text.match(/const meta[\s\S]*?title:\s*'([^']+)'/)?.[1];
      items.push({
        kind: 'story',
        id: title ?? file.path.replace(/^.*\//, ''),
        path: file.path,
        feature: featureOf(file.path),
      });
    }
    const route = file.path.match(/^apps\/product\/src\/app\/(.+)\/page\.tsx$/);
    if (route) {
      const segments = route[1].split('/').filter((segment) => !/^\(.+\)$/.test(segment));
      items.push({ kind: 'route', id: `/${segments.join('/')}`, path: file.path });
    }
  }
  const rootPage = sources.find((file) => file.path === `${PRODUCT_SRC}/app/page.tsx`);
  if (rootPage) items.push({ kind: 'route', id: '/', path: rootPage.path });

  const messagesDir = join(root, MESSAGES_DIR);
  if (existsSync(messagesDir)) {
    for (const entry of readdirSync(messagesDir)) {
      if (!entry.endsWith('.json')) continue;
      items.push({
        kind: 'i18n-namespace',
        id: entry.replace(/\.json$/, ''),
        path: `${MESSAGES_DIR}/${entry}`,
      });
    }
  }

  const order = new Map(INVENTORY_KINDS.map((kind, index) => [kind, index]));
  return items.sort(
    (a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.id.localeCompare(b.id),
  );
}
