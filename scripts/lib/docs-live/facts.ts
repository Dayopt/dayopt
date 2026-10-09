import { globSync } from 'glob';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

interface Source {
  path: string;
  symbols?: readonly string[];
  keys?: readonly string[];
}

/** 抽出する所在とsymbolだけを登録する。値・件数・生成本文は保存しない。 */
export const FACT_DOCUMENT_SOURCES: Readonly<Record<string, readonly Source[]>> = {
  'docs/operations/product-analytics.md': [
    { path: 'apps/product/src/lib/analytics/product-events.ts', symbols: ['PRODUCT_EVENT_NAMES'] },
  ],
  'docs/operations/security.md': [{ path: '.github/workflows/*.{yml,yaml}' }],
  'docs/engineering/license-compliance.md': [
    { path: 'apps/product/.licensrc.json', keys: ['onlyAllow', 'prohibited', 'warning'] },
  ],
  'docs/learn/system/agents.md': [
    { path: '.agents/skills/*/SKILL.md' },
    { path: '.claude/settings.json', keys: ['permissions'] },
  ],
  'apps/product/src/emails/README.md': [
    { path: 'scripts/tasks/sync-auth-email-templates.ts', symbols: ['AUTH_EMAIL_TEMPLATES'] },
  ],
  'docs/engineering/architecture.md': [
    { path: 'packages/foundations/package.json', keys: ['exports'] },
  ],
  '.agents/skills/i18n/SKILL.md': [{ path: 'apps/product/messages/en/common.json' }],
  'docs/engineering/infra.md': [{ path: '.husky/pre-commit' }, { path: 'lint-staged.config.mjs' }],
  'apps/product/src/lib/rate-limit/docs/upstash-setup.md': [
    {
      path: 'apps/product/src/lib/rate-limit/upstash.ts',
      symbols: [
        'contactRateLimit',
        'trpcUserRateLimit',
        'timeblockCreateRateLimit',
        'icalFeedRateLimit',
        'cspReportRateLimit',
        'cspReportGlobalRateLimit',
      ],
    },
  ],
};

function read(root: string, path: string): string {
  const target = resolve(root, path);
  if (realpathSync(target) !== resolve(realpathSync(root), path))
    throw new Error(`facts: symlink / repo 外の正本は禁止です: ${path}`);
  return readFileSync(target, 'utf8');
}

function code(text: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

function quote(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replaceAll('\n', ' ');
}

function declarations(text: string, path: string, names: readonly string[]): string {
  const diagnostics = ts.transpileModule(text, { reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error))
    throw new Error(`facts: TypeScript の構文が不正です: ${path}`);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const values = new Map<string, ts.VariableDeclaration>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name)) values.set(declaration.name.text, declaration);
  }
  return names
    .map((name) => {
      const declaration = values.get(name);
      if (!declaration?.initializer) throw new Error(`facts: ${path} に ${name} がありません`);
      return `const ${declaration.getText(source)};`;
    })
    .join('\n\n');
}

/** import/evalはしない。正本を毎回読み、設定定義と一覧だけを表示する。外部稼働は証明しない。 */
export function renderFacts(root: string, document: string): string {
  const sources = FACT_DOCUMENT_SOURCES[document];
  if (!sources) throw new Error(`facts: 未登録の文書: ${document}`);
  const link = (path: string) =>
    `[${quote(path)}](${relative(dirname(document), path).split('\\').join('/')})`;
  const chunks = [
    '正本から今回取得した一覧・設定定義。コードは実行せず、外部の設定・適用・稼働は確認していない。',
  ];
  for (const source of sources) {
    if (source.path.includes('*')) {
      const paths = globSync(source.path, { cwd: root, nodir: true, follow: false }).sort();
      if (!paths.length) throw new Error(`facts: 正本がありません: ${source.path}`);
      chunks.push(`正本: \`${source.path}\`（${paths.length} ファイル）`);
      for (const path of paths) {
        const text = read(root, path);
        if (path.endsWith('/SKILL.md')) {
          const description = /^description:\s*(.+)$/m.exec(text)?.[1];
          if (!description) throw new Error(`facts: skill description がありません: ${path}`);
          chunks.push(`- ${link(path)} — ${quote(description)}`);
        } else chunks.push(`- ${link(path)}`);
      }
      continue;
    }
    const text = read(root, source.path);
    chunks.push(`正本: ${link(source.path)}`);
    if (source.symbols) chunks.push(code(declarations(text, source.path, source.symbols), 'ts'));
    else if (source.path === '.claude/settings.json') {
      const permissions = (JSON.parse(text) as { permissions: Record<string, unknown> })
        .permissions;
      const rows = ['| 種別 | 登録件数 |', '| --- | --- |'];
      for (const key of ['allow', 'deny', 'ask']) {
        const entries = permissions[key];
        if (!Array.isArray(entries))
          throw new Error(`facts: permissions.${key} が配列ではありません`);
        rows.push(`| ${key} | ${entries.length} |`);
      }
      chunks.push(rows.join('\n'));
    } else if (source.path === 'apps/product/messages/en/common.json') {
      const data = JSON.parse(text) as Record<string, unknown>;
      chunks.push(
        [
          '| JSON path |',
          '| --- |',
          ...Object.entries(data).flatMap(([key, value]) => [
            `| ${quote(key)} |`,
            ...(value && typeof value === 'object' && !Array.isArray(value)
              ? Object.keys(value).map((child) => `| ${quote(`${key}.${child}`)} |`)
              : []),
          ]),
        ].join('\n'),
      );
    } else if (source.keys) {
      const json = JSON.parse(text) as Record<string, unknown>;
      const selected = Object.fromEntries(
        source.keys.map((key) => {
          if (!(key in json)) throw new Error(`facts: ${source.path} に ${key} がありません`);
          return [key, json[key]];
        }),
      );
      chunks.push(code(JSON.stringify(selected, null, 2), 'json'));
    } else chunks.push(code(text.trim(), source.path.endsWith('.mjs') ? 'js' : 'sh'));
  }
  return chunks.join('\n\n');
}
