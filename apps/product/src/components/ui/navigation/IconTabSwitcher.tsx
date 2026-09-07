'use client';

import type { ReactNode } from 'react';

import { cn, HoverTooltip } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';

interface IconTabSwitcherItem<TValue extends string> {
  value: TValue;
  /** 読み上げ名。アイコンだけの項目ではツールチップにも使う。 */
  label: string;
  /** アイコン項目。省略すると `label` をテキストで出す。 */
  icon?: ReactNode | undefined;
  /** 遷移で切り替える項目。省略すると `onValueChange` を呼ぶボタンになる。 */
  href?: string | undefined;
  /**
   * 選べない項目。`href` を持たないボタン項目にだけ効く。
   * 出したまま押せなくするので、なぜ選べないかは呼び出し側が近くに書く
   * （disabled な button は hover を受け付けず tooltip が出ないため）。
   */
  disabled?: boolean | undefined;
}

interface IconTabSwitcherProps<TValue extends string> {
  items: readonly IconTabSwitcherItem<TValue>[];
  /** 選択中の項目。どれでもない状態（別ページを見ている等）は `undefined`。 */
  value: TValue | undefined;
  /** `href` を持たない項目の切替。href 項目だけなら不要。 */
  onValueChange?: ((value: TValue) => void) | undefined;
  /** タブ群自体のラベル。何を切り替えるのかを読み上げる。 */
  ariaLabel: string;
  className?: string | undefined;
}

/**
 * 少数の排他的な選択肢を横に並べる帯タブ。
 *
 * デスクトップ Sidebar の「カレンダー / レポート」切替（`WorkspaceTabs`）の見た目が正本で、
 * 他の面もこれを共有する（2026-09-07 User 指示）。`SegmentedControl` とは別物として持つ:
 * あちらは枠線 + 白い選択チップの独立した部品で、こちらは `bg-muted` の帯に沈め、
 * 選択中だけ `bg-state-selected` を持ち上げる。同じ画面に 2 つの見た目を混ぜない。
 *
 * 各項目は 32px の箱に 44px のタップターゲットを重ねる
 * （`packages/components/src/actions/button.tsx` の `_square-sm` と同じ技法）。
 *
 * `href` を持つ項目は `Link`、持たない項目は `button` で描く。前者は遷移が切替そのもの
 * （ワークスペース切替）で、後者はその場の state を変える（レポートの粒度）。
 */
export function IconTabSwitcher<TValue extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
}: IconTabSwitcherProps<TValue>) {
  return (
    <div
      // `w-fit`: 帯は中身ぶんだけ。ブロック要素の直下に置いた時に横いっぱいへ伸びて、
      // タブが左端に寄った帯になるのを防ぐ（flex 行の中に置く場合は影響しない）
      className={cn('bg-muted flex w-fit items-center rounded-lg', className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item) => (
        <TabItem
          key={item.value}
          item={item}
          active={item.value === value}
          {...(onValueChange ? { onSelect: () => onValueChange(item.value) } : {})}
        />
      ))}
    </div>
  );
}

function TabItem<TValue extends string>({
  item,
  active,
  onSelect,
}: {
  item: IconTabSwitcherItem<TValue>;
  active: boolean;
  onSelect?: (() => void) | undefined;
}) {
  const isDisabled = !item.href && item.disabled === true;
  const className = cn(
    'relative flex h-8 items-center justify-center rounded-lg transition-colors duration-150',
    isDisabled && 'pointer-events-none opacity-50',
    item.icon
      ? // アイコンは 32px の正方形。44px は擬似要素で足す（Button の _square-sm と同じ技法）
        // eslint-disable-next-line tailwindcss/no-arbitrary-value -- 擬似要素を描くには content が要り、空文字以外に書きようがない
        'w-8 after:absolute after:inset-0 after:m-auto after:size-11 after:content-[""]'
      : // テキストは**自分で 44px の幅を持つ**。アイコンと同じ「中央 44px」の擬似要素にすると、
        // 「週」のような 1 文字だと箱が 36px しかなく左右へ 4px ずつはみ出し、隣のタブの上に
        // 重なって別の粒度が選ばれる（2026-09-07 の反証レビュー指摘）。縦だけ広げる
        'min-w-11 px-3 text-xs after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[""]',
    active ? 'bg-state-selected text-foreground' : 'text-muted-foreground hover:text-foreground',
  );

  const content = item.icon ?? item.label;

  // アイコンだけの項目は名前が見えないのでツールチップを添える。テキスト項目には付けない
  // （読めているものを重ねて出さない）
  const body = item.href ? (
    <Link
      href={item.href}
      role="tab"
      aria-selected={active}
      aria-label={item.label}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={item.label}
      disabled={isDisabled}
      onClick={onSelect}
      className={className}
    >
      {content}
    </button>
  );

  // disabled な項目は hover を受け付けないので tooltip を付けても出ない
  if (!item.icon || isDisabled) return body;

  return (
    <HoverTooltip content={item.label} side="bottom">
      {body}
    </HoverTooltip>
  );
}
