import { expect, it } from 'vitest';
import { checkStoredLiveDocument, storedLiveBlock } from './live-contract.ts';

it('登録された生成領域に手書きの一覧を足すと拒否する', () => {
  const workspace = storedLiveBlock('README.md', 'workspace');
  const commands = storedLiveBlock('README.md', 'commands');
  expect(checkStoredLiveDocument('README.md', workspace + '\n' + commands)).toEqual([]);
  const handwritten = workspace.replace(
    '<!-- docs-live:workspace:end -->',
    '| apps/old | 古い説明 |\n<!-- docs-live:workspace:end -->',
  );
  expect(checkStoredLiveDocument('README.md', handwritten + '\n' + commands).join('\n')).toContain(
    '手書き',
  );
});

it('marker を両方消して手書きに戻しても拒否する', () => {
  expect(
    checkStoredLiveDocument(
      'README.md',
      '# Workspace\napps/old\n' + storedLiveBlock('README.md', 'commands'),
    ).join('\n'),
  ).toContain('workspace');
});

it('正しい marker の外でも同じ構造節に手書きの一覧を足すと拒否する', () => {
  const structure = '## 構造\n\n' + storedLiveBlock('packages/config/README.md', 'files');
  expect(
    checkStoredLiveDocument('packages/config/README.md', structure + '\n\n- old.ts').join('\n'),
  ).toContain('手書き');
  expect(
    checkStoredLiveDocument(
      'packages/config/README.md',
      structure + '\n\n| File | 説明 |\n| --- | --- |\n| old.ts | 古い説明 |',
    ).join('\n'),
  ).toContain('手書き');
  expect(
    checkStoredLiveDocument(
      'packages/config/README.md',
      structure + '\n\nFile | 説明\n--- | ---\nold.ts | 古い説明',
    ).join('\n'),
  ).toContain('手書き');
  expect(
    checkStoredLiveDocument(
      'packages/config/README.md',
      structure + '\n\n## 判断理由\n\n- 人が決める理由',
    ),
  ).toEqual([]);
});

it('未登録領域・重複・対応不正を拒否し、コード例や意味を持つ文章は許可する', () => {
  const commands = storedLiveBlock('notes.md', 'commands');
  expect(checkStoredLiveDocument('notes.md', commands).join('\n')).toContain('未登録');
  expect(
    checkStoredLiveDocument(
      'notes.md',
      '```md\n' + commands + '\n```\n\n## 判断理由\n人が決める理由',
    ),
  ).toEqual([]);
  const normal =
    storedLiveBlock('README.md', 'workspace') + '\n' + storedLiveBlock('README.md', 'commands');
  expect(
    checkStoredLiveDocument(
      'README.md',
      normal + '\n' + storedLiveBlock('README.md', 'commands'),
    ).join('\n'),
  ).toContain('重複');
  expect(
    checkStoredLiveDocument('README.md', normal.replace('workspace:end', 'files:end')).length,
  ).toBeGreaterThan(0);
});

it('factsの保存本文・marker削除・節外への定義コピーを拒否する', () => {
  const document = 'docs/operations/product-analytics.md';
  const block = storedLiveBlock(document, 'facts');
  expect(checkStoredLiveDocument(document, block)).toEqual([]);
  expect(
    checkStoredLiveDocument(
      document,
      block.replace('<!-- docs-live:facts:end -->', 'event数 = 6\n<!-- docs-live:facts:end -->'),
    ).join('\n'),
  ).toContain('手書き');
  expect(checkStoredLiveDocument(document, '# 現状\n6種類')).toContain(
    'facts: 登録済み生成領域の marker がありません',
  );
  expect(
    checkStoredLiveDocument(
      document,
      '## 機械取得する現状\n\n' + block + '\n\n```ts\nconst count = 6;\n```',
    ).join('\n'),
  ).toContain('手書き');
});
