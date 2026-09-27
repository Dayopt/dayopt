import { serialize } from 'next-mdx-remote/serialize';
import { describe, expect, it } from 'vitest';

import { LEGAL_MDX_OPTIONS } from './legal-mdx-options';

describe('LEGAL_MDX_OPTIONS', () => {
  it('legal component の object literal props を保持する', async () => {
    const result = await serialize(
      '<PrivacyDocument data={{sections: {introduction: {title: "Introduction"}}}} />',
      LEGAL_MDX_OPTIONS,
    );

    expect(result.compiledSource).toContain('data: {');
    expect(result.compiledSource).toContain('Introduction');
  });

  it('危険な runtime global へのアクセスを拒否する', async () => {
    await expect(
      serialize('<PrivacyDocument data={{value: process.env.NODE_ENV}} />', LEGAL_MDX_OPTIONS),
    ).rejects.toThrow("Access to 'process'");
  });
});
