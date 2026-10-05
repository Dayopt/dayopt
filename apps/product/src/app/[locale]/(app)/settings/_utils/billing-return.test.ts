import { describe, expect, it } from 'vitest';

import { parseBillingReturn, removeBillingReturnParams } from './billing-return';

describe('parseBillingReturn', () => {
  it('Checkout 成功を検出する', () => {
    expect(parseBillingReturn(new URLSearchParams('success=true'))).toBe('checkout_success');
  });

  it('Checkout キャンセルを検出する', () => {
    expect(parseBillingReturn(new URLSearchParams('canceled=true'))).toBe('checkout_canceled');
  });

  it('Customer Portal からの復帰を検出する', () => {
    expect(parseBillingReturn(new URLSearchParams('portal_return=true'))).toBe('portal');
  });

  it('復帰 query が無ければ null を返す', () => {
    expect(parseBillingReturn(new URLSearchParams(''))).toBeNull();
    expect(parseBillingReturn(new URLSearchParams('view=week'))).toBeNull();
  });

  it("'true' 以外の値は復帰扱いしない", () => {
    expect(parseBillingReturn(new URLSearchParams('success=1'))).toBeNull();
    expect(parseBillingReturn(new URLSearchParams('portal_return=yes'))).toBeNull();
  });

  it('success と canceled が同時に来たら success を優先する', () => {
    expect(parseBillingReturn(new URLSearchParams('success=true&canceled=true'))).toBe(
      'checkout_success',
    );
  });
});

describe('removeBillingReturnParams', () => {
  it('復帰 query だけを取り除き、他は温存する', () => {
    const result = removeBillingReturnParams(
      new URLSearchParams('returnTo=%2F%3Fview%3Dweek&success=true&view=week'),
    );

    expect(result.get('success')).toBeNull();
    expect(result.get('returnTo')).toBe('/?view=week');
    expect(result.get('view')).toBe('week');
  });

  it('canceled と portal_return も取り除く', () => {
    const result = removeBillingReturnParams(
      new URLSearchParams('canceled=true&portal_return=true&view=week'),
    );

    expect(result.get('canceled')).toBeNull();
    expect(result.get('portal_return')).toBeNull();
    expect(result.get('view')).toBe('week');
  });

  it('元の URLSearchParams を破壊しない', () => {
    const original = new URLSearchParams('success=true');
    removeBillingReturnParams(original);

    expect(original.get('success')).toBe('true');
  });
});
