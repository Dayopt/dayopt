import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 呼び出し元の `.mjs` ファイルが `node <file>` として直接実行されたか
 * （import されただけではないか）を判定する。
 *
 * ops 系の各 wrapper（`factory-handoff.mjs` 等）が
 * 同一実装をそれぞれ複製していた（#2432 plan-review
 * 指摘、plan-critic）。新規スクリプトでの複製を増やさないための共有先として
 * 抽出する。既存の複製は本ファイルの新設だけでは解消されない（呼び出し元の
 * 一括置換は影響範囲が広いため別途判断する）。
 *
 * **`import.meta.url` は呼び出し元が渡す必要がある** — この関数の内部で
 * `import.meta.url` を書くと、常に本ファイル自身の URL に評価されてしまい
 * （import.meta は静的にモジュールごとに束縛されるため）、呼び出し元の
 * ファイルを指せず判定が常に false になる。
 * @param {string} callerModuleUrl 呼び出し元が渡す `import.meta.url`
 */
export function isDirectExecution(callerModuleUrl) {
  if (!process.argv[1]) return false;
  try {
    return callerModuleUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
