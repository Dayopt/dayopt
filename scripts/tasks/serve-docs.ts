import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocumentationServer } from '../lib/docs-live/doc-server.ts';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';

export async function serveDocumentation(root: string, page = '/', noOpen = false): Promise<void> {
  const server = createDocumentationServer(root);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('閲覧 URL を取得できません');
  const url = `http://127.0.0.1:${address.port}${page}`;
  console.log(`閲覧: ${url}\n読むたびに正本を取得します。終了は Ctrl+C。`);
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (noOpen) return;
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawnSync(opener, [url], { stdio: 'ignore' });
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--no-open'))
    throw new Error('Usage: pnpm docs:serve [--no-open]');
  void serveDocumentation(
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    '/',
    args.includes('--no-open'),
  ).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
