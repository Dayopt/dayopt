import ts from 'typescript';

/** 個別 Story の展示タグを meta の除外と取り違えず、ファイル単位の期待集合を作る。 */
export function hasExcludedMetaTag(content: string, excludedTags: readonly string[]): boolean {
  const source = ts.createSourceFile(
    'story.tsx',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const assignment = source.statements.find(ts.isExportAssignment);
  if (!assignment) return false;
  let expression: ts.Expression | undefined = assignment.expression;
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    expression = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      )?.initializer;
  }
  if (!expression) return false;
  while (
    ts.isSatisfiesExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    expression = expression.expression;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const tags = expression.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'tags',
  );
  if (!tags || !ts.isPropertyAssignment(tags) || !ts.isArrayLiteralExpression(tags.initializer))
    return false;
  return tags.initializer.elements.some(
    (element) => ts.isStringLiteral(element) && excludedTags.includes(element.text),
  );
}
