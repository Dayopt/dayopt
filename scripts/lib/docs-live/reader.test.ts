import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDocumentReader, documentOrigin } from './reader.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-reader-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('生成 marker のコード例を生成先として扱わない', () => {
  expect(documentOrigin('```md\n<!-- learn:generated:start -->\n```')).toBe('source');
});

it('既存の生成先は marker/冒頭の宣言を消しても手書き本文へ格下げしない', () => {
  expect(documentOrigin('古い本文', 'docs/product/glossary.md')).toBe('glossary');
  expect(documentOrigin('古い本文', 'docs/engineering/data/architecture-inventory.md')).toBe(
    'architecture',
  );
  expect(documentOrigin('古い本文', 'docs/engineering/data/db/rls-snapshot.md')).toBe(
    'db-snapshot',
  );
});

it('保存型の生成本文も正本から読取り、次の読取で古い結果を再利用しない', async () => {
  const saved = '<!-- glossary:generated:start -->\n\n古い本文\n';
  writeFileSync(join(root, 'docs/glossary.md'), saved);
  writeFileSync(join(root, 'source.json'), '{"term":"新しい語"}');
  const builders = {
    glossary: async () => [
      {
        path: 'docs/glossary.md',
        content: JSON.parse(readFileSync(join(root, 'source.json'), 'utf8')).term as string,
      },
    ],
  };
  expect(await createDocumentReader(root, builders)('docs/glossary.md')).toBe('新しい語');
  writeFileSync(join(root, 'source.json'), '{"term":"変更した語"}');
  expect(await createDocumentReader(root, builders)('docs/glossary.md')).toBe('変更した語');
  expect(readFileSync(join(root, 'docs/glossary.md'), 'utf8')).toBe(saved);
  writeFileSync(join(root, 'source.json'), '{');
  await expect(createDocumentReader(root, builders)('docs/glossary.md')).rejects.toThrow();
});

it('生成器の対象外になった生成ファイルを古い本文で代替しない', async () => {
  writeFileSync(join(root, 'docs/orphan.md'), '<!-- architecture-map:er:start -->');
  await expect(
    createDocumentReader(root, { architecture: async () => [] })('docs/orphan.md'),
  ).rejects.toThrow('出力しません');
});

it('DB snapshot を現在として返さず、記録として明示した時だけ読む', async () => {
  writeFileSync(
    join(root, 'docs/rls.md'),
    '# RLS\n\n> **生成元**: `scripts/tasks/generate-rls-snapshot.ts`\n記録\n',
  );
  await expect(createDocumentReader(root)('docs/rls.md')).rejects.toThrow('--snapshot');
  expect(await createDocumentReader(root)('docs/rls.md', true)).toContain(
    'この本文は DB の現在状態を取得していません',
  );
});

it('配布用ブランド説明の古いコピーを返さず、毎回正本を読み、正本が無ければ失敗する', async () => {
  const copy = 'apps/web/public/brand/README.md';
  mkdirSync(join(root, 'apps/web/public/brand'), { recursive: true });
  mkdirSync(join(root, 'docs/business'), { recursive: true });
  writeFileSync(join(root, copy), '古いコピー');
  writeFileSync(join(root, 'docs/business/brand.md'), '新しいブランド説明');
  expect(documentOrigin('古いコピー', copy)).toBe('brand');
  expect(await createDocumentReader(root)(copy)).toBe('新しいブランド説明');
  writeFileSync(join(root, 'docs/business/brand.md'), '変更したブランド説明');
  expect(await createDocumentReader(root)(copy)).toBe('変更したブランド説明');
  expect(readFileSync(join(root, copy), 'utf8')).toBe('古いコピー');
  rmSync(join(root, copy));
  expect(await createDocumentReader(root)(copy)).toBe('変更したブランド説明');
  rmSync(join(root, 'docs/business/brand.md'));
  await expect(createDocumentReader(root)(copy)).rejects.toThrow();
});
