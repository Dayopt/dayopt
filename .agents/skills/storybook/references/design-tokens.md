## Design Token 選択ガイド

禁止パターン（任意値・非トークン色・許可外サイズ等）は `pnpm lint:tokens` が機械強制する。ここでは「どの値を使うべきか」の選択表だけを持つ（機械が弾かない側の判断）。

### UI コンポーネントレイヤー

`@dayopt/components` が共有 UI コンポーネントの正本。責務は 4 層:

```text
Dayopt design system          semantic tokens / spacing / radius / motion / a11y
        ↓
@dayopt/components             Dayopt が所有する UI コンポーネント（正本）
        ↓
Radix primitives                Dialog / Popover / Select 等の振る舞い・a11y
        ↓
DOM / Browser
```

- app（product / web）からは `@dayopt/components` を第一選択にする。Button / Dialog / Popover / Select 等の一般 UI は直接 Radix を使わない
- shadcn/ui は上流の設計・生成元（新規 primitive 追加時の初期実装参照）として扱い、絶対的正本にはしない
- Radix は下層 primitive。`@dayopt/components` で表現できない挙動が必要な場合のみ直接利用
- 不要な wrapper は作らない。再利用価値がある場合のみ `@dayopt/components` に昇格
- 構造的強制: app の `package.json` に `@radix-ui/*` を追加しない（Radix 依存は `packages/components` にのみ置く）
- Radix を使わない判断も許可する（例: `packages/components` の `Tooltip` は自前 CSS-based 実装。理由をコメントに残せば許容）

### 色

semantic token 経由のみ（`bg-primary`, `text-foreground`, `border-border`, `bg-category-blue` 等、`packages/foundations/src/tailwind-theme.css` で定義済みのもの）。透過（`/10` 等）は `state-*` トークンのみ。

例外: メールテンプレート（`apps/product/src/emails/`、CSS変数不可のためhex許容、`styles.ts` に集約）、OG画像（Satori制約、`@dayopt/foundations/og-colors` の定数を参照）。

### Elevation / Shadow

| レベル  | Surface       | Shadow      | Border                      | 用途                             |
| ------- | ------------- | ----------- | --------------------------- | -------------------------------- |
| Sunken  | bg-container  | なし        | border-border               | sidebar, footer                  |
| Base    | bg-background | なし        | —                           | ページ地                         |
| Raised  | bg-card       | shadow-sm   | border border-border-subtle | stat card, セクション内カード    |
| Overlay | bg-card       | shadow-card | border border-border-subtle | dropdown, popover, dialog, modal |

判断基準: Raised はページと一緒にスクロールする要素、Overlay はページの上に重なる要素。入力系（input/textarea/select/radio）は `shadow-xs`。許可される shadow は `shadow-xs` / `shadow-sm` / `shadow-card` の3種のみ（theme リセット済みのため `shadow-md` 等は生成されない）。

### Spacing

8px グリッド準拠（4pxサブグリッド）。

| Tailwind | px   | 用途例                                      |
| -------- | ---- | ------------------------------------------- |
| 1        | 4px  | アイコン-テキスト間、最小間隔               |
| 2        | 8px  | コンパクト間隔                              |
| 3        | 12px | チップ・バッジ・密な行の内側（44px タッチ） |
| 4        | 16px | 標準間隔、カード内パディング                |
| 6        | 24px | セクション間                                |
| 8        | 32px | 大間隔                                      |
| 12       | 48px | ページ間隔                                  |
| 16       | 64px | ヒーロー間隔                                |
| 24       | 96px | 最大間隔                                    |

### Border Radius

4段階のみ: `rounded-none`(0), `rounded-lg`(8px), `rounded-2xl`(16px), `rounded-full`。`rounded-sm/md/xl`、bare `rounded` は theme リセット済みのため書いても何も起きない。

Elevation対応: Sunken/Raised/Overlay(dropdown,popover)は`rounded-lg`。Overlay(modal,dialog)のみ`rounded-2xl`（画面中央に出る大きな面だけ）。

### Typography

