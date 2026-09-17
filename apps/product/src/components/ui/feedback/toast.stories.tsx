import { toast } from '@/lib/toast';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Button } from '@dayopt/components';
import { Toaster } from './toast';

const meta = {
  title: 'Product/Components/Feedback/Toast',
  component: Toaster,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 成功トーストの各パターン。 */
export const Success: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button variant="outline" onClick={() => toast.success('保存しました')}>
        保存
      </Button>
      <Button variant="outline" onClick={() => toast.success('追加しました')}>
        タイムブロック作成
      </Button>
      <Button variant="outline" onClick={() => toast.success('更新しました')}>
        タイムブロック更新
      </Button>
      <Button variant="outline" onClick={() => toast.success('複製しました')}>
        タイムブロック複製
      </Button>
      <Button variant="outline" onClick={() => toast.success('コピーしました')}>
        コピー
      </Button>
      <Button variant="outline" onClick={() => toast.success('テンプレートを保存しました')}>
        テンプレート保存
      </Button>
      <Button variant="outline" onClick={() => toast.success('テンプレートを適用しました')}>
        テンプレート適用
      </Button>
      <Button variant="outline" onClick={() => toast.success('Proプランに変更しました')}>
        プラン変更
      </Button>
      <Button variant="outline" onClick={() => toast.success('オンラインに復帰しました')}>
        オンライン復帰
      </Button>
    </div>
  ),
};

/** エラートーストの各パターン。 */
export const Error: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button
        variant="outline"
        onClick={() => toast.error('問題が起きました。もう一度お試しください')}
      >
        汎用エラー
      </Button>
      <Button variant="outline" onClick={() => toast.error('保存できませんでした')}>
        保存失敗
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error('追加できませんでした。もう一度お試しください')}
      >
        作成失敗
      </Button>
      <Button variant="outline" onClick={() => toast.error('この名前は既に使用されています')}>
        重複エラー
      </Button>
    </div>
  ),
};

/** アクション付きトースト。 */
export const WithAction: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button
        variant="outline"
        onClick={() =>
          toast.success('削除しました', {
            action: { label: '元に戻す', onClick: () => toast.success('復元しました') },
          })
        }
      >
        削除 + Undo
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.success('エクスポート完了', {
            action: { label: 'ダウンロード', onClick: () => toast.success('ダウンロード開始') },
          })
        }
      >
        エクスポート + ダウンロード
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.error('保存できませんでした', {
            action: { label: 'リトライ', onClick: () => toast.success('保存しました') },
          })
        }
      >
        エラー + リトライ
      </Button>
    </div>
  ),
};

/** ローディングから成功への遷移。 */
export const Loading: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button
        variant="outline"
        onClick={() => {
          const toastId = toast.loading('処理中...');
          setTimeout(() => {
            toast.success('完了しました', { id: toastId });
          }, 2000);
        }}
      >
        Loading → Success
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const id = toast.loading('エクスポート中...');
          setTimeout(() => {
            toast.success('エクスポート完了', {
              id,
              action: { label: 'ダウンロード', onClick: () => toast.success('ダウンロード開始') },
            });
          }, 2000);
        }}
      >
        Loading → Success + Action
      </Button>
    </div>
  ),
};

/** Promise統合パターン。 */
export const PromiseIntegration: Story = {
  name: 'Promise',
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      <Button
        variant="outline"
        onClick={() => {
          const promise = new Promise((resolve) => setTimeout(resolve, 2000));
          toast.promise(promise, {
            loading: '保存中...',
            success: '保存しました',
            error: '保存できませんでした',
          });
        }}
      >
        Promise（成功）
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const promise = new Promise((_resolve, reject) => setTimeout(reject, 2000));
          toast.promise(promise, {
            loading: '送信中...',
            success: '送信しました',
            error: '送信できませんでした',
          });
        }}
      >
        Promise（失敗）
      </Button>
    </div>
  ),
};

/** トースト差し替えのデモ。 */
export const SingleToastReplace: Story = {
  render: () => {
    let count = 0;
    return (
      <div className="flex flex-wrap gap-2 p-4">
        <Button
          variant="outline"
          onClick={() => {
            count += 1;
            toast.success(`操作 ${count} を実行しました`);
          }}
        >
          連続クリックで差し替え確認
        </Button>
      </div>
    );
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-4 p-4">
      <Button variant="outline" onClick={() => toast.success('保存しました')}>
        Success
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error('問題が起きました。もう一度お試しください')}
      >
        Error
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.success('削除しました', {
            action: { label: '元に戻す', onClick: () => toast.success('復元しました') },
          })
        }
      >
        WithAction (Undo)
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.success('エクスポート完了', {
            action: { label: 'ダウンロード', onClick: () => toast.success('ダウンロード開始') },
          })
        }
      >
        WithAction (Download)
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const toastId = toast.loading('処理中...');
          setTimeout(() => {
            toast.success('完了しました', { id: toastId });
          }, 2000);
        }}
      >
        Loading → Success
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const promise = new Promise((resolve) => setTimeout(resolve, 2000));
          toast.promise(promise, {
            loading: '保存中...',
            success: '保存しました',
            error: '保存できませんでした',
          });
        }}
      >
        Promise
      </Button>
    </div>
  ),
};
