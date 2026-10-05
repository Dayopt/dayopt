import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectDocumentCatalog,
  documentPaths,
  renderDocumentCatalog,
} from '../lib/docs-live/catalog.ts';
import { createDocumentReader } from '../lib/docs-live/reader.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const snapshot = args.includes('--snapshot');
  const positional = args.filter((arg) => arg !== '--snapshot');
  if (positional.length > 1)
    throw new Error(
      'Usage: pnpm docs:read [repo-relative Markdown path | --audit | --verify-all] [--snapshot]',
    );
  const document = positional[0] ?? 'README.md';
  if (document === '--audit') {
    process.stdout.write(renderDocumentCatalog(collectDocumentCatalog(root)));
    return;
  }
  const paths = documentPaths(root);
  const read = createDocumentReader(root);
  if (document === '--verify-all') {
    const results: string[] = [];
    for (const entry of collectDocumentCatalog(root)) {
      await read(entry.path, snapshot);
      const state =
        entry.origin === 'db-snapshot'
          ? 'SNAPSHOT'
          : entry.origin === 'source'
            ? 'SOURCE'
            : 'GENERATED';
      results.push(`${state} ${entry.path}`);
    }
    process.stdout.write(
      results.join('\n') +
        `\n${results.length} documents read/rendered; external state not verified\n`,
    );
    return;
  }
  if (!paths.includes(document))
    throw new Error('Git の管理対象または ignore されていない Markdown / MDX を指定してください');
  process.stdout.write(await read(document, snapshot));
}

void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
