import { Marked } from 'marked';
import { dirname, posix } from 'node:path';
import type { DocumentEntry } from './catalog.ts';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function documentHref(path: string, snapshot = false): string {
  return `/doc?path=${encodeURIComponent(path)}${snapshot ? '&snapshot=1' : ''}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — Dayopt Docs</title>
<style>body{margin:0;background:#faf9f6;color:#242420;font:16px/1.8 system-ui,sans-serif}main,nav{max-width:1100px;margin:auto;padding:20px 28px}nav{border-bottom:1px solid #ddd}a{color:#245e9b}article{overflow-wrap:anywhere}pre{overflow:auto;background:#eeede8;padding:18px;border-radius:6px}code{font:14px/1.6 ui-monospace,monospace}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #ccc;padding:8px 12px;text-align:left}blockquote{border-left:3px solid #aaa;margin:1em 0;padding-left:18px}small{color:#595951}li{margin:5px 0}a:focus-visible{outline:2px solid;outline-offset:3px}</style></head><body>
<nav><a href="/">文書一覧</a> · <a href="/learn">仕組みを学ぶ</a></nav><main>${body}</main></body></html>`;
}

/** raw HTML / JSX は実行しない。内部文書以外のローカルリンクや画像も取得しない。 */
export function documentHtml(document: string, markdown: string, paths: readonly string[]): string {
  const parser = new Marked({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (/^https?:\/\//i.test(href))
          return `<a href="${escapeHtml(href)}" rel="noreferrer">${label}</a>`;
        if (href.startsWith('#')) return `<a href="${escapeHtml(href)}">${label}</a>`;
        let decoded: string;
        try {
          decoded = decodeURIComponent(href);
        } catch {
          return label;
        }
        const [target, hash] = decoded.split('#');
        const path = posix.normalize(posix.join(dirname(document), target));
        if (!paths.includes(path)) return label;
        return `<a href="${escapeHtml(documentHref(path) + (hash ? `#${encodeURIComponent(hash)}` : ''))}">${label}</a>`;
      },
      image({ text }) {
        return escapeHtml(text);
      },
      heading({ depth, text, tokens }) {
        const id = text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_ -]/gu, '')
          .replaceAll(' ', '-');
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
    },
  });
  // frontmatter は設定の正本として残し、本文とは区切って読む。
  const matter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  const metadata = matter
    ? `<details><summary>文書の設定</summary><pre>${escapeHtml(matter[1])}</pre></details>`
    : '';
  const content = parser.parse(matter ? markdown.slice(matter[0].length) : markdown, {
    async: false,
  });
  return page(
    document,
    `<p><small>${escapeHtml(document)} · この読込時に正本を解決</small></p>${metadata}<article>${content}</article>`,
  );
}

export function catalogHtml(entries: DocumentEntry[]): string {
  const list = entries
    .map(
      (entry) =>
        `<li><a href="${escapeHtml(documentHref(entry.path, entry.origin === 'db-snapshot'))}">${escapeHtml(entry.path)}</a> <small>${escapeHtml(entry.origin === 'db-snapshot' ? 'DB の保存記録' : entry.origin)}</small></li>`,
    )
    .join('');
  return page(
    '文書一覧',
    `<h1>Dayopt のドキュメント</h1><p>${entries.length} 件。リンクを開くたびに正本から読み直します。</p><p><small>手書きの意味・判断はその文章が正本です。DB の保存記録は現在の状態を示しません。</small></p><ul>${list}</ul>`,
  );
}
