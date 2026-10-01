import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ErrorLayout } from './ErrorLayout';
const meta = {
  title: 'Web/Content/ErrorLayout',
  component: ErrorLayout,
  parameters: { layout: 'fullscreen' },
  args: {
    code: '404',
    title: 'Page not found',
    description: "We couldn't find the page you're looking for.",
  },
} satisfies Meta<typeof ErrorLayout>;
export default meta;
type Story = StoryObj<typeof meta>;
/** 見つからないページから、Home/Docs/Support に戻る入口。 */
export const AllPatterns: Story = {};
/** 日本語の長い説明と戻る導線。 */
export const Japanese: Story = {
  args: {
    title: 'ページが見つかりません',
    description: 'お探しのページは見つかりませんでした。ホームから、必要な情報を探してください。',
    backToHomeLabel: 'ホームに戻る',
    contactLabel: 'お問い合わせ',
    docsLabel: 'ドキュメント',
  },
};
