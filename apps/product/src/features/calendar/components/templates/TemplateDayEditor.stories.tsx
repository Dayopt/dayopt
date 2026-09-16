import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';

import { TemplateDayEditor } from './TemplateDayEditor';
import type { TemplateBlockView } from './types';

const blocks: TemplateBlockView[] = [
  {
    id: 'b1',
    activityName: '集中作業',
    categoryColor: 'blue',
    categoryIcon: 'briefcase',
    anchorRatio: 0.1,
    medianDurationRatio: 0.3,
  },
  {
    id: 'b2',
    activityName: 'ランニング',
    categoryColor: 'teal',
    categoryIcon: 'footprints',
    anchorRatio: 0.45,
    medianDurationRatio: 0.15,
  },
];

/**
 * 「型を一日として開く」編集ビュー（v1.0 §5.4）。ポップアップではなく、
 * メインの表示領域そのものが置き換わる。ヘッダー右上の「上書き保存」
 * 「キャンセル」が常設され、専用エディタは持たない骨格を示す。
 */
const meta = {
  title: 'Product/Features/Calendar/Templates/TemplateDayEditor',
  component: TemplateDayEditor,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    templateName: '朝のルーティン',
    blocks,
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof TemplateDayEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function MainAreaFrame({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '600px' }}>{children}</div>;
}

/** 開いた直後（未保存、差分なし）。メインエリアがそのまま置き換わる。 */
export const JustOpened: Story = {
  render: (args) => (
    <MainAreaFrame>
      <TemplateDayEditor {...args} />
    </MainAreaFrame>
  ),
};

/** 編集して上書き保存した直後（ヘッダー直下に差分一行が出る）。 */
export const SavedWithDiff: Story = {
  render: (args) => (
    <MainAreaFrame>
      <TemplateDayEditor {...args} />
    </MainAreaFrame>
  ),
  args: {
    savedDiffSummary: 'ランニングの錨位置を30分後ろへ',
  },
};

export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">開いた直後</p>
        <MainAreaFrame>
          <article>
            <TemplateDayEditor
              templateName="朝のルーティン"
              blocks={blocks}
              onSave={fn()}
              onCancel={fn()}
            />
          </article>
        </MainAreaFrame>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">上書き保存後（ヘッダー直下に差分一行）</p>
        <MainAreaFrame>
          <article>
            <TemplateDayEditor
              templateName="朝のルーティン"
              blocks={blocks}
              savedDiffSummary="ランニングの錨位置を30分後ろへ"
              onSave={fn()}
              onCancel={fn()}
            />
          </article>
        </MainAreaFrame>
      </div>
    </div>
  ),
};
