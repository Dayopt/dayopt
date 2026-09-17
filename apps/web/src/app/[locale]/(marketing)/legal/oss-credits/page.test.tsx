// @vitest-environment happy-dom
/**
 * OSS クレジットページが Dayopt のリポジトリへリンクしない契約。
 *
 * リポジトリは private 化する（2026-09-14 決定）ため、外部の閲覧者からは 404 になる。
 * 第三者パッケージの repository リンクは対象外で、Dayopt 自身へのリンクだけを禁じる。
 */
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OSSCreditsPage from './page';

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = () =>
    JSON.stringify([
      {
        name: 'example-package',
        version: '1.0.0',
        license: 'MIT',
        repository: 'https://github.com/example/example-package',
      },
    ]);
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

afterEach(() => {
  cleanup();
});

describe('OSS credits page', () => {
  it('Dayopt のリポジトリへリンクせず、THIRD_PARTY_NOTICES と第三者の repository は残す', async () => {
    const page = await OSSCreditsPage({ params: Promise.resolve({ locale: 'en' }) });
    const { container } = render(page);

    const hrefs = Array.from(container.querySelectorAll('a')).map(
      (anchor) => anchor.getAttribute('href') ?? '',
    );
    expect(hrefs.filter((href) => /github\.com\/Dayopt\//i.test(href))).toEqual([]);
    expect(hrefs).toEqual([
      'https://github.com/example/example-package',
      '/THIRD_PARTY_NOTICES.txt',
    ]);
  });
});
