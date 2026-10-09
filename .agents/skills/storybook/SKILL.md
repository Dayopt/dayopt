---
name: storybook
description: Story の追加・表示状態の更新、または新しい design token の選択時に使う。既存例を流用し、新設・token・mock の詳細は必要な資料だけ読む。文言だけの修正や表示に影響しない内部ロジック変更は対象外。
effort: medium
maxTurns: 15
---

# Storybook Story作成スキル

## When to Use

以下の状況で発動:

- `*.stories.tsx` ファイルを新規作成する時、既存ファイルに表示例を追加する時
- 既存 component に props / variant / state を追加した後、Story 側に反映する時
- Figma デザイン変更を component に反映した後、AllPatterns Story を更新する時
- 新しい Foundation / Pattern（トークン、レイアウト規則）を定義して Storybook で可視化する時
- `packages/components/src/` 配下の UI component を新規追加する時
- UI 実装中に spacing / icon size / z-index / radius / motion / elevation のどの値を使うべきか判断する時（→ §Design Token 選択ガイド）

## When NOT to Use

- 既存 Story の文言・コメント・説明テキストのみを修正する時（regression リスクなし）
- Component の internal logic のみ変更し、表示 props / variant / state が変わらない時（Story 再生成不要）
- 参考 UI やデザイン素材をライブラリから探す時（`mcp-usage` skill の Eagle 節に従う。この skill は Story 作成規約と token 選択まで）

## 絶対ルール

1. **セマンティックトークンのみ**。直接カラー禁止。これだけでダークモード対応完了
2. **全Storyファイルに AllPatterns Story 必須**
3. **Canvas にテキスト説明を入れない**（AllPatterns含む。Foundations/Patterns 除く）
4. **play 関数はユーザー操作で状態が変わるコンポーネントにのみ書く**

---

## 必要な資料だけ読む

- 既存 Story への単純な args 追加は、同じファイルの既存 Story と下記共通ルールを流用する。
- 新しい token を選ぶ時は [Design Token 選択ガイド](references/design-tokens.md)。
- Story ファイル新設、レイヤー・layout・provider 構成を変える時は [Story テンプレート](references/story-templates.md)。既存ファイルへの args 追加だけではレイヤーを変更しない。
- backend 依存を mock する時は [mock 手順](references/mocks.md)。

検証は変更に応じて対象ファイルの lint・型検査・Storybook を選ぶ。既存の表示例を追加するだけで新しい操作テストを作らない。新しい挙動は対応する Story で操作・表示結果を確認する。ready 化前の検査は `AGENTS.md` に従う。

## 共通ルール

### CSF3 + satisfies Meta

```tsx
const meta = { ... } satisfies Meta<typeof MyComponent>;
export default meta;
type Story = StoryObj<typeof meta>;
```

### JSDoc

1行で簡潔に。末尾に句点。

```tsx
/** 基本的な削除確認ダイアログ。最小構成の例。 */
export const Default: Story = { ... };
```

### play 関数

ユーザー操作で状態が変わるコンポーネント（フォーム、トグル等）にのみ使用。

```tsx
import { expect, userEvent, within } from 'storybook/test';

export const ClickTest: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button'));
    await expect(canvas.getByRole('button')).toHaveAttribute('data-clicked', 'true');
  },
};
```

---

## 運用ルールとチェックリスト

コンポーネントの追加・props / variant 変更時の Story 同期と、作成後のチェックリストは [storybook.md](../../../docs/engineering/storybook.md) §同期ルール・§チェックリスト を正本とする。docs に無い 2 点だけここで補う:

- `satisfies Meta<typeof Component>` + `StoryObj<typeof meta>`
- layout はレイヤーの既定に合わせる（UI=centered, Feature=padded, Foundation/Pattern=fullscreen）
