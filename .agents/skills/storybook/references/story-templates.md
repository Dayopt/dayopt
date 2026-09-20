## Step 1: パスからレイヤーとテンプレートを決定

### UI Component

top-level は所有境界で決める（ADR-023）。共有 UI は `packages/components`、product 固有は `apps/product`。

| 物理位置                              | title prefix                                              |
| ------------------------------------- | --------------------------------------------------------- |
| `packages/components/src/<category>/` | `Shared/Components/<Category>/`（責務9category, ADR-022） |
| `apps/product/src/components/**`      | `Product/Components/`（Shell / Display / Feedback 等）    |

**layout**: `centered`
**モック**: 不要（props only）

```tsx
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { MyComponent } from './my-component';

const meta = {
  // 共有 UI なら 'Shared/Components/Actions/MyComponent'
  title: 'Product/Components/MyComponent',
  component: MyComponent,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof MyComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 基本的な使用例。 */
export const Default: Story = {
  args: {/* props */},
};

/** 無効状態。 */
export const Disabled: Story = {
  args: { disabled: true },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <MyComponent />
      <MyComponent disabled />
    </div>
  ),
};
```

#### 状態を持つ場合の Interactive Wrapper

```tsx
/** デフォルト状態。 */
export const Default: Story = {
  render: function DefaultStory() {
    const [value, setValue] = useState(false);
    return <MyComponent checked={value} onCheckedChange={setValue} />;
  },
};
```

---

### Feature Component

**パス**: `apps/product/src/features/*/components/`
**title**: `Product/Features/{feature名}/`
**layout**: `padded`
**モック**: `parameters.trpcMocks` + `parameters.storeMocks` で宣言

```tsx
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { PRESET_AUTH, PRESET_USER_SETTINGS } from '../../../.storybook/mocks/presets';
import { StoryTRPCProvider } from '../../../.storybook/mocks/trpc';

import { MyFeatureComponent } from './my-feature-component';

const meta = {
  title: 'Product/Features/Settings/MyFeatureComponent',
  component: MyFeatureComponent,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    trpcMocks: { 'userSettings.get': PRESET_USER_SETTINGS.default },
    storeMocks: { useAuthStore: PRESET_AUTH.authenticated },
  },
} satisfies Meta<typeof MyFeatureComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** デフォルト状態。 */
export const Default: Story = {};

/** ローディング状態。 */
export const Loading: Story = {
  parameters: { trpcPending: true },
};

/** エラー状態。 */
export const Error: Story = {
  parameters: {
    trpcError: { path: 'userSettings.get', code: 'INTERNAL_SERVER_ERROR' },
  },
};

/** 全パターン一覧。 */
export const AllPatterns: Story = {
  render: () => (
    <div className="space-y-12">
      <div>
        <StoryTRPCProvider mocks={{ 'userSettings.get': PRESET_USER_SETTINGS.default }}>
          <MyFeatureComponent />
        </StoryTRPCProvider>
      </div>
      <div>
        <StoryTRPCProvider pending>
          <MyFeatureComponent />
        </StoryTRPCProvider>
      </div>
    </div>
  ),
};
```

#### Feature Component のモック戦略

- **デフォルト**: `meta.parameters` に `trpcMocks` + `storeMocks` を宣言
- **Story固有データ**: 個別Storyの `parameters.trpcMocks` で上書き（default mocks とマージされる）
- **Loading/Error**: `parameters: { trpcPending: true }` / `parameters: { trpcError: {...} }`
- **AllPatterns内**: `<StoryTRPCProvider>` で直接ラップ。外側の providerDecorator の tRPC 層を上書きする（ネストした内側が勝つ）
- **詳細**: → `mocks.md`

---

### Foundation

**パス**: `packages/foundations/src/tokens/`
**title**: `Shared/Foundations/`
**layout**: `fullscreen`
**モック**: 不要
**テキスト見出し**: 許可（トークン可視化のため）

```tsx
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const meta = {
  title: 'Shared/Foundations/Colors',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

function ColorSwatch({
  tailwindClass,
  description,
}: {
  tailwindClass: string;
  description?: string;
}) {
  const token = tailwindClass.replace(/^(?:bg|text|border|ring)-/, '');
  return (
    <div className="flex items-center gap-4 py-2">
      <div
        className="border-border size-12 shrink-0 rounded-lg border"
        style={{ backgroundColor: `var(--${token})` }}
      />
      <div>
        <code className="text-sm font-medium">{tailwindClass}</code>
        {description && <p className="text-muted-foreground mt-1 text-xs">{description}</p>}
      </div>
    </div>
  );
}

/** Surface トークン。 */
export const Surfaces: Story = {
  render: () => (
    <div className="p-8">
      <h2 className="mb-6 text-xl font-medium">Surface Colors</h2>
      <ColorSwatch tailwindClass="bg-background" description="ページ地" />
      <ColorSwatch tailwindClass="bg-card" description="カード・パネル" />
    </div>
  ),
};
```

---

### Pattern

**パス**: `apps/storybook/.storybook/stories/patterns/`
**title**: 依存ベースで分ける（ADR-023）。`@dayopt/components` だけで再現できる pattern は
`Shared/Patterns/`、`@/`（product 内部: `@/components` / `@/lib` / `@/features`）に依存する
pattern は `Product/Patterns/`
**layout**: `fullscreen`
**モック**: 不要
**テキスト見出し**: 許可（パターンドキュメントのため）

```tsx
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Button } from '@dayopt/components';

const meta = {
  // shared 例。product 結合（@/ 依存）なら 'Product/Patterns/Feedback'
  title: 'Shared/Patterns/Actions',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** 使い分けガイド。 */
export const Overview: Story = {
  render: () => (
    <div className="p-8">
      <h1 className="mb-2 text-2xl font-medium">Feedback Patterns</h1>
      <p className="text-muted-foreground mb-8">
        ユーザーへのフィードバック。Toast、Alert、InlineMessage の使い分け。
      </p>
    </div>
  ),
};
```

---
