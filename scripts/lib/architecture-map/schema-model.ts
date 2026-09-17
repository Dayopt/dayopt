/**
 * Supabase が生成した `database.types.ts` から、Architecture Map が使う schema model
 * （public schema のテーブル / 列 / FK / 関数名）を取り出す。
 *
 * 正本は migration だが、生成型は CI の Integration job が `types:generate:local` +
 * `git diff --exit-code` で migration との一致を検査済みなので、DB へ接続せずに
 * 列と FK の deterministic な text source として使える。
 *
 * 取れないもの: PK / unique / index / check 制約（生成型に含まれない）。
 */

import ts from 'typescript';

export interface SchemaColumn {
  name: string;
  /** TypeScript の型テキスト（`string | null` 等）から `| null` を除いたもの */
  type: string;
  nullable: boolean;
}

export interface SchemaRelationship {
  /** FK 制約名 */
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  isOneToOne: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  relationships: SchemaRelationship[];
}

export interface SchemaModel {
  tables: SchemaTable[];
  functions: string[];
}

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return node.getText();
}

function memberType(literal: ts.TypeLiteralNode, name: string): ts.TypeNode | undefined {
  for (const member of literal.members) {
    if (ts.isPropertySignature(member) && member.name && propertyName(member.name) === name) {
      return member.type;
    }
  }
  return undefined;
}

function requireTypeLiteral(node: ts.TypeNode | undefined, label: string): ts.TypeLiteralNode {
  if (node === undefined || !ts.isTypeLiteralNode(node)) {
    throw new Error(
      `database.types.ts の構造が想定と違います: ${label} が object 型ではありません`,
    );
  }
  return node;
}

function literalValue(node: ts.TypeNode): string | boolean {
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) return literal.text;
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
  }
  throw new Error(`database.types.ts の Relationships に想定外の値があります: ${node.getText()}`);
}

function literalList(node: ts.TypeNode): string[] {
  if (!ts.isTupleTypeNode(node)) {
    throw new Error(
      `database.types.ts の Relationships に想定外の配列があります: ${node.getText()}`,
    );
  }
  return node.elements.map((element) => String(literalValue(element)));
}

function parseColumns(row: ts.TypeLiteralNode, sourceFile: ts.SourceFile): SchemaColumn[] {
  const columns: SchemaColumn[] = [];
  for (const member of row.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
    const parts = ts.isUnionTypeNode(member.type)
      ? member.type.types
      : ([member.type] as readonly ts.TypeNode[]);
    const nonNull = parts.filter(
      (part) => !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    columns.push({
      name: propertyName(member.name),
      type: nonNull.map((part) => part.getText(sourceFile)).join(' | '),
      nullable: nonNull.length !== parts.length,
    });
  }
  return columns;
}

function parseRelationships(node: ts.TypeNode | undefined): SchemaRelationship[] {
  if (node === undefined) return [];
  if (!ts.isTupleTypeNode(node)) {
    throw new Error('database.types.ts の Relationships が tuple ではありません');
  }
  return node.elements.map((element) => {
    const literal = requireTypeLiteral(element, 'Relationships の要素');
    const read = (name: string): ts.TypeNode => {
      const value = memberType(literal, name);
      if (value === undefined) {
        throw new Error(`database.types.ts の Relationships に ${name} がありません`);
      }
      return value;
    };
    return {
      name: String(literalValue(read('foreignKeyName'))),
      columns: literalList(read('columns')),
      referencedTable: String(literalValue(read('referencedRelation'))),
      referencedColumns: literalList(read('referencedColumns')),
      isOneToOne: literalValue(read('isOneToOne')) === true,
    };
  });
}

/** `database.types.ts` のソース文字列から public schema の model を取り出す。 */
export function parseSchemaModel(source: string): SchemaModel {
  const sourceFile = ts.createSourceFile('database.types.ts', source, ts.ScriptTarget.Latest, true);

  let databaseType: ts.TypeNode | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Database') {
      databaseType = statement.type;
    }
  }
  const database = requireTypeLiteral(databaseType, 'Database');
  const publicSchema = requireTypeLiteral(memberType(database, 'public'), 'Database.public');
  const tablesNode = requireTypeLiteral(memberType(publicSchema, 'Tables'), 'public.Tables');
  const functionsNode = requireTypeLiteral(
    memberType(publicSchema, 'Functions'),
    'public.Functions',
  );

  const tables: SchemaTable[] = [];
  for (const member of tablesNode.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = propertyName(member.name);
    const table = requireTypeLiteral(member.type, `Tables.${name}`);
    const row = requireTypeLiteral(memberType(table, 'Row'), `Tables.${name}.Row`);
    tables.push({
      name,
      columns: parseColumns(row, sourceFile),
      relationships: parseRelationships(memberType(table, 'Relationships')),
    });
  }

  const functions: string[] = [];
  for (const member of functionsNode.members) {
    if (ts.isPropertySignature(member) && member.name) functions.push(propertyName(member.name));
  }

  if (tables.length === 0) {
    throw new Error('database.types.ts から public テーブルを 1 つも取り出せませんでした');
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  functions.sort();
  return { tables, functions };
}

export function findTable(model: SchemaModel, name: string): SchemaTable | undefined {
  return model.tables.find((table) => table.name === name);
}
