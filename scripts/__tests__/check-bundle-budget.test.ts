import { describe, expect, it } from 'vitest';

import {
  hasRealSupabaseCredentials,
  resolvePreviewCompensationKB,
} from '../tasks/check-bundle-budget';

/**
 * #2159: Supabase Preview Branch の実 credential が preview build に inline され、
 * 既存の Sentry 補正と二重計上になる偽陽性を防ぐロジックの単体テスト。
 * #2163: Sentry 成分（41 KB）と Supabase credential 成分（27 KB）を独立変数として
 * 実測・分離した恒久較正。値の実測根拠は check-bundle-budget.ts 側のコメントを正本とする。
 */
describe('hasRealSupabaseCredentials', () => {
  it('next.config.mjs の placeholder は実 credential とみなさない', () => {
    expect(hasRealSupabaseCredentials('https://placeholder.supabase.co')).toBe(false);
  });

  it('未設定（undefined）は実 credential とみなさない', () => {
    expect(hasRealSupabaseCredentials(undefined)).toBe(false);
  });

  it('空文字は実 credential とみなさない', () => {
    expect(hasRealSupabaseCredentials('')).toBe(false);
  });

  it('placeholder 以外の URL は実 credential とみなす', () => {
    expect(hasRealSupabaseCredentials('https://abcdefghijklmnop.supabase.co')).toBe(true);
  });
});

describe('resolvePreviewCompensationKB', () => {
  it('placeholder URL では Sentry 成分（41 KB）+ Supabase credential 成分（27 KB）の両方を適用する', () => {
    expect(resolvePreviewCompensationKB('https://placeholder.supabase.co')).toBe(68);
  });

  it('未設定では Sentry 成分（41 KB）+ Supabase credential 成分（27 KB）の両方を適用する', () => {
    expect(resolvePreviewCompensationKB(undefined)).toBe(68);
  });

  it('実 URL では credential 分が既にビルドへ inline 済みのため Sentry 成分（41 KB）のみを適用する', () => {
    expect(resolvePreviewCompensationKB('https://abcdefghijklmnop.supabase.co')).toBe(41);
  });

  it('固定Integrationでは計測済みSentryと実credentialを重複加算しない', () => {
    expect(
      resolvePreviewCompensationKB('https://tilwaprottpyhlfoggbb.supabase.co', 'integration'),
    ).toBe(0);
  });

  it('Sentryを含むIntegrationでもplaceholderのcredential補正は維持する', () => {
    expect(resolvePreviewCompensationKB('https://placeholder.supabase.co', 'integration')).toBe(27);
  });

  it('同じDBを共有する通常PreviewにはSentry補正を維持する', () => {
    expect(
      resolvePreviewCompensationKB('https://tilwaprottpyhlfoggbb.supabase.co', 'preview'),
    ).toBe(41);
  });
});
