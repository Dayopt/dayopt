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
import { join } from 'node:path';

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

const PROCEDURE_RE = /^ {2}([A-Za-z]+):\s*([A-Za-z]*Procedure)\b/gm;

export function discoverTrpcProcedures(
  sources: SourceFile[],
  routers: InventoryItem[],
): InventoryItem[] {
  const namespaceOfPath = new Map(routers.map((router) => [router.path, router.id]));
  const items: InventoryItem[] = [];
  for (const file of sources) {
    if (!isRuntimeSource(file) || !file.text.includes('createTRPCRouter(')) continue;
    const routerName =
      namespaceOfPath.get(file.path) ?? file.path.replace(/^.*\//, '').replace(/\.tsx?$/, '');
    for (const match of file.text.matchAll(PROCEDURE_RE)) {
      items.push({
        kind: 'trpc-procedure',
        id: `${routerName}.${match[1]}`,
        path: file.path,
        feature: featureOf(file.path),
        detail: match[2],
      });
    }
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

const RPC_RE = /\.rpc\(\s*'([a-z_0-9]+)'/g;

function rpcUsers(sources: SourceFile[]): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  for (const file of sources) {
    if (!isRuntimeSource(file)) continue;
    const owner = featureOf(file.path) ?? file.path.match(/^apps\/product\/src\/([a-z]+)\//)?.[1];
    if (owner === undefined) continue;
    for (const match of file.text.matchAll(RPC_RE)) {
      let set = users.get(match[1]);
      if (set === undefined) {
        set = new Set();
        users.set(match[1], set);
      }
      set.add(owner);
    }
  }
  return users;
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

  for (const table of schema.tables) {
    items.push({ kind: 'table', id: table.name, path: 'supabase/migrations' });
  }
  const users = rpcUsers(sources);
  for (const fn of schema.functions) {
    if (fn === 'graphql') continue;
    const usedBy = [...(users.get(fn) ?? [])].sort();
    items.push({
      kind: 'db-function',
      id: fn,
      path: 'supabase/migrations',
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
