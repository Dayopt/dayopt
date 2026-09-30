import { fromMarkdown } from 'mdast-util-from-markdown';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_DOC_CONTRACTS } from '../../tasks/docs-guard/config.ts';
import {
  BRAND_DOCUMENT_SOURCE,
  BRAND_DOCUMENT_TARGETS,
  documentSourcePath,
} from './brand-document.ts';
import { renderLiveDocument, renderLiveMarkdown } from './render.ts';

export type DocumentOrigin =
  'source' | 'live' | 'architecture' | 'glossary' | 'learn' | 'brand' | 'db-snapshot';
export interface DocumentOutput {
  path: string;
  content: string;
}
export type DocumentBuilders = Partial<
  Record<'architecture' | 'glossary' | 'learn' | 'brand', () => Promise<DocumentOutput[]>>
>;

/** marker のコード例は生成先に数えない。generator 名への本文リンクも対象外。 */
export function documentOrigin(markdown: string, document?: string): DocumentOrigin {
  if (BRAND_DOCUMENT_TARGETS.some((target) => target === document)) return 'brand';
  const declaredSource = document ? GENERATED_DOC_CONTRACTS[document]?.source : undefined;
  if (declaredSource?.endsWith('generate-rls-snapshot.ts')) return 'db-snapshot';
  if (declaredSource?.endsWith('generate-architecture-map.ts')) return 'architecture';
  if (document === 'docs/product/glossary.md') return 'glossary';
  if (
    document === 'docs/engineering/architecture.md' ||
    document === 'docs/engineering/invariants.md'
  )
    return 'architecture';
  const html: string[] = [];
  const visit = (nodes: ReturnType<typeof fromMarkdown>['children']): void => {
    for (const node of nodes) {
      if (node.type === 'html') html.push(node.value);
      if ('children' in node) visit(node.children as ReturnType<typeof fromMarkdown>['children']);
    }
  };
  visit(fromMarkdown(markdown).children);
  if (html.some((value) => value.includes('<!-- architecture-map:'))) return 'architecture';
  if (html.some((value) => value.includes('<!-- glossary:generated:'))) return 'glossary';
  if (html.some((value) => value.includes('<!-- learn:generated:'))) return 'learn';
  const header = markdown.split('\n').slice(0, 8).join('\n');
  if (/^> \*\*生成元\*\*:.*generate-architecture-map\.ts/m.test(header)) return 'architecture';
  if (/^> \*\*生成元\*\*:.*generate-rls-snapshot\.ts/m.test(header)) return 'db-snapshot';
  if (html.some((value) => value.includes('<!-- docs-live:'))) return 'live';
  return 'source';
}

/** 1 回の読取/製本内だけ共有する。次の読取では必ず新しい reader を作る。 */
export function createDocumentReader(root: string, builders: DocumentBuilders = {}) {
  const generated = new Map<DocumentOrigin, Promise<DocumentOutput[]>>();
  const requireGeneratorRoot = (): void => {
    if (
      realpathSync(root) !==
      realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
    ) {
      throw new Error('固定 repo を読む既存生成器は、別 root から呼び出せません');
    }
  };
  const defaults: DocumentBuilders = {
    brand: async () => {
      const content = renderLiveDocument(root, BRAND_DOCUMENT_SOURCE);
      return BRAND_DOCUMENT_TARGETS.map((path) => ({ path, content }));
    },
    architecture: async () => {
      requireGeneratorRoot();
      const module = await import('../../tasks/generate-architecture-map.ts');
      const violations = module.checkArchitectureReferences();
      if (violations.length)
        throw new Error(violations.map((v) => `${v.source}: ${v.reason}`).join('\n'));
      return module.buildArchitectureMapDocs();
    },
    glossary: async () => {
      requireGeneratorRoot();
      const { buildGlossaryMarkdown } = await import('../../tasks/generate-glossary.ts');
      return [{ path: 'docs/product/glossary.md', content: await buildGlossaryMarkdown() }];
    },
    learn: async () => {
      const { collectLearnData, listLearnRefs } = await import('../learn/data.ts');
      const { checkLearnRefs } = await import('../../tasks/docs-guard/checks/learn-refs.ts');
      const { renderLearnDocs } = await import('../learn/render-markdown.ts');
      const result = collectLearnData(root);
      if (result.errors.length || !result.data)
        throw new Error(result.errors.join('\n') || 'Learning System の正本を取得できません');
      const references = checkLearnRefs(listLearnRefs(result), root);
      if (references.length)
        throw new Error(references.map((ref) => `${ref.ref}: ${ref.reason}`).join('\n'));
      return (await renderLearnDocs(root, result)).map((doc) => ({
        path: doc.file,
        content: doc.expected,
      }));
    },
  };
  return async (document: string, snapshot = false): Promise<string> => {
    // 通常ファイルも、実在・symlink・marker の検査を先に行う。
    const source = documentSourcePath(document);
    const live = renderLiveDocument(root, source);
    const origin = documentOrigin(readFileSync(resolve(root, source), 'utf8'), document);
    if (origin === 'db-snapshot') {
      if (!snapshot)
        throw new Error(
          'DB 実測の保存 snapshot です。現在の DB を確認したとは扱えません。記録を読む場合は --snapshot を指定してください',
        );
      return '> **保存記録**: この本文は DB の現在状態を取得していません。\n\n' + live;
    }
    if (origin === 'source' || origin === 'live') return live;
    const builder = builders[origin] ?? defaults[origin];
    if (!builder) throw new Error(`${origin}: 対応する生成器がありません`);
    if (!generated.has(origin)) generated.set(origin, builder());
    const outputs = await generated.get(origin)!;
    const output = outputs.find((doc) => doc.path === document);
    if (!output) throw new Error(`${document}: 生成器がこの文書を出力しません`);
    return renderLiveMarkdown(root, document, output.content);
  };
}
