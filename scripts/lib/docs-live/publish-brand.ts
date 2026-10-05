import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDeterministicZip } from '../create-deterministic-zip.ts';
import { BRAND_DOCUMENT_SOURCE, BRAND_DOCUMENT_TARGETS } from './brand-document.ts';
import { renderLiveDocument } from './render.ts';

/** 配布文書と zip を、同じビルドの正本から作る。画像・SVG の内容は変更しない。 */
export async function publishBrandDocuments(root: string, app: 'product' | 'web'): Promise<void> {
  const document = BRAND_DOCUMENT_TARGETS.find((path) => path.startsWith(`apps/${app}/`));
  if (!document) throw new Error('未知の配布先です');
  const content = renderLiveDocument(root, BRAND_DOCUMENT_SOURCE);
  const destination = dirname(resolve(root, document));
  if ((await realpath(destination)) !== resolve(await realpath(root), dirname(document)))
    throw new Error('配布先の symlink は使用できません');
  const entries = await readdir(destination, { withFileTypes: true });
  const assets = entries.filter(
    (entry) => !entry.name.endsWith('.zip') && entry.name !== 'README.md',
  );
  if (!assets.length || assets.some((entry) => !entry.isFile()))
    throw new Error('配布資産の実ファイルがありません');
  const staging = await mkdtemp(join(tmpdir(), 'dayopt-brand-docs-'));
  const archive = 'dayopt-brand-F.zip';
  // rename は同じ filesystem で行う（/tmp が別 mount の CI でも動く）。
  const stagedReadme = join(destination, '.README.generated.tmp');
  const stagedArchive = join(destination, '.brand.generated.tmp');
  try {
    for (const entry of assets)
      await copyFile(join(destination, entry.name), join(staging, entry.name));
    await writeFile(join(staging, 'README.md'), content);
    await createDeterministicZip(
      staging,
      archive,
      ['README.md', ...assets.map((entry) => entry.name)].sort(),
    );
    await writeFile(stagedReadme, content);
    await writeFile(stagedArchive, await readFile(join(staging, archive)));
    await rename(stagedReadme, join(destination, 'README.md'));
    await rename(stagedArchive, join(destination, archive));
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(stagedReadme, { force: true });
    await rm(stagedArchive, { force: true });
  }
}
