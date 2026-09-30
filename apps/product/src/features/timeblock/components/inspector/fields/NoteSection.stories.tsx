import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { StickyNote } from 'lucide-react';

import { NoteSection } from './NoteSection';

const meta = {
  title: 'Product/Features/Timeblock/Inspector/NoteSection',
  component: NoteSection,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof NoteSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function NoteSectionDemo({ initialNote = '' }: { initialNote?: string | undefined }) {
  const [note, setNote] = useState(initialNote);
  return (
    <div className="bg-card mx-auto w-full max-w-sm rounded-2xl px-4 py-2 shadow-sm">
      <NoteSection label="メモ" icon={StickyNote} note={note} onNoteChange={setNote} />
    </div>
  );
}

/** 空の複数行メモ入力欄。 */
export const Default: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => <NoteSectionDemo />,
};

/** 1行の入力済みメモ。 */
export const WithNote: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => <NoteSectionDemo initialNote="設計レビューで確認した内容を整理する。" />,
};

/** 長いメモが内容に合わせて高さを伸ばす状態。 */
export const WithLongNote: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => (
    <NoteSectionDemo
      initialNote={[
        '午前の定例で確認する項目を整理する。',
        '前回のレビューで出た質問への回答を用意する。',
        '仕様の変更点を関係者に共有する。',
        '見積もりと実装の順序を確認する。',
      ].join('\n')}
    />
  ),
};

/** 主要状態と長いメモの全体スクロール。 */
export const AllPatterns: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => (
    <div className="flex max-h-[70vh] w-full max-w-sm flex-col gap-8 overflow-y-auto">
      <NoteSectionDemo />
      <NoteSectionDemo initialNote="設計レビューで確認した内容を整理する。" />
      <NoteSectionDemo
        initialNote={[
          '午前の定例で確認する項目を整理する。',
          '前回のレビューで出た質問への回答を用意する。',
          '仕様の変更点を関係者に共有する。',
          '見積もりと実装の順序を確認する。',
        ].join('\n')}
      />
    </div>
  ),
};
