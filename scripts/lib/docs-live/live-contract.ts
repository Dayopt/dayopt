import { fromMarkdown } from 'mdast-util-from-markdown';
import { dirname, relative } from 'node:path';
import { FACT_DOCUMENT_SOURCES } from './facts.ts';

type View = 'workspace' | 'commands' | 'files' | 'facts';

export const LIVE_DOCUMENT_VIEWS: Readonly<Record<string, readonly View[]>> = {
  'README.md': ['workspace', 'commands'],
  ...Object.fromEntries(
    Object.keys(FACT_DOCUMENT_SOURCES).map((path) => [path, ['facts'] as const]),
  ),
  'docs/engineering/infra.md': ['commands', 'facts'],
  'packages/billing/README.md': ['files'],
  'packages/config/README.md': ['files'],
};

/** 保存するのは正本への入口だけ。生成本文を保存する場所ではない。 */
export function storedLiveBlock(document: string, view: View): string {
  const source =
    view === 'facts'
      ? 'scripts/lib/docs-live/facts.ts'
      : view === 'workspace'
        ? 'pnpm-workspace.yaml'
        : view === 'commands'
          ? 'package.json'
          : `${dirname(document)}/src/`;
  const link = relative(dirname(document), source).split('\\').join('/');
  return `<!-- docs-live:${view}:start -->\n\n${view === 'facts' ? '抽出対象の登録は' : '正本は'} [${source}](${link})。現在の一覧は \`pnpm docs:read ${document}\` で生成して読む。\n\n<!-- docs-live:${view}:end -->`;
}

export function checkStoredLiveDocument(document: string, markdown: string): string[] {
  const errors: string[] = [];
  const expected = LIVE_DOCUMENT_VIEWS[document] ?? [];
  const seen = new Set<View>();
  const ranges: { start: number; end: number }[] = [];
  let open: { view: View; start: number } | undefined;
  const visit = (nodes: ReturnType<typeof fromMarkdown>['children'], nested = false): void => {
    for (const node of nodes) {
      if ('children' in node)
        visit(node.children as ReturnType<typeof fromMarkdown>['children'], true);
      if (node.type !== 'html' || !node.value.includes('<!-- docs-live:')) continue;
      const match = /^<!-- docs-live:(workspace|commands|files|facts):(start|end) -->$/.exec(
        node.value.trim(),
      );
      if (
        nested ||
        !match ||
        node.position?.start.offset === undefined ||
        node.position.end.offset === undefined
      ) {
        errors.push('不正な docs-live marker');
        continue;
      }
      const view = match[1] as View;
      if (!expected.includes(view))
        errors.push(`${view}: 未登録の生成領域。live-contract.ts に登録してください`);
      if (match[2] === 'start') {
        if (seen.has(view)) errors.push(`${view}: 生成領域の重複`);
        seen.add(view);
        if (open) errors.push('生成領域が入れ子になっています');
        open = { view, start: node.position.start.offset };
      } else {
        if (!open || open.view !== view) errors.push(`${view}: marker の対応が不正です`);
        else if (
          markdown.slice(open.start, node.position.end.offset).trim() !==
          storedLiveBlock(document, view)
        )
          errors.push(
            `${view}: 生成領域への手書きは禁止です。storedLiveBlock の正本リンクだけを保存してください`,
          );
        if (open) ranges.push({ start: open.start, end: node.position.end.offset });
        open = undefined;
      }
    }
  };
  const nodes = fromMarkdown(markdown).children;
  visit(nodes);
  if (open) errors.push(`${open.view}: end marker がありません`);
  for (const view of expected)
    if (!seen.has(view)) errors.push(`${view}: 登録済み生成領域の marker がありません`);
  // 同じ節の marker 外へ一覧を移しても、手書きの写しに戻せない。
  const sectionNames: Record<View, string> = {
    workspace: 'Workspace',
    commands: document === 'README.md' ? 'Commands' : '開発コマンド一覧',
    files: '構造',
    facts: '機械取得する現状',
  };
  let protectedDepth: number | undefined;
  for (const node of nodes) {
    if (node.type === 'heading') {
      if (protectedDepth !== undefined && node.depth <= protectedDepth) protectedDepth = undefined;
      const title = node.children.map((child) => ('value' in child ? child.value : '')).join('');
      if (expected.some((view) => sectionNames[view] === title)) protectedDepth = node.depth;
    }
    const offset = node.position?.start.offset;
    if (
      protectedDepth === undefined ||
      offset === undefined ||
      ranges.some((range) => offset >= range.start && offset < range.end)
    )
      continue;
    const text = markdown.slice(offset, node.position?.end.offset);
    if (
      node.type === 'list' ||
      (node.type === 'paragraph' &&
        (/^\s*\|.*\|\s*$/m.test(text) ||
          /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text))) ||
      (node.type === 'code' && (expected.includes('facts') || /[├└]──/.test(text)))
    )
      errors.push('生成対象の節への手書き一覧は禁止です。正本または生成器を更新してください');
  }
  return errors;
}
