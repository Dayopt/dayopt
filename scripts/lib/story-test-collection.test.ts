import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasExcludedMetaTag, parseCollectedStoryFiles } from './story-test-collection';

describe('Vitest Story file collection', () => {
  it('両テーマの一覧を分け、MDX・ログを除外して空白を含むパスを保持する', () => {
    const root = path.resolve('apps/product');
    const output = [
      '[storybook (chromium)] src/Story name.stories.tsx',
      '[storybook (chromium)] ../web/src/Web.docs.mdx',
      '[storybook-dark (chromium)] src/Dark.stories.tsx',
      '[WARN] logs',
    ].join('\n');
    expect([...parseCollectedStoryFiles(output, root, 'storybook')]).toEqual([
      path.resolve(root, 'src/Story name.stories.tsx'),
    ]);
    expect([...parseCollectedStoryFiles(output, root, 'storybook-dark')]).toEqual([
      path.resolve(root, 'src/Dark.stories.tsx'),
    ]);
  });

  it('browser collect のテスト名を取り除き、重複をまとめる', () => {
    const root = path.resolve('apps/storybook');
    const output = [
      '[storybook (chromium)] ../product/src/Button.stories.tsx > Default',
      '[storybook (chromium)] ../product/src/Button.stories.tsx > Click test',
    ].join('\n');
    expect([...parseCollectedStoryFiles(output, root, 'storybook')]).toEqual([
      path.resolve(root, '../product/src/Button.stories.tsx'),
    ]);
  });

  it('空一覧を期待集合で補わない', () => {
    expect(parseCollectedStoryFiles('', path.resolve('.'), 'storybook').size).toBe(0);
  });
});

describe('Storybook collection metadata', () => {
  it('個別の展示 Story は同じファイルの検証対象を消さない', () => {
    expect(
      hasExcludedMetaTag(
        `const meta = { tags: ['autodocs'] } satisfies Meta; export default meta; export const Default = {}; export const AllPatterns = { tags: ['docs-only'] };`,
        ['docs-only', 'wip'],
      ),
    ).toBe(false);
  });
  it.each([
    "const meta = { tags: ['docs-only'] } satisfies Meta; export default meta;",
    "export default ({ tags: ['wip'] } as Meta);",
    "const custom = { 'tags': ['docs-only'] }; export default custom;",
  ])('meta の明示的な除外だけを認識する', (source) => {
    expect(hasExcludedMetaTag(source, ['docs-only', 'wip'])).toBe(true);
  });
  it('読めない meta は収集を要求する側に倒す', () => {
    expect(hasExcludedMetaTag('export default importedMeta;', ['docs-only'])).toBe(false);
  });
});
