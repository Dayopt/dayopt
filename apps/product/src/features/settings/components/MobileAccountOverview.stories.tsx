import type { BillingAccess } from '@dayopt/billing';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { BillingAccessContext } from '@/lib/billing/billing-access-context';
import { PRESET_AUTH } from '@dayopt/storybook/mocks/presets';
import { StoryTRPCProvider } from '@dayopt/storybook/mocks/trpc';

import type { BillingOverview } from '../server/billing-service';
import { MobileAccountOverview } from './MobileAccountOverview';

const BILLING_OVERVIEW: BillingOverview = {
  access: {
    state: 'not_started',
    canUseProduct: true,
    trialEndsAt: null,
    enforced: false,
  },
  billingInfo: {
    subscriptionStatus: 'free',
    stripeCustomerId: null,
    subscriptionId: null,
  },
  paymentMethod: null,
  invoices: [],
  trialEndsAt: null,
};

const FREE_ACCESS: BillingAccess = {
  state: 'not_started',
  canUseProduct: true,
  trialEndsAt: null,
  enforced: false,
};

const PRO_ACCESS: BillingAccess = {
  state: 'subscribed',
  canUseProduct: true,
  trialEndsAt: null,
  enforced: true,
};

const PRO_BILLING_OVERVIEW: BillingOverview = {
  ...BILLING_OVERVIEW,
  access: PRO_ACCESS,
  billingInfo: {
    subscriptionStatus: 'active',
    stripeCustomerId: 'cus_storybook',
    subscriptionId: 'sub_storybook',
  },
};

function MobileOverviewPreview({
  access,
  billingOverview,
  returnPath = '/',
  settingsReturnQuery = '?returnTo=%2F',
}: {
  access: BillingAccess;
  billingOverview: BillingOverview;
  returnPath?: string;
  settingsReturnQuery?: string;
}) {
  return (
    <StoryTRPCProvider mocks={{ 'billing.getOverview': billingOverview }}>
      <BillingAccessContext.Provider value={access}>
        <MobileAccountOverview returnPath={returnPath} settingsReturnQuery={settingsReturnQuery} />
      </BillingAccessContext.Provider>
    </StoryTRPCProvider>
  );
}

const meta = {
  title: 'Product/Features/Settings/MobileAccountOverview',
  component: MobileAccountOverview,
  parameters: {
    layout: 'fullscreen',
    storeMocks: { useAuthStore: PRESET_AUTH.authenticated },
    trpcMocks: { 'billing.getOverview': BILLING_OVERVIEW },
  },
  decorators: [
    (Story) => (
      <div className="border-border-subtle mx-auto flex h-screen w-full max-w-sm flex-col overflow-hidden border">
        <Story />
      </div>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof MobileAccountOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 無料ユーザー向け Pro 導線を含む設定トップ。 */
export const Default: Story = {
  args: {
    returnPath: '/',
    settingsReturnQuery: '?returnTo=%2F',
  },
};

/** Pro 利用中でアップグレード導線を表示しない状態。 */
export const ProPlan: Story = {
  render: (args) => (
    <MobileOverviewPreview
      access={PRO_ACCESS}
      billingOverview={PRO_BILLING_OVERVIEW}
      returnPath={args.returnPath}
      settingsReturnQuery={args.settingsReturnQuery}
    />
  ),
  args: {
    returnPath: '/',
    settingsReturnQuery: '?returnTo=%2F',
  },
};

/** 全グループと無料ユーザー向け Pro 導線を含むモバイル設定トップ。 */
export const AllPatterns: Story = {
  args: {
    returnPath: '/',
    settingsReturnQuery: '?returnTo=%2F',
  },
  render: (args) => (
    <MobileOverviewPreview
      access={FREE_ACCESS}
      billingOverview={BILLING_OVERVIEW}
      returnPath={args.returnPath}
      settingsReturnQuery={args.settingsReturnQuery}
    />
  ),
};
