/**
 * 呼び出し経路を型チェッカーで辿る。
 *
 * 正規表現では追えない 3 つを解決する:
 *   - tRPC procedure → service → `.from()` / `.rpc()`（`this.x.method` や DI 経由の呼び出し）
 *   - MCP tool → client → `apply_mcp_*`（tRPC を経由しない書き込み経路）
 *   - 画面（page.tsx）→ client から呼ぶ procedure（barrel を辿らず宣言元へ解決する）
 *
 * program の生成は約 1.3 秒、型解決は lazy なので、辿る範囲を entry point から届く範囲に絞れば
 * 生成全体の実行時間には収まる（2026-09-16 実測）。
 */

import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

export interface DbAccess {
  tables: string[];
  functions: string[];
}

export interface ProcedureDbAccess extends DbAccess {
  /** `ns.proc` */
  id: string;
}

export interface McpToolDbAccess extends DbAccess {
  tool: string;
}

export interface PageProcedures {
  /** route id（`/[locale]/calendar` 等） */
  route: string;
  procedures: string[];
}

export interface CallGraph {
  procedures: ProcedureDbAccess[];
  mcpTools: McpToolDbAccess[];
  pages: PageProcedures[];
}

const PRODUCT_DIR = 'apps/product';
/** 1 entry point から辿る深さの上限（循環と巨大 component ツリーの暴走を防ぐ） */
const MAX_DEPTH = 12;

export interface ProgramContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
}

/** apps/product の tsconfig から program を作る（test / stories は除く）。 */
export function createProductProgram(root: string): ProgramContext {
  const configPath = resolve(root, PRODUCT_DIR, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(`tsconfig を読めません: ${configPath}`);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, PRODUCT_DIR));
  const program = ts.createProgram({
    rootNames: parsed.fileNames.filter((file) => !/\.(test|spec|stories)\.tsx?$/.test(file)),
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  return { program, checker: program.getTypeChecker(), root };
}

function repoPath(context: ProgramContext, file: ts.SourceFile): string {
  return relative(context.root, file.fileName).replace(/\\/g, '/');
}

/** alias（import 経由）を剥がして実体の宣言へ辿り着く。 */
function declarationOf(context: ProgramContext, node: ts.Node): ts.Declaration | undefined {
  let symbol = context.checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = context.checker.getAliasedSymbol(symbol);
    } catch {
      // 解決できない alias（type-only など）はそのまま扱う
    }
  }
  return symbol.declarations?.[0];
}

/** 呼び出し式の callee の宣言を返す（`this.x.method()` は property の宣言型を辿る）。 */
function callTargetDeclaration(
  context: ProgramContext,
  call: ts.CallExpression,
): ts.Declaration | undefined {
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  const direct = declarationOf(context, callee);
  if (direct !== undefined) return direct;

  // interface 経由の DI（`this.commands.createPlan`）は signature から実装を引く
  const signature = context.checker.getResolvedSignature(call);
  return signature?.declaration as ts.Declaration | undefined;
}

/** string literal を返す式なら値を取り出す（定数・`databaseTables.x`・条件式の両枝に対応）。 */
function stringLiteralValues(context: ProgramContext, node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [
      ...stringLiteralValues(context, node.whenTrue),
      ...stringLiteralValues(context, node.whenFalse),
    ];
  }
  const type = context.checker.getTypeAtLocation(node);
  const values: string[] = [];
  for (const part of type.isUnion() ? type.types : [type]) {
    if (part.isStringLiteral()) values.push(part.value);
  }
  return values;
}

function isSupabaseStorageAccess(call: ts.CallExpression): boolean {
  // `supabase.storage.from('avatars')` は bucket であってテーブルではない
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = expression.expression;
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
}

interface Collector {
  tables: Set<string>;
  functions: Set<string>;
}

/**
 * 宣言から到達する DB アクセスを集める。
 *
 * 同じ宣言は 1 回しか展開しない（memo）。`tableNames` で絞るのは、`Array.from` や
 * 他の `.from()` を取り込まないため。
 */