Tailwindデフォルトのみ（`text-xs`〜`text-lg`等）。任意値禁止。

### Icon Size

| Tailwind   | px   | 用途                                                  |
| ---------- | ---- | ----------------------------------------------------- |
| `size-3.5` | 14px | 標準（迷ったらこれ）: 補助（矢印、Eye等）text-sm の横 |
| `size-4`   | 16px | 標準: ボタン内、text-base の横                        |
| `size-5`   | 20px | 必要な時だけ: ナビ、強調                              |
| `size-6`   | 24px | 必要な時だけ: 見出し横                                |
| `size-8`   | 32px | 特殊: カード主アイコン、エラー                        |
| `size-10`  | 40px | 特殊: 空状態、オンボーディング                        |

### Motion / Transition

正本は `packages/foundations/src/tokens/Motion.mdx`（Storybook の Shared/Foundations/Motion）。

- デフォルト: `transition-colors duration-150 ease-standard`（迷ったらこれ）
- duration は `150` / `200` / `300` の 3 段のみ
- easing は `ease-standard`（その場で変わる）と `ease-settle`（入る・着地する）の 2 種のみ

### Z-Index

トークン経由のみ（`z-modal`, `z-tooltip` 等）。

| グループ         | 範囲      | 用途                                                                 |
| ---------------- | --------- | -------------------------------------------------------------------- |
| 通常コンテキスト | 40–450    | dropdown, popover, sheet, modal, confirm, toast, context-menu, tour  |
| Inspector        | 1000–1100 | calendar-drag, inspector-backdrop, inspector（現在未使用、将来予約） |
| Overlay          | 1200–1400 | Inspector 上の modal, popover, confirm                               |
| 最前面           | 9999      | tooltip                                                              |

### State Patterns（Error / Empty / Loading）

| シナリオ                 | コンポーネント  | サイズ                   |
| ------------------------ | --------------- | ------------------------ |
| tRPC クエリ失敗          | `ErrorState`    | 親コンテキストに合わせる |
| データなし（親コンテナ） | `EmptyState`    | 親コンテキストに合わせる |
| データなし（子の可視化） | `return null`   | —                        |
| コンポーネントクラッシュ | `ErrorBoundary` | —                        |
| ページエラー             | `error.tsx`     | フルページ               |
| Mutation 失敗            | Toast (sonner)  | —                        |
| 初期データ読み込み       | Skeleton        | コンテンツ形状に合わせる |
| ボタン/インライン操作    | Spinner         | sm / md                  |

ルール: UI を描画する全 `useQuery` は `isError` を `ErrorState` でハンドリング必須。コンテンツ領域は Skeleton 優先、生 `Loader2` 禁止（`Spinner`/`@dayopt/components` を使う）。

### Interaction Patterns

**確認フロー**: 不可逆な削除は `variant="destructive"`、大量更新・変更破棄は `warning`、通常確認は `default`、取り消し可能な操作（保存・作成）は確認不要。コンポーネントは `ConfirmDialog`（`@/components/ui/overlays/confirm-dialog`）。

**Toast**: `@/lib/toast` 経由のみ（`sonner` 直接 import 禁止）。成功/エラーは3秒（action付き5秒）、1行構成・description無し・close ボタン無し、同時表示は最大1つ。`info`/`warning` toastは提供せず、該当用途は Inline Banner を使う。

**フォームバリデーション**: react-hook-form + Zod。`mode: 'onBlur'`（初回）、`reValidateMode: 'onChange'`（以降）。エラー表示は `FieldError`（`text-sm text-destructive`、`＊` prefix自動付与）。

**ドラッグ操作**: カレンダーグリッド内のブロック操作と、サイドバーのアクティビティ所属変更（カテゴリー間 / 未分類との出し入れ）。**リスト並び替えDnDは廃止済み**（`sort_order`ごと撤去。順序を変えるDnDを新設する場合は必要性から議論する）。DnDライブラリは使わずブラウザ標準のHTML5 DnDで実装する（`@dnd-kit`撤去済み）。

---
