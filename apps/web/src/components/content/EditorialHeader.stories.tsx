import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import styles from './ContentDesign.module.css';
import { EditorialHeader } from './EditorialHeader';
import { TimeArtwork } from './TimeArtwork';

const meta = {
  title: 'Web/Content/EditorialHeader',
  component: EditorialHeader,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className={styles.page}>
        <Story />
      </div>
    ),
  ],
  args: {
    eyebrow: 'Dayopt Journal',
    title: '時間を考える。日々をつくる。',
    description: '時間の使い方、Dayopt の考え方、つくる過程。',
    artwork: true,
  },
} satisfies Meta<typeof EditorialHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

/** タイトル・導入・時間の図版を配置する。 */
export const AllPatterns: Story = {};
/** 英語の長いタイトルを確認する。 */
export const English: Story = {
  args: {
    title: 'Thoughts on time. Room for a better day.',
    description: 'Ideas for spending time, the thinking behind Dayopt, and notes from building it.',
  },
};
/** 法的本文へ続く静かな導入。 */
export const Policy: Story = {
  args: { eyebrow: 'ポリシーと透明性', title: 'プライバシーポリシー', artwork: false },
};
/** 4種の時間の図版。 */
export const Artwork: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-6">
      {[0, 1, 2, 3].map((variant) => (
        <TimeArtwork key={variant} variant={variant} />
      ))}
    </div>
  ),
};
