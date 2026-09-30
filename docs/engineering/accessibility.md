---
status: current
last_verified: 2026-09-28
code: apps/product/src
---

# アクセシビリティガイド

Dayopt のアクセシビリティ対応基準と実装パターン。基準スコア、shadcn/ui コンポーネント別対応状況、フォーカス/キーボード操作、フォーム/Dialog、スクリーンリーダー対応、禁止パターンをまとめる。

---

## 基準スコア

| ツール                 | 基準      | タイミング                            |
| ---------------------- | --------- | ------------------------------------- |
| Lighthouse CI          | 90点以上  | `pnpm perf:lighthouse`（手動実行）    |
| eslint-plugin-jsx-a11y | エラー0件 | コミット時（lint-staged）+ CI の lint |
| axe-core               | 警告確認  | 開発時にコンソール表示                |

## WCAG AA コントラスト基準

| テキストサイズ           | 最小コントラスト比 |
| ------------------------ | ------------------ |
| 通常テキスト（&lt;18pt） | 4.5:1              |
| 大きなテキスト（≥18pt）  | 3:1                |

セマンティックトークン（`text-foreground`, `text-muted-foreground`）を使用すれば自動的に基準を満たします。

## チェックリスト

### 新規コンポーネント作成時

- [ ] インタラクティブ要素に aria-label または可視ラベルがある
- [ ] フォーカス状態が視覚的に明確
- [ ] キーボードで操作可能（Tab, Enter, Space, Escape）
- [ ] カラーコントラストがWCAG AA準拠（4.5:1以上）
- [ ] `pnpm lint` がパス（jsx-a11y ルールを含む）

### PR作成前

- [ ] `pnpm lint` がパス
- [ ] 開発サーバーでaxe-coreの警告を確認
- [ ] Tabキーで全要素にアクセス可能
- [ ] スクリーンリーダーでテスト（VoiceOver / NVDA）

## コマンド

| コマンド               | 説明                                    |
| ---------------------- | --------------------------------------- |
| `pnpm lint`            | ESLint（jsx-a11yルール含む）でチェック  |
| `pnpm perf:lighthouse` | Lighthouse CI（accessibility 90点以上） |

