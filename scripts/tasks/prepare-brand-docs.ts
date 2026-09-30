import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishBrandDocuments } from '../lib/docs-live/publish-brand.ts';

const args = process.argv.slice(2);
if (args.length !== 1 || !['product', 'web'].includes(args[0]))
  throw new Error('Usage: tsx scripts/tasks/prepare-brand-docs.ts <product|web>');
void publishBrandDocuments(
  resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  args[0] as 'product' | 'web',
)
  .then(() => console.log(`brand docs: ${args[0]} の配布説明と zip を正本から生成しました`))
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
