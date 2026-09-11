import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '../cn';

/**
 * ボタンバリアント定義
 *
 * ## バリアント設計（Material Design 3 / Carbon Design System 参考）
 *
 * | variant     | 用途                                         | 例                           |
 * |-------------|----------------------------------------------|------------------------------|
 * | primary     | 主要CTA、画面で最も重要なアクション          | 保存、送信、作成、購入       |
 * | outline     | 副次アクション、primaryとペアで使用          | キャンセル、戻る、詳細       |
 * | ghost       | アイコンボタン、ツールバー、軽量な操作       | 閉じる、メニュー、設定       |
 * | destructive | 破壊的アクション、確認ダイアログ内           | 削除、解除、退会             |
 *
 * ## サイズ設計（GAFA準拠）
 *
 * | size    | 高さ  | テキスト | 用途                           |
 * |---------|-------|----------|--------------------------------|
 * | sm      | 32px  | text-sm  | コンパクトUI、ツールバー       |
 * | default | 36px  | text-sm  | 標準的なアクション             |
 * | lg      | 44px  | text-base| CTA、モバイル主要アクション    |
 *
 * ## icon prop（アイコンボタン）
 *
 * `icon` を指定するとアイコン専用の正方形ボタンになる。
 * サイズは通常ボタンと同じ sm/default/lg スケールを共有。
 * SVGアイコンサイズはFoundations/Iconsに準拠（size-4: 16px, size-5: 20px）。
 *
 * | size  + icon | ボタン | アイコン | タップターゲット |
 * |--------------|--------|---------|-----------------|
 * | sm    + icon | 32px   | 16px    | 44px（after）    |
 * | default+icon | 36px   | 16px    | 44px（after）    |
 * | lg    + icon | 44px   | 20px    | 44px（native）   |
 *
 * ## スペック詳細
 *
 * | size    | 高さ  | パディング | アイコン | フォント  | Tailwind |
 * |---------|-------|------------|----------|-----------|----------|
 * | sm      | 32px  | 12px       | 16px     | text-sm   | h-8      |
 * | default | 36px  | 16px       | 16px     | text-sm   | h-9      |
 * | lg      | 44px  | 20px       | 20px     | text-base | h-11     |
 */
const buttonVariants = cva(
  [
    // 基本レイアウト
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-normal',
    // トランジション
    'transition-colors',
    // フォーカス状態（アクセシビリティ）
    'outline-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    // 無効状態（aria-disabled推奨、disabled属性も対応）
    'disabled:pointer-events-none disabled:opacity-50',
    'aria-disabled:pointer-events-none aria-disabled:opacity-50',
    // バリデーションエラー状態
    'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
  ].join(' '),
  {
    variants: {
      variant: {
        // 主要CTA - 最も強調されるボタン
        primary:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover',
        // 副次アクション - ボーダー付きの控えめなボタン
        outline: [
          'border border-border text-foreground',
          'hover:bg-state-hover active:bg-state-hover',
        ].join(' '),
        // アイコンボタン・ツールバー - 背景なし、ホバーで背景出現
        ghost: 'text-foreground hover:bg-state-hover active:bg-state-hover',
        // 破壊的アクション - 削除、解除など
        destructive: [
          'bg-destructive text-destructive-foreground',
          'hover:bg-destructive-hover active:bg-destructive-hover',
          'focus-visible:outline-destructive',
        ].join(' '),
      },
      size: {
        // sm: 32px高さ、16pxパディング、16pxアイコン
        sm: [
          'h-8 px-4 text-sm',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        ].join(' '),
        // default: 36px高さ（M3 Small準拠）、16pxパディング、16pxアイコン
        default: [
          'h-9 px-4 text-sm',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        ].join(' '),
        // lg: 44px高さ（Apple HIG準拠）、20pxパディング、20pxアイコン
        lg: [
          'h-11 px-4 text-base',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5 [&_svg]:shrink-0",
        ].join(' '),
        // --- 以下は内部用（icon prop 経由で使用） ---
        // icon-sm: 32x32px、タップターゲット44px確保
        '_square-sm': [
          'size-8',
          'relative after:absolute after:inset-0 after:m-auto after:size-11 after:content-[""]',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        ].join(' '),
        // icon-default: 36x36px（M3準拠）、タップターゲット44px確保
        '_square-default': [
          'size-9',
          'relative after:absolute after:inset-0 after:m-auto after:size-11 after:content-[""]',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        ].join(' '),
        // icon-lg: 44x44px（Apple HIG準拠）
        '_square-lg': [
          'size-11',
          "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5 [&_svg]:shrink-0",
        ].join(' '),
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

/** 公開用のサイズ型（内部の _square-* は除外） */
type ButtonSize = 'sm' | 'default' | 'lg';

interface ButtonProps
  extends React.ComponentProps<'button'>, Omit<VariantProps<typeof buttonVariants>, 'size'> {
  /** ボタンのサイズ */
  size?: ButtonSize | null;
  /** アイコン専用ボタンにする（サイズは size prop と共有） */
  icon?: boolean;
  /** 子要素にスタイルを委譲する（Linkなどで使用） */
  asChild?: boolean;
  /** ローディング状態 */
  loading?: boolean;
  /** ローディング中に表示するテキスト（省略時は children を表示） */
  loadingText?: string;
}

/**
 * ボタンコンポーネント
 *
 * @example
 * // 基本的な使用（primary）
 * <Button>保存</Button>
 * <Button variant="primary">送信</Button>
 *
 * @example
 * // 副次アクション（outline）
 * <Button variant="outline">キャンセル</Button>
 *
 * @example
 * // アイコンボタン（ghost + icon）
 * <Button variant="ghost" icon aria-label="設定を開く">
 *   <Settings className="size-4" />
 * </Button>
 *
 * @example
 * // コンパクトなアイコンボタン
 * <Button variant="ghost" size="sm" icon aria-label="閉じる">
 *   <X className="size-4" />
 * </Button>
 *
 * @example
 * // 破壊的アクション（destructive）
 * <Button variant="destructive">削除</Button>
 *
 * @example
 * // ローディング状態
 * <Button loading>保存中...</Button>
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      icon = false,
      asChild = false,
      loading = false,
      loadingText,
      onClick,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    // icon + size → 内部cvaバリアント名に変換
    const resolvedSize = icon ? (`_square-${size ?? 'default'}` as const) : (size ?? undefined);

    const Comp = asChild ? Slot : 'button';

    // aria-disabled または loading 時はクリックを無効化する。
    //
    // **ガードが要る時だけ関数を挟む。** 素通しの場合に毎回新しい関数を作って渡すと、
    // Server Component から描画した時に「Event handlers cannot be passed to Client
    // Component props」でサーバー例外になる（本番では React #441 に潰れて原因が
    // 見えない。2026-09-11 に `/oauth/consent` が本番でこれで落ちた）。
    // `asChild` 側は元から onClick を素通ししており、そのため
    // `<Button asChild>` を使う Server Component だけが無事だった。
    const handleClick =
      props['aria-disabled'] || loading
        ? (e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
          }
        : onClick;

    // ローディング中のコンテンツ
    const content = loading ? (
      <>
        <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {loadingText ?? children}
      </>
    ) : (
      children
    );

    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size: resolvedSize, className }))}
        onClick={asChild ? onClick : handleClick}
        disabled={loading || disabled}
        aria-busy={loading || undefined}
        ref={ref}
        {...props}
      >
        {content}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants, type ButtonProps };
