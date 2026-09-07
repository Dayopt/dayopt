---
status: current
last_verified: 2026-08-17
code:
  - apps/storybook/.storybook
  - apps/storybook/package.json
---

# Dayopt Storybook

Dayopt の UI コンポーネントとデザイントークンのカタログの運用ガイドと、Storybook 公式用語集（CSF / Meta / Story / Sidebar / Addons 等）。

---

## 🚨 大前提

> **Storybookに記載されているパターンのみ使用する**

- ✅ Storybookにある → 使ってOK
- ❌ Storybookにない → 使わない（対応していても）
- 🆕 新パターン → 先にStoryを追加してから使う

```tsx
// ✅ OK
<Button variant="ghost" size="icon">
  <Settings className="size-4" />
</Button>

// ❌ NG: size="xl" はStoryにない
<Button variant="link" size="xl">リンク</Button>
```

## 設計原則

「装飾のない基本体験」— 機能を伝えるために必要な要素だけを実装する。

- ✅ 控えめなホバー状態、セマンティックカラー、8px グリッド、シンプルなアイコン
- ❌ 派手なグラデーション、過剰なアニメーション、影の多用、装飾画像

UI/UX で迷ったら文脈に合う Google 製品を開いて観察する（GAFA-First）。
参考: Material Design 3 / Apple HIG / shadcn/ui (Radix UI)

### コンポーネント選択フロー

```
新しいUIコンポーネントが必要か？
├─ shadcn/ui にあるか？ → あれば使う（第一選択）
├─ HeadlessUI にあるか？ → 使う（a11y重視）
├─ 3箇所以上で使うか？ → components/common/ に追加
└─ 1-2箇所のみ？ → インラインで実装
```

---

## 📁 構成

| カテゴリ        | 内容                                          | 例                                     |
| --------------- | --------------------------------------------- | -------------------------------------- |
| **Docs**        | ガイドライン・アーキテクチャ                  | Accessibility                          |
| **Foundations** | デザイントークン・設計基盤                    | Colors, Typography, Spacing, Elevation |
| **Primitives**  | 単体UIコンポーネント                          | Button, Badge, Input, Dialog           |
| **Recipes**     | 2つ以上の Primitive を組み合わせた複合UI      | Field, ConfirmDialog, Inspector/\*     |
| **Features**    | ドメインロジックを含む Feature コンポーネント | Timeblock/_, Calendar/_, Tags/\*       |
| **Patterns**    | 実装パターンのカタログ                        | Forms, Feedback, Loading               |

## 🎨 カラートークン

Tailwindクラス名で統一。そのままコピペ可能。

```tsx
// ✅ OK
<div className="bg-card text-foreground border-border" />

// ❌ NG
<div style={{ color: 'var(--foreground)' }} />
```

| プレフィックス | 例                                                     |
| -------------- | ------------------------------------------------------ |
| `bg-*`         | `bg-container`, `bg-background`, `bg-card`, `bg-muted` |
| `text-*`       | `text-foreground`, `text-muted-foreground`             |
| `border-*`     | `border-border`                                        |
| `ring-*`       | `ring-primary`                                         |

## 🖥️ Canvas と Docs の役割分離

| タブ       | 役割               | 内容                           |
| ---------- | ------------------ | ------------------------------ |
| **Canvas** | コンポーネント描画 | render のみ。テキスト禁止      |
| **Docs**   | ドキュメント       | テキスト + テーブル + Controls |

**Canvas** — 純粋なコンポーネント描画だけを置く。`<h1>`, `<h2>`, `<p>` 等の説明文は禁止。
AllPatterns も同様に、コンポーネントを `flex-col gap-6` で並べるだけ。

**Docs** — テーブルが必要なら MDX（`.docs.mdx`）で作成。不要なら `tags: ['autodocs']` + JSDoc で十分。

公式テンプレート: `Shared/Components/Overlays/AlertDialog`

## 🛠️ 開発者向け

