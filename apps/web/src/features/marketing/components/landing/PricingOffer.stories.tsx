import { appTrialDays, dayoptPricing } from '@dayopt/billing';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import en from '../../../../../messages/en/marketing.json';
import ja from '../../../../../messages/ja/marketing.json';
import { PricingOffer } from './PricingOffer';

const japanese = {
  ...ja.marketing.pricing.singlePlan,
  trial: ja.marketing.pricing.singlePlan.trial.replace('{days}', String(appTrialDays)),
};
const english = {
  ...en.marketing.pricing.singlePlan,
  trial: en.marketing.pricing.singlePlan.trial.replace('{days}', String(appTrialDays)),
};

const meta = {
  title: 'Web/Sections/PricingOffer',
  component: PricingOffer,
  parameters: { layout: 'padded' },
  args: { price: dayoptPricing.pro.displayPrice, copy: japanese },
} satisfies Meta<typeof PricingOffer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 一つの料金と、体験・購入・保存済みデータの条件を並べる。 */
export const Japanese: Story = {};

/** 英語の文章量と改行を確認する。 */
export const English: Story = { args: { copy: english } };

/** 全ロケールの表示を確認する。 */
export const AllPatterns: Story = {
  render: (args) => (
    <div className="bg-background text-foreground flex flex-col gap-16">
      <div lang="ja">
        <PricingOffer {...args} copy={japanese} />
      </div>
      <div lang="en">
        <PricingOffer {...args} copy={english} />
      </div>
    </div>
  ),
};
