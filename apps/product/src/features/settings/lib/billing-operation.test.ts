/**
 * 支払い操作の失敗分岐が「client に届いた時点の error」で成立することを固定する。
 *
 * `serviceCode` を手で注入するtestは、`CLIENT_SAFE_SERVICE_CODES` の登録漏れを
 * 素通りさせる（#1937 は 6 code すべてが未登録のまま runtime で死んでいた）。
 * ここでは service層のthrowからerrorFormatterの出力までを production と同じ関数で辿り、
 * allowlist を実際に通過することまで含めて検証する。
 */
import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

import { ServiceError, handleServiceError } from '@/lib/trpc/errors';
import { formatTrpcError } from '@/lib/trpc/router';

import {
  BILLING_OPERATION_SERVICE_CODES,
  getBillingOperationErrorPresentation,
} from './billing-operation';

// allowlist外のcodeはINTERNAL_SERVER_ERRORへ落ちてSentryへ送られる。送信自体はこのtestの対象外。
vi.mock('@/lib/sentry', () => ({
  captureUnexpectedError: vi.fn(),
  isExpectedAuthError: () => false,
}));

type ClientError = { data: { serviceCode: string | undefined } };

/** service層のthrowから、clientが受け取るerror objectまでをproductionと同じ経路で再現する。 */
function toClientError(code: string): ClientError {
  try {
    handleServiceError(new ServiceError(code, 'billing operation failed'));
  } catch (thrown) {
    if (!(thrown instanceof TRPCError)) throw thrown;

    const formatted = formatTrpcError({
      error: thrown,
      shape: {
        code: -32600,
        data: { code: thrown.code, httpStatus: 409 },
        message: thrown.message,
      },
    });
    return { data: formatted.data };
  }

  throw new Error('handleServiceError must throw');
}

const GENERIC_RETRY = {
  closesBillingActions: false,
  messageKey: 'common.billingOperation.retryable',
  needsBillingPortal: false,
  retryable: true,
} as const;

const EXPECTED_PRESENTATIONS: Record<
  (typeof BILLING_OPERATION_SERVICE_CODES)[keyof typeof BILLING_OPERATION_SERVICE_CODES],
  ReturnType<typeof getBillingOperationErrorPresentation>
> = {
  BILLING_ACCOUNT_CLOSING: {
    closesBillingActions: true,
    messageKey: 'common.billingOperation.accountClosing',
    needsBillingPortal: false,
    retryable: false,
  },
  // 再試行しても必ず同じ失敗を返すので、portal を出口として案内する（#1945）
  BILLING_CHECKOUT_NOT_AVAILABLE: {
    closesBillingActions: false,
    messageKey: 'common.billingOperation.checkoutNotAvailable',
    needsBillingPortal: true,
    retryable: false,
  },
  BILLING_OPERATION_CONFLICT: GENERIC_RETRY,
  BILLING_OPERATION_INVALIDATED: {
    closesBillingActions: false,
    messageKey: 'common.billingOperation.restart',
    needsBillingPortal: false,
    retryable: false,
  },
  BILLING_RECOVERY_EXHAUSTED: {
    closesBillingActions: false,
    messageKey: 'common.billingOperation.restart',
    needsBillingPortal: false,
    retryable: false,
  },
  BILLING_RESPONSE_EXPIRED: {
    closesBillingActions: false,
    messageKey: 'common.billingOperation.restart',
    needsBillingPortal: false,
    retryable: false,
  },
};

describe('billing operationのserviceCode分岐', () => {
  it.each(Object.values(BILLING_OPERATION_SERVICE_CODES))(
    '%s はclientまで届き、対応する提示内容へ分岐する',
    (code) => {
      const clientError = toClientError(code);

      // allowlist未登録ならここでundefinedになり、分岐は既定枝へ落ちる
      expect(clientError.data.serviceCode).toBe(code);
      expect(getBillingOperationErrorPresentation(clientError)).toEqual(
        EXPECTED_PRESENTATIONS[code],
      );
    },
  );

  it('内部codeはclientへ出さず、汎用のretryableへ落とす', () => {
    const clientError = toClientError('BILLING_COMMAND_FAILED');

    expect(clientError.data.serviceCode).toBeUndefined();
    expect(getBillingOperationErrorPresentation(clientError)).toEqual(GENERIC_RETRY);
  });

  it('serviceCodeを持たないerrorはretryableへ落とす', () => {
    expect(getBillingOperationErrorPresentation(new Error('network down'))).toEqual(GENERIC_RETRY);
    expect(getBillingOperationErrorPresentation({ data: {} })).toEqual(GENERIC_RETRY);
  });
});
