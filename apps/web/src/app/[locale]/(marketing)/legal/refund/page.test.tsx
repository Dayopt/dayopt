// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../../messages/en/legal.json';
import ja from '../../../../../../messages/ja/legal.json';

import RefundPolicyPage, { generateMetadata } from './page';

vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale }: { locale: 'en' | 'ja' }) =>
    createTranslator({ locale, messages: locale === 'ja' ? ja : en }),
}));
vi.mock('@dayopt/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
afterEach(cleanup);

describe('refund policy review contract', () => {
  for (const locale of ['en', 'ja'] as const) {
    it(`${locale} の実ページで無料体験と解約の境界を表示する`, async () => {
      const params = Promise.resolve({ locale });
      const { container } = render(await RefundPolicyPage({ params }));
      const text = container.textContent;
      expect(text).toContain('45');
      expect(text).toMatch(/does not automatically charge|自動課金されません/);
      expect(text).toMatch(/mandatory rights|適用法による権利/);
      expect(text).toMatch(/HUMAN-07/);
      expect(text).toMatch(/HUMAN-08/);
      expect(text).not.toMatch(/confirmation email|確認メール/);
      expect(text).toMatch(/2026-09-17/);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelectorAll('h2')).toHaveLength(5);
      expect(Array.from(container.querySelectorAll('a'), (a) => a.getAttribute('href'))).toEqual([
        '/legal/terms',
        '/legal/privacy',
      ]);
      const metadata = await generateMetadata({ params });
      expect(metadata.title).toContain(locale === 'ja' ? '返金・解約' : 'Refund');
    });
  }
});