function collectDbAccess(
  context: ProgramContext,
  declaration: ts.Declaration,
  tableNames: Set<string>,
  functionNames: Set<string>,
  memo: Map<ts.Declaration, DbAccess>,
  depth: number,
  visiting: Set<ts.Declaration>,
): DbAccess {
  const cached = memo.get(declaration);
  if (cached !== undefined) return cached;
  if (depth > MAX_DEPTH || visiting.has(declaration)) return { tables: [], functions: [] };

  visiting.add(declaration);
  const collector: Collector = { tables: new Set(), functions: new Set() };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const argument = node.arguments[0];

      if (name === 'from' && argument !== undefined && !isSupabaseStorageAccess(node)) {
        for (const value of stringLiteralValues(context, argument)) {
          if (tableNames.has(value)) collector.tables.add(value);
        }
      } else if (name === 'rpc' && argument !== undefined) {
        for (const value of stringLiteralValues(context, argument)) {
          if (functionNames.has(value)) collector.functions.add(value);
        }
      } else {
        const target = callTargetDeclaration(context, node);
        if (target !== undefined && isInProduct(context, target)) {
          const nested = collectDbAccess(
            context,
            target,
            tableNames,
            functionNames,
            memo,
            depth + 1,
            visiting,
          );
          for (const table of nested.tables) collector.tables.add(table);
          for (const fn of nested.functions) collector.functions.add(fn);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);

  visiting.delete(declaration);
  const access: DbAccess = {
    tables: [...collector.tables].sort(),
    functions: [...collector.functions].sort(),
  };
  memo.set(declaration, access);
  return access;
}

function isInProduct(context: ProgramContext, declaration: ts.Declaration): boolean {
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && file.fileName.includes(`/${PRODUCT_DIR}/src/`);
}

/** `createTRPCRouter({ name: ... })` の property を entry point として集める。 */
function findProcedureEntries(
  context: ProgramContext,
  namespaceOfPath: Map<string, string>,
): Array<{ id: string; node: ts.Node }> {
  const entries: Array<{ id: string; node: ts.Node }> = [];
  for (const file of context.program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    const path = repoPath(context, file);
    const namespace = namespaceOfPath.get(path);
    if (namespace === undefined || !file.text.includes('createTRPCRouter(')) continue;

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
          entries.push({ id: `${namespace}.${member.name.text}`, node: member.initializer });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return entries;
}

/** 式の中の宣言（const 経由の procedure も辿る）から DB アクセスを集める。 */
function accessOfExpression(
  context: ProgramContext,
  expression: ts.Node,
  tableNames: Set<string>,
  functionNames: Set<string>,
  memo: Map<ts.Declaration, DbAccess>,
): DbAccess {
  if (ts.isIdentifier(expression)) {
    const declaration = declarationOf(context, expression);
    if (declaration !== undefined) {
      return collectDbAccess(context, declaration, tableNames, functionNames, memo, 0, new Set());
    }
  }
  return collectDbAccess(
    context,
    expression as unknown as ts.Declaration,
    tableNames,
    functionNames,
    memo,
    0,
    new Set(),
  );
}

const CLIENT_CALL = /^(api|trpc|utils|helpers|vanillaTrpc)$/;

/** page から辿れる client の `api.ns.proc.useX()` を集める（import は宣言元まで解決する）。 */
function collectPageProcedures(
  context: ProgramContext,
  page: ts.SourceFile,
  knownProcedures: Set<string>,
): string[] {
  const found = new Set<string>();
  const seen = new Set<ts.SourceFile>();

  const walk = (file: ts.SourceFile, depth: number): void => {
    if (seen.has(file) || depth > MAX_DEPTH) return;
    seen.add(file);

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const root = node.expression.expression;
        if (ts.isIdentifier(root) && CLIENT_CALL.test(root.text)) {
          const id = `${node.expression.name.text}.${node.name.text}`;
          if (knownProcedures.has(id)) found.add(id);
        }
      }
      // import した識別子の宣言元 file だけを辿る（barrel の再 export で全体を引き込まない）
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
        const bindings = node.importClause.namedBindings;
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const declaration = declarationOf(context, element.name);
            if (declaration === undefined) continue;
            const target = declaration.getSourceFile();
            if (isInProduct(context, declaration) && target !== file) walk(target, depth + 1);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  };

  walk(page, 0);
  return [...found].sort();
}

export interface CallGraphInput {
  root: string;
  /** router file path → namespace（inventory が解決したもの） */
  namespaceOfPath: Map<string, string>;
  tableNames: Set<string>;
  functionNames: Set<string>;
  procedureIds: Set<string>;
  /** MCP tool 名 → tool file の repo-relative path */
  mcpToolFiles: Map<string, string>;
  /** route id → page.tsx の repo-relative path */
  pageFiles: Map<string, string>;
}

export function buildCallGraph(input: CallGraphInput): CallGraph {
  const context = createProductProgram(input.root);
  const memo = new Map<ts.Declaration, DbAccess>();

  const procedures: ProcedureDbAccess[] = [];
  for (const entry of findProcedureEntries(context, input.namespaceOfPath)) {
    const access = accessOfExpression(
      context,
      entry.node,
      input.tableNames,
      input.functionNames,
      memo,
    );
    if (access.tables.length > 0 || access.functions.length > 0) {
      procedures.push({ id: entry.id, ...access });
    }
  }

  const mcpTools: McpToolDbAccess[] = [];
  for (const [tool, path] of input.mcpToolFiles) {
    const file = context.program.getSourceFile(resolve(input.root, path));
    if (file === undefined) continue;
    const access = collectDbAccess(
      context,
      file as unknown as ts.Declaration,
      input.tableNames,
      input.functionNames,
      memo,
      0,
      new Set(),
    );
    if (access.tables.length > 0 || access.functions.length > 0) {
      mcpTools.push({ tool, ...access });
    }
  }

  const pages: PageProcedures[] = [];
  for (const [route, path] of input.pageFiles) {
    const file = context.program.getSourceFile(resolve(input.root, path));
    if (file === undefined) continue;
    const found = collectPageProcedures(context, file, input.procedureIds);
    if (found.length > 0) pages.push({ route, procedures: found });
  }

  return {
    procedures: procedures.sort((a, b) => a.id.localeCompare(b.id)),
    mcpTools: mcpTools.sort((a, b) => a.tool.localeCompare(b.tool)),
    pages: pages.sort((a, b) => a.route.localeCompare(b.route)),
  };
}

/** 生成物の path を揃えるための helper（test からも使う）。 */
export function toRepoPath(root: string, fileName: string): string {
  return relative(root, fileName).replace(/\\/g, '/');
}

export { dirname };
