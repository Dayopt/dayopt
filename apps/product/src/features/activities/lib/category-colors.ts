/**
 * カテゴリーカラー定義
 *
 * DBにはカラー名（"blue" 等）を保存。
 * レンダリングはCSS変数 + Tailwindクラス経由。HEXは使わない。
 *
 * 色・アイコンを持つのはカテゴリーだけ（アクティビティは所属カテゴリーの色を継承する）。
 *
 * @see packages/foundations/src/tokens/colors.css — OKLCH値の定義
 * @see packages/foundations/src/tailwind-theme.css — Tailwindマッピング
 */

// ========================================
// 文字数制限
// ========================================

/** アクティビティ名の最大文字数（バックエンドと一致: z.string().max(50)） */
export const ACTIVITY_NAME_MAX_LENGTH = 50;

// ========================================
// カラー名一覧
// ========================================

/** 使用可能なカテゴリーカラー名の一覧 */
export const CATEGORY_COLOR_NAMES = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
  'gray',
] as const;

/** カテゴリーカラー名の型 */
export type CategoryColorName = (typeof CATEGORY_COLOR_NAMES)[number];

// ========================================
// カラー名 → クラス/CSS変数 マッピング
// ========================================

/** カテゴリーカラーのTailwindクラスとCSS変数のマッピング */
interface CategoryColorEntry {
  /** border用 Tailwindクラス (e.g. 'border-category-blue') */
  border: string;
  /** dot/icon背景用 Tailwindクラス (e.g. 'bg-category-blue') */
  dot: string;
  /** card背景tint用 Tailwindクラス (e.g. 'bg-category-blue-tint') */
  tint: string;
  /** tint をホバー・押下中も維持する Tailwindクラス */
  tintInteraction: string;
  /** inline style用 CSS変数 (e.g. 'var(--category-blue)') */
  cssVar: string;
  /** inline style用 tint CSS変数 (e.g. 'var(--category-blue-tint)') */
  cssVarTint: string;
}

/**
 * CSS トークン名（`--category-*`）と Tailwind クラス名（`bg-category-*` / `border-category-*`）。
 * 元は `--tag-*` だったが、tags feature 撤去後もこの token が activity/category の配色の
 * 実体を支え続けているため #2162 Step 5b/7 で `--category-*` へリネームした
 * （`packages/foundations/src/tokens/colors.css` / `tailwind-theme.css` と同一 commit）。
 *
 * Tailwind v4 safelist — テンプレートリテラルはJITスキャナーに検出されないため、
 * 全カテゴリーカラーのクラス名をフル文字列で列挙してCSS生成を保証する。
 *
 * bg-category-red bg-category-orange bg-category-amber bg-category-green bg-category-teal
 * bg-category-blue bg-category-indigo bg-category-violet bg-category-pink bg-category-gray
 * bg-category-red-tint bg-category-orange-tint bg-category-amber-tint bg-category-green-tint bg-category-teal-tint
 * bg-category-blue-tint bg-category-indigo-tint bg-category-violet-tint bg-category-pink-tint bg-category-gray-tint
 * border-category-red border-category-orange border-category-amber border-category-green border-category-teal
 * border-category-blue border-category-indigo border-category-violet border-category-pink border-category-gray
 * hover:bg-category-red-tint hover:bg-category-orange-tint hover:bg-category-amber-tint hover:bg-category-green-tint hover:bg-category-teal-tint
 * hover:bg-category-blue-tint hover:bg-category-indigo-tint hover:bg-category-violet-tint hover:bg-category-pink-tint hover:bg-category-gray-tint
 * active:bg-category-red-tint active:bg-category-orange-tint active:bg-category-amber-tint active:bg-category-green-tint active:bg-category-teal-tint
 * active:bg-category-blue-tint active:bg-category-indigo-tint active:bg-category-violet-tint active:bg-category-pink-tint active:bg-category-gray-tint
 */
function entry(name: CategoryColorName): CategoryColorEntry {
  return {
    border: `border-category-${name}`,
    dot: `bg-category-${name}`,
    tint: `bg-category-${name}-tint`,
    tintInteraction: `hover:bg-category-${name}-tint active:bg-category-${name}-tint`,
    cssVar: `var(--category-${name})`,
    cssVarTint: `var(--category-${name}-tint)`,
  };
}

/** カテゴリーカラー名からTailwindクラス/CSS変数へのマッピングテーブル */
export const CATEGORY_COLOR_MAP: Record<CategoryColorName, CategoryColorEntry> = {
  red: entry('red'),
  orange: entry('orange'),
  amber: entry('amber'),
  green: entry('green'),
  teal: entry('teal'),
  blue: entry('blue'),
  indigo: entry('indigo'),
  violet: entry('violet'),
  pink: entry('pink'),
  gray: entry('gray'),
} as const;

// ========================================
// デフォルト値
// ========================================

/** カテゴリーのデフォルトカラー */
export const DEFAULT_CATEGORY_COLOR: CategoryColorName = 'blue';

// ========================================
// ブリッジ関数（HEX / 名前 / null → CategoryColorName）
// ========================================

/** 旧HEX→名前マッピング（DB移行期間用） */
const LEGACY_HEX_MAP: Record<string, CategoryColorName> = {
  '#3b82f6': 'blue',
  '#10b981': 'green',
  '#ef4444': 'red',
  '#f59e0b': 'amber',
  '#8b5cf6': 'violet',
  '#ec4899': 'pink',
  '#06b6d4': 'teal', // 旧 cyan
  '#f97316': 'orange',
  '#6b7280': 'gray',
  '#6366f1': 'indigo',
};

const CATEGORY_COLOR_SET = new Set<string>(CATEGORY_COLOR_NAMES);

/**
 * カラー値を安全にCategoryColorNameへ解決
 *
 * - 有効な名前 → そのまま返す
 * - 旧HEX値 → 対応する名前に変換
 * - null / undefined / 不明 → デフォルト（blue）
 */
export function resolveCategoryColor(color: string | null | undefined): CategoryColorName {
  if (!color) return DEFAULT_CATEGORY_COLOR;
  if (CATEGORY_COLOR_SET.has(color)) return color as CategoryColorName;
  return LEGACY_HEX_MAP[color.toLowerCase()] ?? DEFAULT_CATEGORY_COLOR;
}

/**
 * カラー値からクラス群を取得
 *
 * HEX / 名前 / null を受け付ける。
 * コンポーネントはこの関数経由でクラスを決定する。
 */
export function getCategoryColorClasses(color: string | null | undefined): CategoryColorEntry {
  return CATEGORY_COLOR_MAP[resolveCategoryColor(color)];
}
