/** Conservative syntactic inventory; test proximity is NOT behavioral coverage. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const files = spawnSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    'apps',
    'packages',
    'supabase/functions',
    'scripts',
  ],
  { encoding: 'utf8' },
)
  .stdout.trim()
  .split('\n')
  .filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));
const publicFunctions = [],
  endpoints = [],
  tests = [],
  mocks = [];
const fileSet = new Set(files);
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
  const production =
    !isTest && !/\.stories\.|\/test\/|\/e2e\/|\/__tests__\/|\.config\.|test-helpers/.test(file);
  const location = (node) => ({
    file,
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
  });
  function visit(node) {
    if (production && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(node) && node.body)
        publicFunctions.push({
          ...location(node),
          name: node.name?.text ?? 'default',
          adjacentTest: ['.test.ts', '.test.tsx'].some((ext) =>
            fileSet.has(file.replace(/\.[^.]+$/, ext)),
          ),
        });
      if (ts.isVariableStatement(node))
        for (const declaration of node.declarationList.declarations) {
          if (
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
          )
            publicFunctions.push({
              ...location(declaration),
              name: declaration.name.getText(ast),
              adjacentTest: ['.test.ts', '.test.tsx'].some((ext) =>
                fileSet.has(file.replace(/\.[^.]+$/, ext)),
              ),
            });
        }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(ast);
      if (
        production &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['query', 'mutation', 'subscription'].includes(node.expression.name.text) &&
        /(?:router|procedures)/.test(file)
      )
        endpoints.push({
          ...location(node),
          kind: node.expression.name.text,
          name: ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(ast) : '(chained)',
        });
      if (
        isTest &&
        /^(?:it|test)(?:\.(?:only|skip|todo|each|concurrent|skipIf|runIf|fails))*$/.test(
          expression.replace(/\([\s\S]*\)/g, ''),
        ) &&
        node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      ) {
        const callback = node.arguments.find(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        );
        const body = callback.body;
        const leading = ts.isBlock(body)
          ? source.slice(body.getStart(ast) + 1, body.statements[0]?.getStart(ast) ?? body.end - 1)
          : '';
        tests.push({
          ...location(node),
          name: node.arguments.find((a) => ts.isStringLiteralLike(a))?.text ?? '(parameterized)',
          hasOpeningComment: /\/\/[^\n]+|\/\*[\s\S]+?\*\//.test(leading),
        });
      }
      if (/^(vi|jest)\.(mock|doMock|spyOn)$/.test(expression))
        mocks.push({ ...location(node), call: node.getText(ast).slice(0, 200) });
    }
    if (
      production &&
      /\/route\.[jt]s$/.test(file) &&
      ts.isFunctionDeclaration(node) &&
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.name?.text ?? '')
    )
      endpoints.push({ ...location(node), kind: 'HTTP', name: node.name.text });
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const output = process.argv[2] ?? 'artifacts/test-mission/inventory.json';
fs.mkdirSync(path.dirname(output), { recursive: true });
const summary = {
  sourceFiles: files.length,
  publicFunctions: publicFunctions.length,
  withoutAdjacentTest: publicFunctions.filter((f) => !f.adjacentTest).length,
  endpoints: endpoints.length,
  testDeclarations: tests.length,
  withoutOpeningComment: tests.filter((t) => !t.hasOpeningComment).length,
  mockCalls: mocks.length,
  conflictsDirectoryExists: fs.existsSync('issues'),
};
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      summary,
      limitations: [
        'Syntactic lower bound: re-exports, wrapped functions, class/object methods, computed endpoints and Deno.serve are not fully resolved.',
        'Adjacent test and opening comment flags are triage hints, not assertions of positive/negative coverage or meaningful purpose.',
        'Mocks are candidates for manual classification; external boundary mocks are allowed.',
      ],
      publicFunctions,
      endpoints,
      tests,
      mocks,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
