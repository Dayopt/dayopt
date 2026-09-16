import { OPEN_MENU_A11Y, verifyModalMenuFocus } from '../testing/modal-menu';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import {
  LogOut,
  Mail,
  MessageSquare,
  Plus,
  PlusCircle,
  Settings,
  User,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
} from '@dayopt/components';

/** DropdownMenu - ドロップダウンメニュー。ラベル使用ルールはGAFA準拠（Material Design 3, Apple HIG）。 */
const meta = {
  title: 'Shared/Components/Actions/DropdownMenu',
  component: DropdownMenu,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** アクションメニュー（ラベルなし）。編集/複製/削除などのアクションリスト、アクションは自明なのでラベル不要。 */
export const Default: Story = {
  parameters: { a11y: OPEN_MENU_A11Y },
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">アクション</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem>
          <User className="mr-2 size-4" />
          <span>プロフィール</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings className="mr-2 size-4" />
          <span>設定</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <LogOut className="mr-2 size-4" />
          <span>ログアウト</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // トリガーボタンをクリックしてメニューを開く
    const triggerButton = canvas.getByRole('button', { name: /アクション/i });
    await userEvent.click(triggerButton);

    // メニューアイテムが表示される（ポータル経由）
    const body = within(document.body);
    await expect(body.getByText('プロフィール')).toBeInTheDocument();
    await expect(body.getByText('設定')).toBeInTheDocument();
    await expect(body.getByText('ログアウト')).toBeInTheDocument();
    await verifyModalMenuFocus(triggerButton);
  },
};

/** ユーザーメニュー（ラベルあり）。ユーザー情報をラベルとして表示、誰のメニューかコンテキストを明示。 */
export const WithUserContext: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">マイアカウント</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>user@example.com</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <User className="mr-2 size-4" />
            <span>プロフィール</span>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings className="mr-2 size-4" />
            <span>設定</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <LogOut className="mr-2 size-4" />
          <span>ログアウト</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** サブメニュー（ラベルなし）。アクションの階層化。 */
export const WithSubMenu: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">メニューを開く</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <User className="mr-2 size-4" />
            <span>プロフィール</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserPlus className="mr-2 size-4" />
              <span>ユーザーを招待</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>
                <Mail className="mr-2 size-4" />
                <span>メール</span>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <MessageSquare className="mr-2 size-4" />
                <span>メッセージ</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <PlusCircle className="mr-2 size-4" />
                <span>その他...</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** 設定メニュー - チェックボックス（ラベルあり）。何を設定するか明示するためラベル必須。 */
export const WithCheckboxes: Story = {
  render: function CheckboxesStory() {
    const [showStatusBar, setShowStatusBar] = useState(true);
    const [showActivityBar, setShowActivityBar] = useState(false);
    const [showPanel, setShowPanel] = useState(false);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">表示設定</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>表示</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={showStatusBar} onCheckedChange={setShowStatusBar}>
            ステータスバー
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showActivityBar} onCheckedChange={setShowActivityBar}>
            アクティビティバー
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showPanel} onCheckedChange={setShowPanel}>
            パネル
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

/** 設定メニュー - ラジオボタン（ラベルあり）。何を選択するか明示するためラベル必須。 */
export const WithRadioGroup: Story = {
  render: function RadioGroupStory() {
    const [position, setPosition] = useState('bottom');

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">パネル位置</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>パネルの位置</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={position} onValueChange={setPosition}>
            <DropdownMenuRadioItem value="top">上</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="bottom">下</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="right">右</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

const sampleItems = [
  { id: '1', name: '仕事', color: 'red' },
  { id: '2', name: 'プライベート', color: 'blue' },
  { id: '3', name: '運動', color: 'green' },
  { id: '4', name: '読書', color: 'violet' },
  { id: '5', name: '学習', color: 'amber' },
];

/** 検索付きメニュー（ラベルなし）。検索フィールドがコンテキストを示すためラベル不要。 */
export const WithSearch: Story = {
  render: function SearchableDropdownStory() {
    const [searchQuery, setSearchQuery] = useState('');
    const [selected, setSelected] = useState<string[]>([]);

    const filteredItems = searchQuery
      ? sampleItems.filter((item) => item.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : sampleItems;

    const handleSelect = (id: string) => {
      setSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
    };

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-48 justify-between">
            <span>{selected.length > 0 ? `${selected.length}件選択中` : 'タグを選択'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 p-0">
          <div className="p-2">
            <Input
              placeholder="検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8"
              aria-label="Search tags"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filteredItems.length > 0 ? (
              filteredItems.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => handleSelect(item.id)}
                  className="flex items-center gap-2 p-2"
                >
                  <span className="size-3.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span>{item.name}</span>
                  {selected.includes(item.id) && <span className="text-primary ml-auto">✓</span>}
                </DropdownMenuItem>
              ))
            ) : (
              <div className="text-muted-foreground p-2 text-center text-sm">該当なし</div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="p-2">
            <Plus className="mr-2 size-4" />
            新規作成
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

/** 破壊的アクション（ラベルなし）。variant="destructive" で削除アクションを強調。 */
export const Destructive: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">アクション</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem>編集</DropdownMenuItem>
        <DropdownMenuItem>複製</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">削除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">アクション</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48">
          <DropdownMenuItem>編集</DropdownMenuItem>
          <DropdownMenuItem>複製</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">削除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">マイアカウント</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>user@example.com</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <User className="mr-2 size-4" />
              プロフィール
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Settings className="mr-2 size-4" />
              設定
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <LogOut className="mr-2 size-4" />
            ログアウト
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">表示設定</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>表示項目</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked>ステータスバー</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem>パネル</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">タグを選択</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56 p-0">
          <div className="p-2">
            <Input placeholder="検索..." className="h-8" aria-label="Search" />
          </div>
          <DropdownMenuItem className="p-2">仕事</DropdownMenuItem>
          <DropdownMenuItem className="p-2">プライベート</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

/** 閉じたトリガーを含む画面全体も a11y 検査する。 */
export const Closed: Story = { render: Default.render };
