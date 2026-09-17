import { describe, expect, it } from 'vitest';
import { hasExcludedMetaTag } from './story-test-collection';

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
