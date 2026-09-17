/**
 * 「未マッピング」を 2 つに割る（語彙の層の宣言）。
 *
 * 自動発見した項目のうち、**製品語彙を持たないことが正しい**ものがある。SQL 内部だけで使う
 * 関数、認証の定型画面、feature に属さない共通 UI の Story などで、これらは用語集へ概念を
 * 足しても意味が増えない。全部を同じ「未マッピング」に並べると、本当に判断すべき項目
 * （概念を足すか実装を消すか）が 200 行のノイズに埋もれる。
 *
 * ここはその境界の**宣言**であり、発見ではない。だから条件は短く、理由を文で持つ。
 * 宣言が実装とずれたら（例: 消えた i18n namespace を宣言し続ける）
 * `checkVocabularyScopeDeclarations` が止める。
 */

import type { InventoryItem } from './inventory.ts';

/** feature ではない利用元バケット（`inventory.ts` の `usedBy` が使う）。 */
const NON_FEATURE_USERS = new Set(['app', 'lib']);

/**
 * 画面横断の定型文言。特定の概念ではなく「どの画面にも出る言葉」を入れる namespace。
 * ここに無い namespace は概念を足す候補として残る。
 */
export const CROSS_CUTTING_I18N_NAMESPACES: readonly string[] = [
  'common',
  'email',
  'error',
  'legal',
  'navigation',
  'oauth',
  'shortcuts',
  'sidebar',
];

/**
 * 製品語彙を持たない画面のうち、配下もまとめて除外してよいもの。
 * `/[locale]/auth/login` のような下位 route を前方一致で含む。
 */
const VOCABULARY_LESS_ROUTE_PREFIXES: readonly string[] = ['/[locale]/auth', '/[locale]/oauth'];

/**
 * 前方一致させてはいけない画面。`/[locale]` を prefix 扱いすると配下の全画面
 * （`/[locale]/calendar` 等）を飲み込み、概念を足す候補を黙って消してしまう。
 */
const VOCABULARY_LESS_ROUTES_EXACT: readonly string[] = ['/[locale]', '/offline'];

function isVocabularyLessRoute(route: string): boolean {
  return (
    VOCABULARY_LESS_ROUTES_EXACT.includes(route) ||
    VOCABULARY_LESS_ROUTE_PREFIXES.some(
      (prefix) => route === prefix || route.startsWith(`${prefix}/`),
    )
  );
}

/**
 * 語彙対象外なら理由を返す。`undefined` は「概念を足すか実装を消すかを人間が判断する対象」。
 * 既にどれかの概念へ辿れている item には呼ばない（呼び元が未マッピングだけを渡す）。
 */
export function vocabularyExclusionReason(item: InventoryItem): string | undefined {
  const usedBy = item.usedBy ?? [];

  switch (item.kind) {
    case 'db-function':
    case 'table': {
      if (usedBy.length === 0) {
        return item.kind === 'db-function'
          ? 'SQL 内部でのみ使う（trigger / cron / 他の SQL 関数）。app からの呼び出しが無い'
          : 'app から直接読み書きしない（SQL 関数の内部と RLS のためだけに存在する）';
      }
      if (usedBy.every((user) => NON_FEATURE_USERS.has(user))) {
        return `feature 横断の基盤（${usedBy.join(' / ')} 層）。特定の概念には属さない`;
      }
      return undefined;
    }
    case 'route':
      return isVocabularyLessRoute(item.id)
        ? '認証 / OAuth の定型フローと shell。製品語彙ではなく手続きの画面'
        : undefined;
    case 'story':
      return item.feature === undefined
        ? 'feature に属さない共通 UI（`components` / `app` / `emails`）の Story'
        : undefined;
    case 'i18n-namespace':
      return CROSS_CUTTING_I18N_NAMESPACES.includes(item.id)
        ? '画面横断の定型文言。特定の概念には属さない'
        : undefined;
    default:
      return undefined;
  }
}

/**
 * 宣言が実装とずれていないかを検査する。宣言した i18n namespace / route が
 * 実装から消えていたら、宣言も消す必要がある（残すと未マッピングを黙って減らし続ける）。
 */
export function checkVocabularyScopeDeclarations(items: readonly InventoryItem[]): string[] {
  const errors: string[] = [];
  const namespaces = new Set(
    items.filter((item) => item.kind === 'i18n-namespace').map((item) => item.id),
  );
  for (const declared of CROSS_CUTTING_I18N_NAMESPACES) {
    if (!namespaces.has(declared)) {
      errors.push(
        `vocabulary-scope: i18n namespace '${declared}' は実装に無い（CROSS_CUTTING_I18N_NAMESPACES から消す）`,
      );
    }
  }
  const routes = items.filter((item) => item.kind === 'route').map((item) => item.id);
  for (const prefix of VOCABULARY_LESS_ROUTE_PREFIXES) {
    if (!routes.some((route) => route === prefix || route.startsWith(`${prefix}/`))) {
      errors.push(
        `vocabulary-scope: route '${prefix}' に一致する画面が無い（VOCABULARY_LESS_ROUTE_PREFIXES から消す）`,
      );
    }
  }
  for (const exact of VOCABULARY_LESS_ROUTES_EXACT) {
    if (!routes.includes(exact)) {
      errors.push(
        `vocabulary-scope: route '${exact}' が実装に無い（VOCABULARY_LESS_ROUTES_EXACT から消す）`,
      );
    }
  }
  return errors;
}
