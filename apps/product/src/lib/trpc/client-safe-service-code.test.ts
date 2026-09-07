import { describe, expect, it } from 'vitest';

import { getClientSafeServiceCode } from './client-safe-service-code';
import { ServiceError } from './errors';

describe('getClientSafeServiceCode', () => {
  it('Timeblock UIが必要な競合codeだけを公開する', () => {
    expect(getClientSafeServiceCode(new ServiceError('STALE_VERSION', 'updated elsewhere'))).toBe(
      'STALE_VERSION',
    );
    expect(getClientSafeServiceCode(new ServiceError('TIME_OVERLAP', 'overlap'))).toBe(
      'TIME_OVERLAP',
    );
  });

  // 時刻規則（DT003 / DT005）の拒否。ここから外すと UI の写しを消せなくなる（#2628）
  it('時刻規則の拒否codeを公開する', () => {
    expect(
      getClientSafeServiceCode(new ServiceError('RECORD_IN_FUTURE', 'records cannot end later')),
    ).toBe('RECORD_IN_FUTURE');
    expect(
      getClientSafeServiceCode(new ServiceError('INVALID_TIME_RANGE', 'end before start')),
    ).toBe('INVALID_TIME_RANGE');
  });

  // 登録漏れは EmailChangeDialog / AccountDeletionDialog の「パスワードが違います」分岐を
  // 丸ごと殺す（#1937 と同型の事故が #2024 で一度実際に起きた）
  it('パスワード再認証の失敗（INVALID_PASSWORD）を公開する', () => {
    expect(getClientSafeServiceCode(new ServiceError('INVALID_PASSWORD', 'Invalid password'))).toBe(
      'INVALID_PASSWORD',
    );
  });

  it('他機能の内部codeは公開しない', () => {
    expect(
      getClientSafeServiceCode(new ServiceError('STRIPE_NOT_CONFIGURED', 'internal detail')),
    ).toBeUndefined();
    expect(getClientSafeServiceCode(new Error('unknown'))).toBeUndefined();
  });
});
