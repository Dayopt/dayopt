import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkLearnRefs } from '../../tasks/docs-guard/checks/learn-refs.ts';
import { collectLearnData, listLearnRefs } from '../learn/data.ts';
import { buildLearnHtml } from '../learn/html.ts';
import { collectDocumentCatalog, documentPaths } from './catalog.ts';
import { catalogHtml, documentHref, documentHtml } from './html.ts';

const execute = promisify(execFile);

/** TS の正本と生成コードの ESM cache も request 間で共有しない。 */
async function readInFreshProcess(root: string, task: string, args: string[]): Promise<string> {
  const { stdout } = await execute(
    process.execPath,
    ['--import', 'tsx', resolve(root, `scripts/tasks/${task}.ts`), ...args],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

/** template と data も毎回取得する。保存 HTML を閲覧経路に入れない。 */
export function readLearnHtml(root: string): string {
  const result = collectLearnData(root);
  if (result.errors.length || !result.data)
    throw new Error(result.errors.join('\n') || 'Learning System の正本を取得できません');
  const references = checkLearnRefs(listLearnRefs(result), root);
  if (references.length)
    throw new Error(references.map((ref) => `${ref.ref}: ${ref.reason}`).join('\n'));
  return buildLearnHtml(
    readFileSync(resolve(root, 'scripts/lib/learn/ui/template.html'), 'utf8'),
    result.data,
    { documentBase: '/doc?path=' },
  ).replace('href="../docs/learn/README.md"', `href="${documentHref('docs/learn/README.md')}"`);
}

export function createDocumentationServer(root: string) {
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status: number, body: string, html = false) => {
      const scripts = html
        ? [...body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
            .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
            .join(' ')
        : '';
      response.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'unsafe-inline'; script-src ${scripts || "'none'"}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
      response.writeHead(status, {
        'Content-Type': `${html ? 'text/html' : 'text/plain'}; charset=utf-8`,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const port = (request.socket.address() as { port: number }).port;
    if (request.headers.host !== `127.0.0.1:${port}`) {
      send(403, 'この端末の閲覧 URL から開いてください');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, 'GET / HEAD のみ利用できます');
      return;
    }
    void (async () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') {
        send(200, catalogHtml(collectDocumentCatalog(root)), true);
        return;
      }
      if (url.pathname === '/learn') {
        send(200, await readInFreshProcess(root, 'learn', ['--html']), true);
        return;
      }
      const document = url.searchParams.get('path') ?? '';
      const paths = documentPaths(root);
      if (url.pathname !== '/doc' || !paths.includes(document)) {
        send(404, '登録された文書が見つかりません');
        return;
      }
      const content = await readInFreshProcess(root, 'read-docs', [
        document,
        ...(url.searchParams.get('snapshot') === '1' ? ['--snapshot'] : []),
      ]);
      send(200, documentHtml(document, content, paths), true);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`docs viewer: ${message}`);
      send(500, `正本から文書を表示できません。\n${message}`);
    });
  });
}