## 参考リンク

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Radix UI Accessibility](https://www.radix-ui.com/docs/primitives/overview/accessibility)
- [axe-core Rules](https://dequeuniversity.com/rules/axe/)

---

## shadcn/ui コンポーネント別ガイド

shadcn/ui（Radix UI）コンポーネントの a11y 対応状況。

### 基本対応済み（そのまま使用可）

| コンポーネント | a11y対応                             |
| -------------- | ------------------------------------ |
| Button         | disabled, aria-busy対応              |
| Input          | aria-invalid対応                     |
| Select         | キーボード操作完備（矢印キー）       |
| Dialog         | role, aria-modal, フォーカストラップ |
| AlertDialog    | 同上 + role="alertdialog"            |
| Popover        | Escapeで閉じる                       |
| Drawer         | role="dialog"                        |
| Tooltip        | キーボードフォーカスで表示           |

### 追加対応が必要

| コンポーネント         | 必要な対応                    |
| ---------------------- | ----------------------------- |
| Toast (Sonner)         | `aria-live="polite"` の確認   |
| カスタムドロップダウン | キーボード操作の実装          |
| Drag & Drop            | aria-grabbed, aria-dropeffect |
| カスタムスライダー     | aria-valuemin/max/now         |

### Motion Preference

アニメーションを減らしたいユーザー設定を尊重する。

#### useReducedMotion フック

OSの「視覚効果を減らす」設定を検出。

```tsx
import { useReducedMotion } from '@/features/calendar/hooks/accessibility/useReducedMotion';

function AnimatedComponent() {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      className={
        prefersReducedMotion
          ? '' // アニメーションなし
          : 'transition-transform duration-300'
      }
    >
      コンテンツ
    </div>
  );
}
```

#### CSS での対応

Tailwind CSS の `motion-reduce:` プレフィックス。

```tsx
// アニメーションを条件付きで適用
<div className="
  transition-transform duration-300
  motion-reduce:transition-none
">
  コンテンツ
</div>

// または motion-safe: で明示的に有効化
<div className="
  motion-safe:transition-transform
  motion-safe:duration-300
">
  コンテンツ
</div>
```

#### 対象となるアニメーション

- ページ遷移アニメーション
- ローディングスピナー（回転は維持、パルスは停止）
- ホバー時のスケール変化
- スクロールアニメーション
- 自動再生される装飾アニメーション

---

## フォーカスとキーボード

キーボード操作時のフォーカス状態を明確に表示し、キーボードのみで全機能が使えるようにする。

### フォーカスリング（MD3スタイル）

```tsx
// 推奨パターン
className =
  'outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring';

// shadcn/ui では focus-visible:outline-ring/50 も使用
className =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
```

### aria-disabled 対応

`disabled` 属性の代わりに `aria-disabled` を使う場合のスタイル。

```tsx
// aria-disabled 対応
className = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
```

### スキップリンク

キーボードユーザーがナビゲーションをスキップしてメインコンテンツに移動できるようにする。

```tsx
// スキップリンク
<a
  href="#main-content"
  className="sr-only focus:not-sr-only ..."
>
  メインコンテンツへスキップ
</a>

// ターゲット
<main id="main-content" role="main">
  ...
</main>
```

> Dayoptでは `src/app/[locale]/(app)/_shell/base-layout-content.tsx` で実装済み。

### 基本キー

| キー          | 用途                              |
| ------------- | --------------------------------- |
| `Tab`         | 次の要素にフォーカス移動          |
| `Shift + Tab` | 前の要素にフォーカス移動          |
| `Enter`       | ボタン/リンクの実行               |
| `Space`       | チェックボックス/ボタンの切り替え |
| `Escape`      | モーダル/ポップオーバーを閉じる   |

### 入力中のショートカット無効化

テキスト入力中はグローバルショートカットを無効にする。

```tsx
// ショートカットハンドラ内で入力中かチェック
const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '');

if (isTyping) return; // 入力中は何もしない

// ショートカット処理を続行...
```

### Dayoptのショートカット例

カレンダー画面のキーボード操作（Google Calendar互換）。

| キー                 | アクション         |
| -------------------- | ------------------ |
| `Escape`             | Inspectorを閉じる  |
| `Delete / Backspace` | 選択中プランを削除 |
| `C`                  | 新規プラン作成     |

---

## フォームとDialog

フォーム要素のラベル紐付け、エラー状態、Dialog の必須ルール。

### Label と Input の紐付け

必ず `htmlFor` と `id` を使って紐付ける。

```tsx
<Label htmlFor="email">メールアドレス</Label>
<Input
  id="email"
  type="email"
  aria-describedby="email-hint"
/>
<p id="email-hint" className="text-sm text-muted-foreground">
  確認メールを送信します
</p>
```

### エラー状態

`aria-invalid` と `aria-describedby` でエラーを関連付け。

```tsx
<Input id="email" aria-invalid={!!error} aria-describedby={error ? 'email-error' : undefined} />;
{
  error && (
    <p id="email-error" role="alert" className="text-destructive">
      {error}
    </p>
  );
}
```

### ローディング状態

`aria-busy` でローディング中であることを伝える。

```tsx
<Button disabled aria-busy={isLoading}>
  {isLoading ? <Spinner /> : '保存'}
</Button>
```

### Dialog / AlertDialog

shadcn/ui（Radix UI）の Dialog/AlertDialog は基本的な a11y 対応済み。ただし、必須ルールがある。

#### DialogTitle / DialogDescription を省略しない

省略するとスクリーンリーダーで内容が伝わらない。`aria-labelledby` と `aria-describedby` が自動設定される。

```tsx
// ✅ 良い例
<DialogContent>
  <DialogHeader>
    <DialogTitle>設定</DialogTitle>
    <DialogDescription>
      アプリの設定を変更します
    </DialogDescription>
  </DialogHeader>
  {/* コンテンツ */}
</DialogContent>

// ❌ 悪い例（DialogTitle/Description なし）
<DialogContent>
  <h2>設定</h2>
  <p>アプリの設定を変更します</p>
</DialogContent>
```

#### 視覚的に非表示にする場合

デザイン上タイトルを表示したくない場合も、`sr-only` で残す。

```tsx
<DialogHeader>
  <DialogTitle className="sr-only">画像プレビュー</DialogTitle>
</DialogHeader>
```

---

## スクリーンリーダー対応

視覚的には見えないが、スクリーンリーダーには読み上げられるテキストの実装パターン。

### アイコンボタン

アイコンのみのボタンには必ず `aria-label` を設定する。

```tsx
// ✅ 良い例
<Button variant="ghost" size="icon" aria-label="設定を開く">
  <Settings />
</Button>

// ❌ 悪い例（aria-label なし）
<Button variant="ghost" size="icon">
  <Settings />
</Button>
```

### sr-only クラス

視覚的に隠すが、スクリーンリーダーには読み上げられる。

```tsx
<button>
  <XIcon />
  <span className="sr-only">閉じる</span>
</button>
```

**sr-only の CSS**:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
```

### ライブリージョン

動的に変化するコンテンツをスクリーンリーダーに通知する。

#### ステータス更新（polite）

ユーザーの操作を中断せず、適切なタイミングで読み上げる。

```tsx
<div aria-live="polite" role="status" className="sr-only">
  {message}
</div>
```

用途: 保存完了、データ更新、非緊急の通知

#### 緊急通知（assertive）

即座にユーザーに通知する（現在の読み上げを中断）。

```tsx
<div aria-live="assertive" role="alert" className="sr-only">
  {errorMessage}
</div>
```

用途: エラー、警告、緊急の通知（多用禁止）

#### 使い分け

| 属性                    | 読み上げタイミング   | 用途                 |
| ----------------------- | -------------------- | -------------------- |
| `aria-live="polite"`    | 現在の読み上げ完了後 | ステータス、保存完了 |
| `aria-live="assertive"` | 即座（中断あり）     | エラー、緊急通知     |
| `aria-live="off"`       | 通知しない           | デフォルト           |

---

## 禁止事項

アクセシビリティを損なう実装パターン。

### クリックのみでキーボード操作不可

```tsx
// ✅ 良い例: button要素を使用
<button onClick={handleClick}>
  クリック
</button>

// ✅ または role + tabIndex + onKeyDown
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === 'Enter') handleClick()
  }}
>
  クリック
</div>

// ❌ 悪い例: div + onClick のみ（キーボードで操作できない、フォーカスも当たらない）
<div onClick={handleClick}>
  クリック
</div>
```

### aria-label の乱用

可視テキストがある場合は aria-label 不要。

```tsx
// ✅ テキストがない場合のみaria-label
<Button aria-label="保存する">
  <SaveIcon aria-hidden="true" />
</Button>

// ✅ テキストがあればそのまま
<Button>保存</Button>

// ❌ テキストがあるのにaria-label（二重に読み上げられる可能性）
<Button aria-label="保存する">
  保存
</Button>
```

### 色だけで情報を伝える

色覚特性のあるユーザーに伝わらない。

```tsx
// ✅ 良い例: アイコン + テキストで意味を補強
<span className="text-destructive">
  <AlertIcon aria-hidden="true" />
  必須項目です
</span>

// ❌ 悪い例: 赤色だけでエラーを示す
<span className="text-red-500">
  必須
</span>
```
