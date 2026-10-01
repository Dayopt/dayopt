import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRAND_DOCUMENT_SOURCE,
  BRAND_DOCUMENT_TARGETS,
  documentSourcePath,
} from './brand-document.ts';
import { documentOrigin, type DocumentOrigin } from './reader.ts';

export interface DocumentEntry {
  path: string;
  origin: DocumentOrigin;
  role: string;
  lines: number;
}

/** Git の管理対象 + ignore されていない新規文書。dependency/cache 内を走査しない。 */
export function documentPaths(root: string): string[] {
  return [
    ...new Set([
      ...(existsSync(resolve(root, BRAND_DOCUMENT_SOURCE)) ? BRAND_DOCUMENT_TARGETS : []),
      ...execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md', '*.mdx'],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        },
      )
        .split('\0')
        .filter((path) => !!path && existsSync(resolve(root, path))),
    ]),
  ].sort();
}

function role(path: string): string {
  if (path.startsWith('apps/web/content/legal/')) return '法務上の約束（人間の正本）';
  if (path.startsWith('apps/web/content/blog/')) return '編集記事・当時のリリース記録';
  if (path.startsWith('apps/web/content/docs/'))
    return '利用手順・公開契約（code の丸写しでは置換不可）';
  if (/AGENTS\.md$|CLAUDE\.md$|^\.agents\/|^\.github\/|\/_templates\//.test(path))
    return '指示・判断・手順・テンプレート';
  if (
    path === 'docs/decisions.md' ||
    /\/migrations\/|\/ai-.*(?:audit|trials)|\/disaster-recovery-drill\.md$|\/mission-testing\.md$|\/threat-model\.md$/.test(
      path,
    )
  )
    return '判断履歴・時点の検証証拠';
  if (path.startsWith('docs/product/')) return '製品の意味・仕様の正本 + 実装値の写し候補';
  if (path.startsWith('docs/business/')) return '事業・編集判断 + 価格等の写し候補';
  if (path === 'docs/company/accounts.md') return '外部契約・所有（provider の読取が必要）';
  if (/\.mdx$/.test(path)) return 'Storybook の説明・利用方針 + props/token の写し候補';
  if (path.startsWith('docs/learn/')) return '教材の意味の正本 + JSON/code の写し候補';
  return '運用・設計説明 + code/config/外部状態の写し候補';
}

export function collectDocumentCatalog(root: string): DocumentEntry[] {
  return documentPaths(root).map((path) => {
    const text = readFileSync(resolve(root, documentSourcePath(path)), 'utf8');
    return {
      path,
      origin: documentOrigin(text, path),
      role: documentSourcePath(path) !== path ? '正本から読む配布説明（保存本文なし）' : role(path),
      lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    };
  });
}

export function renderDocumentCatalog(entries: DocumentEntry[]): string {
  const totals = new Map<string, number>();
  for (const entry of entries) totals.set(entry.origin, (totals.get(entry.origin) ?? 0) + 1);
  return [
    '# ドキュメント生成の全体棚卸し',
    '',
    'Git が列挙した実在 Markdown / MDX と、宣言された配布説明の閲覧 alias を正本から解析した一覧。生成 marker・生成器宣言は機械判定、文書の役割は path による候補分類。本文の真実性・稼働・法務承認を証明する検査ではない。',
    '',
    `対象: ${entries.length} ファイル。`,
    '',
    ...[...totals].sort().map(([origin, count]) => `- ${origin}: ${count} ファイル`),
    '',
    '| ファイル | 行数 | 読取方式 | 役割 / 確認すること |',
    '| --- | --- | --- | --- |',
    ...entries.map(
      (entry) => `| ${entry.path} | ${entry.lines} | ${entry.origin} | ${entry.role} |`,
    ),
    '',
  ].join('\n');
}
