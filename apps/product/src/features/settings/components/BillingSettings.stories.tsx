/**
 * BillingSettings Stories
 *
 * tRPC の billing.getOverview をモックして各プラン状態を再現する。
 * STRIPE_PRICE_ID は process.env からビルド時に埋め込まれるため、
 * Storybook の env 設定で NEXT_PUBLIC_STRIPE_PRO_PRICE_ID を制御。
 */

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type {
  BillingInfo,
  BillingOverview,
  InvoiceItem,
  PaymentMethod,
} from '../server/billing-service';

import { BillingSettings } from './BillingSettings';

// ─────────────────────────────────────────────────────────
// Mock Data
// ─────────────────────────────────────────────────────────

const FREE_BILLING_INFO: BillingInfo = {
  subscriptionStatus: 'free',
  stripeCustomerId: null,
  subscriptionId: null,
};

const PRO_BILLING_INFO: BillingInfo = {
  subscriptionStatus: 'active',
  stripeCustomerId: 'cus_mock_123',
  subscriptionId: 'sub_mock_456',
};

const TRIALING_BILLING_INFO: BillingInfo = {
  subscriptionStatus: 'trialing',
  stripeCustomerId: 'cus_mock_789',
  subscriptionId: 'sub_mock_trial',
};

const MOCK_PAYMENT_METHOD: PaymentMethod = {
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2028,
};

const MOCK_INVOICES: InvoiceItem[] = [
  {
    id: 'inv_001',
    date: '2026-03-01T00:00:00.000Z',
    amount: 500,
    currency: 'usd',
    status: 'paid',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock_001',
  },
  {
    id: 'inv_002',
    date: '2026-02-01T00:00:00.000Z',
    amount: 500,
    currency: 'usd',
    status: 'paid',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock_002',
  },
  {
    id: 'inv_003',
    date: '2026-01-01T00:00:00.000Z',
    amount: 500,
    currency: 'usd',
    status: 'paid',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock_003',
  },
];

const MOCK_INVOICES_JPY: InvoiceItem[] = [
  {
    id: 'inv_jpy_001',
    date: '2026-03-01T00:00:00.000Z',
    amount: 55000,
    currency: 'jpy',
    status: 'paid',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock_jpy_001',
  },
  {
    id: 'inv_jpy_002',
    date: '2026-02-01T00:00:00.000Z',
    amount: 55000,
    currency: 'jpy',
    status: 'paid',
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock_jpy_002',
  },
];

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeBillingMocks(
  billingInfo: BillingInfo,
  paymentMethod: PaymentMethod | null = null,
  invoices: InvoiceItem[] = [],
  trialEndsAt: string | null = null,
) {
  const overview: BillingOverview = {
    billingInfo,
    paymentMethod,
    invoices,
    trialEndsAt,
    access: {
      state:
        billingInfo.subscriptionStatus === 'free'
          ? trialEndsAt
            ? 'trial'
            : 'not_started'
          : billingInfo.subscriptionStatus === 'canceled'
            ? 'expired'
            : 'subscribed',
      canUseProduct: billingInfo.subscriptionStatus !== 'canceled',
      trialEndsAt,
      enforced: true,
    },
  };
  return {
    'billing.getOverview': overview,
    'billing.getInfo': billingInfo,
    'billing.getPaymentMethod': paymentMethod,
    'billing.getInvoices': invoices,
  };
}

// ─────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────

const meta = {
  title: 'Product/Features/Settings/BillingSettings',
  component: BillingSettings,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BillingSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────

/** 無料プランユーザー（デフォルト状態） */
export const FreePlan: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(FREE_BILLING_INFO),
  },
};

/** Proプラン（active）ユーザー。支払い方法・請求履歴・キャンセルセクション表示 */
export const ProPlan: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(PRO_BILLING_INFO, MOCK_PAYMENT_METHOD, MOCK_INVOICES),
  },
};

/** トライアル中ユーザー（trialing）。カード情報・請求履歴なし。試用期限を表示する */
export const TrialingPlan: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(TRIALING_BILLING_INFO, null, [], '2026-08-21T00:00:00.000Z'),
  },
};

/**
 * trialing だが Stripe から試用期限を取得できなかった場合。
 * Badge と説明文は従来どおり出て、期限の行だけが消える。
 */
export const TrialingPlanWithoutEndDate: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(TRIALING_BILLING_INFO, null, [], null),
  },
};

/** データ取得中（ローディング状態） */
export const Loading: Story = {
  parameters: {
    trpcPending: true,
  },
};

/** エラー状態（リトライボタン表示） */
export const ErrorState: Story = {
  parameters: {
    trpcError: {
      path: 'billing.getOverview',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch billing information',
    },
  },
};

/** Proプランだが請求書がまだない状態 */
export const ProNoInvoices: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(PRO_BILLING_INFO, MOCK_PAYMENT_METHOD, []),
  },
};

/** 日本円（JPY）での請求履歴 */
export const JpyCurrency: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(PRO_BILLING_INFO, MOCK_PAYMENT_METHOD, MOCK_INVOICES_JPY),
  },
};

/**
 * STRIPE_PRICE_ID が未設定でアップグレードボタンが disabled になる状態。
 *
 * 注意: NEXT_PUBLIC_STRIPE_PRO_PRICE_ID はビルド時に process.env から埋め込まれるため、
 * Storybook 上では .env.storybook で空にするか、ビルド設定で制御する。
 * デフォルトの Storybook 環境では未設定（空文字）のため、このストーリーは
 * 自動的に disabled 状態を表示する。
 */
export const StripeNotConfigured: Story = {
  parameters: {
    trpcMocks: makeBillingMocks(FREE_BILLING_INFO),
  },
};

/** Card-free trial with identical feature access. */
export const AppTrial: Story = {
  parameters: { trpcMocks: makeBillingMocks(FREE_BILLING_INFO, null, [], '2026-10-23T00:00:00Z') },
};
/** Saved calendar/report viewing remains available after expiry. */
export const AppTrialExpired: Story = {
  parameters: {
    trpcMocks: {
      ...makeBillingMocks(FREE_BILLING_INFO),
      'billing.getOverview': {
        billingInfo: FREE_BILLING_INFO,
        paymentMethod: null,
        invoices: [],
        trialEndsAt: '2026-09-08T00:00:00Z',
        access: {
          state: 'expired',
          canUseProduct: false,
          trialEndsAt: '2026-09-08T00:00:00Z',
          enforced: true,
        },
      },
    },
  },
};