### Storyの追加手順

1. `*.stories.tsx` を作成（Canvas用）
2. テーブルが必要なら `*.docs.mdx` を作成（Docs用）
3. `AllPatterns` Story を追加（全パターン一覧）
4. PRでレビュー → マージ後に使用可能

```
src/components/ui/my-component.tsx            # コンポーネント
src/components/ui/my-component.stories.tsx     # Story（Canvas）
src/components/ui/my-component.docs.mdx        # Docs（テーブルが必要な場合のみ）
```

### 命名規則（所有境界 taxonomy）

story の `title:` の **top-level は所有境界（どの package / app の資産か）** で分ける。第二階層以下は責務ベース。決定の経緯は ADR-023（削除済み、git 履歴参照）。

- `Shared/Foundations/Colors` → デザイントークン
- `Shared/Components/Actions/Button` → 共有 UI コンポーネント（`packages/components`）
- `Product/Features/Navigation/AppHeader` → product のナビゲーションコンポーネント
- `Product/Features/Timeblock/Inspector/TimeblockInspector` → product の Feature コンポーネント
- `Web/Sections/Pricing` → web LP のセクション（現状は構造予約のみ）
- `Docs/はじめに` → ドキュメント（top-level doc は所有境界の外）

#### title prefix は物理位置で決まる

新規 story の prefix は「ファイルがどこに在るか」で機械的に決まる。下表に従う。

| 物理位置                                     | title prefix                                                |
| -------------------------------------------- | ----------------------------------------------------------- |
| `packages/components/src/**`                 | `Shared/Components/`                                        |
| `packages/foundations/src/**`                | `Shared/Foundations/`                                       |
| `apps/storybook/.storybook/stories/patterns` | `Shared/Patterns/` または `Product/Patterns/`（依存ベース） |
| `apps/product/src/components/**`             | `Product/Components/`                                       |
| `apps/product/src/features/**`               | `Product/Features/`（一部 `Product/Components/`）           |
| `apps/product/src/emails/**`                 | `Product/Emails`                                            |
| `apps/web/src/**`                            | `Web/`                                                      |

- **Patterns の依存ベース分離**: import が `@/`（product 内部）に依存 → `Product/Patterns/`。`@dayopt/components` だけに依存 → `Shared/Patterns/`。

このルールは `scripts/tasks/check-story-taxonomy.ts` が CI（`pnpm storybook:taxonomy`）で機械検証する。逸脱した title は lint job で hard-fail する。

### 同期ルール

コンポーネントを変更したら、Storyも同時に更新する。

- props追加 → argTypes + 使用例を追加
- props削除 → argTypes + 該当Storyを削除
- variant追加 → AllPatternsに追加

## ✅ チェックリスト

Story作成時に確認：

- [ ] AlertDialog テンプレートの構成に従っている
- [ ] Canvas にテキストを入れていない
- [ ] JSDoc は1行で簡潔に記述
- [ ] `AllPatterns` Storyを作成
- [ ] アイコンボタンに `aria-label` を設定
- [ ] セマンティックトークンを使用（`bg-background` 等）
- [ ] 直接カラーを使っていない（`text-blue-500` 等）

## ⛔ 避けるべきパターン

**Canvas にテキスト** — 見出し・説明文は Docs へ。Canvas はコンポーネントのみ。

**Story爆発** — 全組み合わせを個別Storyにしない。`AllPatterns` + Controls で対応。

**データ依存** — tRPC/Zustand依存コンポーネントは無理にStorybookに入れない。

詳細: `.agents/skills/storybook/SKILL.md`

## 📚 推奨リーディングパス

初めてDayoptのコードベースに触れる場合、以下の順に読むとスムーズです：

