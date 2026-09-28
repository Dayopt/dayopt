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
    <div className="bg-card mx-auto w-80 rounded-2xl px-4 py-2 shadow-sm">
      <NoteSection label="メモ" icon={StickyNote} note={note} onNoteChange={setNote} />
    </div>
  );
}

/** 空の1行メモ入力欄。 */
export const Default: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => <NoteSectionDemo />,
};

/** 入力済みの1行メモ。 */
export const WithNote: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => <NoteSectionDemo initialNote="設計レビューで確認した内容を整理する。" />,
};

/** 主要状態の一覧。 */
export const AllPatterns: Story = {
  args: { label: 'メモ', note: '', onNoteChange: () => undefined },
  render: () => (
    <div className="flex flex-col gap-8">
      <NoteSectionDemo />
      <NoteSectionDemo initialNote="設計レビューで確認した内容を整理する。" />
    </div>
  ),
};
