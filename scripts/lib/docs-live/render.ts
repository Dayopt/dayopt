import { globSync } from 'glob';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { renderFacts } from './facts.ts';
import { LIVE_DOCUMENT_VIEWS } from './live-contract.ts';

type View = 'workspace' | 'commands' | 'files' | 'facts';
interface Manifest {
  name: string;
  scripts?: Record<string, string>;
}

function cell(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replaceAll('\n', ' ');
}

function sourceLink(document: string, target: string): string {
  return relative(dirname(document), target).split('\\').join('/');
}

/** pnpm 自身に workspace selector を解釈させる。node_modules や手書き一覧は使わない。 */
export function workspacePaths(root: string): string[] {
  const canonicalRoot = realpathSync(root);
  const result = spawnSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('pnpm による workspace の取得に失敗しました');
  const packages = JSON.parse(result.stdout) as { path: string }[];
  const paths = packages
    .map((pkg) => relative(canonicalRoot, realpathSync(pkg.path)).split('\\').join('/'))
    .filter(Boolean)
    .sort();
  if (paths.some((path) => path.split('/').includes('..'))) {
    throw new Error('repo 外の workspace はこの reader の対象外です');
  }
  return paths;
}

function renderView(root: string, document: string, view: View): string {
  if (view === 'facts') return renderFacts(root, document);
  const readManifest = (path: string): Manifest =>
    JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest;
  if (view === 'files') {
    const source = `${dirname(document)}/src`;
    if (!document.startsWith('packages/') || !document.endsWith('/README.md')) {
      throw new Error('files view は package README でだけ使用できます');
    }
    // src が存在しない場合に空の一覧を成功として表示しない。
    if (realpathSync(resolve(root, source)) !== resolve(realpathSync(root), source)) {
      throw new Error('src の symlink はこの reader の対象外です');
    }
    const files = globSync(`${source}/**/*`, { cwd: root, nodir: true, follow: false }).sort();
    return [
      `正本: \`${source}/\` の実ファイル。責務・公開境界は本文を参照。`,
      '',
      ...files.map((file) => `- [${cell(relative(source, file))}](${sourceLink(document, file)})`),
    ].join('\n');
  }
  if (view === 'workspace') {
    const rows = workspacePaths(root).map((path) => {
      const manifest = `${path}/package.json`;
      return `| [${cell(path)}](${sourceLink(document, manifest)}) | ${cell(readManifest(manifest).name)} |`;
    });
    return [
      '正本: `pnpm-workspace.yaml` と各 `package.json`。登録された workspace の一覧。',
      '',
      '| Path / manifest | Package |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
  }
  const scripts = readManifest('package.json').scripts;
  if (!scripts) throw new Error('package.json に scripts がありません');
  return [
    `正本: [root package.json](${sourceLink(document, 'package.json')}) の scripts。実行内容をそのまま表示し、コマンドは実行しない。`,
    '',
    '| コマンド | 実行内容 |',
    '| --- | --- |',
    ...Object.entries(scripts)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([name, command]) => `| pnpm ${cell(name)} | ${cell(command)} |`),
  ].join('\n');
}

/** 保存済みの生成本文は持たず、読むたびに source を解決する。コード例の marker は無視する。 */
export function renderLiveDocument(root: string, document: string): string {
  const target = resolve(root, document);
  const repoPath = relative(realpathSync(root), realpathSync(target)).split('\\').join('/');
  if (repoPath !== document || !/\.(md|mdx)$/.test(repoPath)) {
    throw new Error('repo 内の実 Markdown ファイルを指定してください（symlink は不可）');
  }
  const markdown = readFileSync(resolve(root, document), 'utf8');
  return renderLiveMarkdown(root, document, markdown);
}

/** 既存生成器が作った本文にも同じ live ブロックを解決する。保存はしない。 */
export function renderLiveMarkdown(root: string, document: string, markdown: string): string {
  const replacements: { start: number; end: number; view: View }[] = [];
  let open: { start: number; view: View } | undefined;
  const tree = fromMarkdown(markdown);
  const rejectNestedMarkers = (nodes: typeof tree.children, depth: number): void => {
    for (const node of nodes) {
      if (depth > 0 && node.type === 'html' && node.value.includes('<!-- docs-live:')) {
        throw new Error(`${document}: docs-live marker は最上位に置いてください`);
      }
      // コードフェンスは子ノードを持たないため、marker の例は検査対象にならない。
      if ('children' in node) {
        rejectNestedMarkers(node.children as typeof tree.children, depth + 1);
      }
    }
  };
  rejectNestedMarkers(tree.children, 0);
  for (const node of tree.children) {
    if (node.type !== 'html' || !node.value.includes('<!-- docs-live:')) continue;
    const match = /^<!-- docs-live:(workspace|commands|files|facts):(start|end) -->$/.exec(
      node.value.trim(),
    );
    if (
      !match ||
      node.position?.start.offset === undefined ||
      node.position.end.offset === undefined
    ) {
      throw new Error(`${document}: 不正な docs-live marker`);
    }
    const view = match[1] as View;
    if (match[2] === 'start') {
      if (open) throw new Error(`${document}: docs-live marker が入れ子になっています`);
      open = { start: node.position.start.offset, view };
    } else {
      if (!open || open.view !== view)
        throw new Error(`${document}: docs-live marker の対応が不正です`);
      replacements.push({ ...open, end: node.position.end.offset });
      open = undefined;
    }
  }
  if (open) throw new Error(`${document}: docs-live end marker がありません`);
  for (const view of LIVE_DOCUMENT_VIEWS[document] ?? []) {
    if (!replacements.some((block) => block.view === view)) {
      throw new Error(`${document}: ${view}: 登録済み生成領域の marker がありません`);
    }
  }
  // 全入力の解決に成功するまで呼び出し側へ本文を渡さない。古い本文への fallback はしない。
  let output = markdown;
  for (const block of replacements.reverse()) {
    output =
      output.slice(0, block.start) +
      renderView(root, document, block.view) +
      output.slice(block.end);
  }
  return output;
}