| 順番 | ドキュメント                                        | 内容                                       |
| ---- | --------------------------------------------------- | ------------------------------------------ |
| 1    | [Dayopt コンセプト](../strategy.md)                 | Dayoptとは何か、ジョブ、プロダクト原則     |
| 2    | [用語集](../product/glossary.md)                    | 予定 / 記録 / アクティビティ等の用語       |
| 3    | [Architecture](./architecture.md)                   | monorepo packages の責務境界とデータフロー |
| 4    | [Common Pitfalls](./conventions.md#common-pitfalls) | よくある間違いと正しいパターン             |
| 5    | Colors（Storybook: Shared/Foundations/Colors）      | カラートークン、Surface体系                |
| 6    | Typography（Storybook: Foundations/Typography）     | フォントサイズ、行間、ウェイト             |
| 7    | [Accessibility](./accessibility.md)                 | a11yチェックリスト、WCAG準拠               |

---

## Storybook 公式用語集

このリポジトリで使う Storybook の構成要素を、公式用語に基づいて整理したリファレンス。正確なバージョンと addon 一覧は `apps/storybook/package.json`、有効な設定は `apps/storybook/.storybook/` を正とする。

### 1. ファイルとフォーマット

| 用語                             | 説明                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **CSF (Component Story Format)** | `.stories.tsx` ファイルの書式規格。現行は **CSF3**。default export（Meta）+ named export（Story）の構造を持つ。                             |
| **MDX**                          | Markdown + JSX を組み合わせた形式。カスタムドキュメントページの作成に使う。`main.ts` の `stories` で `../src/**/*.mdx` を対象に含めている。 |

### 2. Story 定義の構成要素

`.stories.tsx` ファイルの中身。

#### Meta（default export）

コンポーネント単位の設定オブジェクト。`satisfies Meta<typeof Component>` で型付けする。

```tsx
const meta = {
  title: 'Shared/Components/Actions/Button', // Sidebar上のパス
  component: Button, // 対象コンポーネント
  tags: ['autodocs'], // 自動ドキュメント生成
  argTypes: {/* ... */}, // Controls設定
  decorators: [/* ... */], // ラッパー
  parameters: {/* ... */}, // 静的メタデータ
} satisfies Meta<typeof Button>;

export default meta;
```

#### Story（named export）

コンポーネントの **1 つの状態** を表すオブジェクト。名前がそのまま Sidebar のラベルになる。

```tsx
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'default', children: 'Click me' },
};

export const Destructive: Story = {
  args: { variant: 'destructive', children: 'Delete' },
};
```

#### 各プロパティ

| プロパティ          | レベル                | 説明                                                                                                                                                                             |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **StoryObj**        | 型                    | Story の型定義。`type Story = StoryObj<typeof meta>` で使う。                                                                                                                    |
| **Args**            | Meta / Story          | Story に渡す props（コンポーネントの入力値）。Controls パネルから操作可能。                                                                                                      |
| **ArgTypes**        | Meta / Story          | Args の型情報と Controls パネルでの表示方法を定義。`control` の種類（select, boolean 等）や `options` を指定する。                                                               |
| **Render function** | Story                 | Story の描画方法をカスタムする関数。`render: (args) => <Component {...args} />`。複数コンポーネントの組み合わせ表示に使う。                                                      |
| **Play function**   | Story                 | Story の描画後に自動実行されるインタラクション関数。`storybook/test` の `userEvent` や `expect` を使って操作と assertion を記述する。                                            |
| **Decorators**      | Meta / Story / Global | Story を囲むラッパー。Provider 注入やレイアウト調整に使う。Dayopt では `preview.tsx` でグローバル Decorator を設定（テーマ切替、`NextIntlClientProvider`、`TRPCMockProvider`）。 |
| **Parameters**      | Meta / Story / Global | Story や addon の振る舞いを制御する静的メタデータ。`backgrounds`, `docs`, `a11y` など addon ごとの設定を持つ。                                                                   |
| **Tags**            | Meta / Story          | Story の分類ラベル。`'autodocs'` で自動ドキュメント生成を有効化する。                                                                                                            |
| **Loaders**         | Meta / Story          | Story 描画前に非同期データを取得する関数。`loaded` プロパティ経由で Story に渡される。                                                                                           |

### 3. Storybook UI の構成要素

画面の各パーツ。

```
┌─────────────────────────────────────────────────┐
│                   Toolbar                        │  ← GlobalTypes（テーマ切替など）
├──────────┬──────────────────────────────────────┤
│          │                                      │
│ Sidebar  │            Canvas                    │  ← Story描画エリア
│          │         or Docs page                 │  ← autodocs自動生成ページ
│          │                                      │
│          ├──────────────────────────────────────┤
│          │         Addons panel                  │  ← Controls, Actions, A11y
│          │                                      │
└──────────┴──────────────────────────────────────┘
```

| パーツ             | 説明                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sidebar**        | 左側の Story ツリー。Meta の `title` 階層（例: `Shared/Components/Actions/Button`）で構成される。Dayopt では top-level を所有境界で分け（ADR-023）、`Shared(Foundations/Components/Patterns) > Product(Components/Features/Emails) > Web` の順に並べている。 |
| **Canvas**         | Story を描画するメインエリア。1 つの Story を単独で表示する。                                                                                                                                                                                                |
| **Docs page**      | `tags: ['autodocs']` で自動生成されるドキュメントページ。コンポーネントの全 Story と props テーブルを一覧表示する。Dayopt では `DocsTemplate` でページレイアウトをカスタム。                                                                                 |
| **Controls panel** | ArgTypes に基づくインタラクティブな props 操作パネル。Story の Args をリアルタイムに変更できる。                                                                                                                                                             |
| **Toolbar**        | 上部バー。GlobalTypes で定義したツールを配置する。Dayopt ではテーマ切替（Light / Dark）を設定。                                                                                                                                                              |
| **Addons panel**   | 下部のタブ切替パネル。Controls、Accessibility、Vitest など、有効な addon の UI が表示される。                                                                                                                                                                |

### 4. インフラ（設定ファイル）

`.storybook/` ディレクトリに配置する設定ファイル群。

| ファイル        | 役割                                                                 | Dayopt での設定内容                                                                          |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **main.ts**     | Storybook の中核設定。Story 対象ファイル、addons、framework を定義。 | stories glob、`@storybook/nextjs-vite`、Docs / A11y / Vitest / MCP / dark mode、React Docgen |
| **preview.tsx** | Story 描画環境の設定。グローバル Decorators と Parameters を定義。   | テーマ、`NextIntlClientProvider` / `TRPCMockProvider`、store mock、viewport、a11y、Controls  |
| **manager.ts**  | Storybook UI そのもの（Sidebar, Toolbar）の外観設定。                | OS 設定に沿うテーマ、Controls panel、zoom 非表示                                             |

#### Addons（拡張機能パッケージ）

Dayopt で使用している addon:

| Addon                          | 説明                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `@storybook/addon-docs`        | MDX サポートと autodocs 自動生成。`remarkGfm` を追加する。          |
| `@storybook/addon-a11y`        | axe-core ベースのアクセシビリティ検査。CI では違反を error にする。 |
| `@storybook/addon-vitest`      | Vitest と Storybook のテスト統合。                                  |
| `@storybook/addon-mcp`         | AI から Storybook の Story と docs を調査するための MCP。           |
| `@vueless/storybook-dark-mode` | Light / Dark のテーマ切替。                                         |

### 5. 自動ドキュメント生成

| 用語                        | 説明                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Autodocs**                | Meta に `tags: ['autodocs']` を追加することで有効化。Meta と Story の情報から Docs ページを自動生成する。Dayopt では `DocsTemplate` でページレイアウトをカスタム。 |
| **react-docgen-typescript** | TypeScript の型情報（props の型、デフォルト値、JSDoc コメント）から props テーブルを自動生成する仕組み。`main.ts` の `typescript.reactDocgen` で有効化。           |
