/**
 * next-intl の型 augmentation
 *
 * `messages/en/*.json` の型を merge して `AppConfig.Messages` に登録する。
 * これにより `t()` / `getTranslations()` のキー引数が存在しないキーだと
 * `pnpm typecheck` がコンパイルエラーとして検出する（issue #1899）。
 *
 * en を正とする理由: `pnpm lint:i18n` が en/ja のキーパリティを別途保証するため、
 * 型はどちらか一方（en）だけを見れば十分（両方 import すると型が二重に重くなる）。
 *
 * namespace ファイルを追加/削除したら、この import 一覧も同時に更新する。
 * 追従を忘れても新 namespace のキーが型エラーとして即座に表面化するため、
 * 「更新し忘れたまま気づかれない」状態にはならない（サイレントに stale 化しない）。
 *
 * 【重要】このファイルは top-level import を持つ「module」でなければならない。
 * import/export が無い script ファイルで `declare module 'next-intl' {}` を書くと
 * augmentation（既存の型定義への merge）ではなく新規の ambient module 宣言として
 * 扱われ、next-intl 本来の export（useTranslations 等）を丸ごと不可視化する。
 */
import type activities from '../../../messages/en/activities.json';
import type auth from '../../../messages/en/auth.json';
import type calendar from '../../../messages/en/calendar.json';
import type common from '../../../messages/en/common.json';
import type contact from '../../../messages/en/contact.json';
import type email from '../../../messages/en/email.json';
import type error from '../../../messages/en/error.json';
import type legal from '../../../messages/en/legal.json';
import type navigation from '../../../messages/en/navigation.json';
import type oauth from '../../../messages/en/oauth.json';
import type settings from '../../../messages/en/settings.json';
import type shortcuts from '../../../messages/en/shortcuts.json';
import type sidebar from '../../../messages/en/sidebar.json';
import type timeblock from '../../../messages/en/timeblock.json';

type Messages = typeof activities &
  typeof auth &
  typeof calendar &
  typeof common &
  typeof contact &
  typeof email &
  typeof error &
  typeof legal &
  typeof navigation &
  typeof oauth &
  typeof settings &
  typeof shortcuts &
  typeof sidebar &
  typeof timeblock;

declare module 'next-intl' {
  interface AppConfig {
    Messages: Messages;
  }
}
