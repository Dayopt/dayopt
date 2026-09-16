import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Button, RadioGroup, RadioGroupItem } from '@dayopt/components';
import { DestructiveFormDialog } from './destructive-form-dialog';

const meta = {
  title: 'Product/Components/Overlays/DestructiveFormDialog',
  component: DestructiveFormDialog,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  argTypes: {
    title: { control: 'text' },
    description: { control: 'text' },
    confirmLabel: { control: 'text' },
    responsive: { control: 'boolean' },
  },
} satisfies Meta<typeof DestructiveFormDialog>;

export default meta;
type Story = StoryObj;

/** 最小構成。短い説明 + 1行のフォーム */
export const Minimal: Story = {
  render: () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open
          </Button>
          <DestructiveFormDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="この項目を削除しますか？"
            description="取り消せません。"
          >
            <p className="text-muted-foreground text-sm">残りのデータは保持されます。</p>
          </DestructiveFormDialog>
        </>
      );
    }
    return <Demo />;
  },
};

/** フォーム付き。RadioGroup で戦略を選ばせる典型パターン */
export const WithForm: Story = {
  render: () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      const [strategy, setStrategy] = useState('delete');

      return (
        <>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open with form
          </Button>
          <DestructiveFormDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="タグを削除しますか？"
            description="関連タイムブロックが3件あります。どう扱うか選んでください。"
          >
            <RadioGroup value={strategy} onValueChange={setStrategy} className="space-y-2">
              <label htmlFor="r-delete" className="flex cursor-pointer items-center gap-4">
                <RadioGroupItem value="delete" id="r-delete" />
                <span className="text-sm">関連タイムブロックも削除する</span>
              </label>
              <label htmlFor="r-reassign" className="flex cursor-pointer items-center gap-4">
                <RadioGroupItem value="reassign" id="r-reassign" />
                <span className="text-sm">別のタグに付け替える</span>
              </label>
            </RadioGroup>
          </DestructiveFormDialog>
        </>
      );
    }
    return <Demo />;
  },
};

/** Loading 中の状態。両ボタン disable、confirm ボタンはローディングラベルに */
export const Loading: Story = {
  render: () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open (3s delay on confirm)
          </Button>
          <DestructiveFormDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={async () => {
              await new Promise((r) => setTimeout(r, 3000));
              setOpen(false);
            }}
            title="削除しますか？"
            description="確認ボタンを押すと3秒待機します。"
          >
            <p className="text-muted-foreground text-sm">削除中は両ボタンが無効化されます。</p>
          </DestructiveFormDialog>
        </>
      );
    }
    return <Demo />;
  },
};

/** responsive=true でモバイル時 Drawer。PC時は AlertDialog。モバイルビューポートで確認 */
export const Responsive: Story = {
  render: () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open responsive
          </Button>
          <DestructiveFormDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="マージしますか？"
            description="PC では中央に AlertDialog、モバイルでは Drawer で表示されます。"
            responsive
            confirmLabel="マージ"
          >
            <p className="text-muted-foreground text-sm">
              モバイルビューポートに切り替えて再度開いてください。
            </p>
          </DestructiveFormDialog>
        </>
      );
    }
    return <Demo />;
  },
};
