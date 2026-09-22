import { execFileSync } from 'node:child_process';

/**
 * gh CLI を shell を経由せず呼ぶ共通 wrapper（旧 scripts/ci/night-watch/lib.mjs から
 * 移設。ctx / trace / ai-usage / validation 系 script が使う）。
 *
 * 設計原則: **動的な値は shell へ二度渡さない**。issue 本文・検索クエリなどの
 * 危険な部分は `execFileSync` の argv 配列で渡す。argv 配列は shell を経由しない
 * ため、値の中にどんな文字（backtick・blockquote・ANSI-C escape が shell 展開で
 * できあがった文字列など）が入っていても gh の flag として再解釈されない。
 */

export const REPO = 'Dayopt/dayopt';

/**
 * @typedef {(file: string, args: string[], options?: { encoding?: string }) => string} ExecFileImpl
 * 実体は `node:child_process` の `execFileSync`（string encoding 指定時の戻り値）。
 * test では差し替え可能な最小限の呼び出し形だけを型に持たせる。
 */

// `execFileSync` の既定 maxBuffer は 1MB で、超えると ENOBUFS で throw する。
// gh の応答量は public repo では第三者が動かせる変数（issue / PR の件数と本文長）
// なので、既定のままだと「観測が黙って落ちる」を外から誘発できる。呼び出し側は
// --jq 射影で応答を絞るのが第一防御で、これはその裏の余裕。大きすぎる値は OOM を
// 招くので 32MB に留める。
export const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * gh CLI を execFile 経由で呼ぶ。shell を経由しない。
 * @param {string[]} args
 * @param {{ execFileImpl?: ExecFileImpl }} [opts]
 */
export function runGh(args, { execFileImpl = execFileSync } = {}) {
  return execFileImpl('gh', args, { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER_BYTES });
}

/**
 * gh CLI の JSON 出力をパースして返す。
 * @param {string[]} args
 * @param {{ execFileImpl?: ExecFileImpl }} [opts]
 */
export function runGhJson(args, opts = {}) {
  const out = runGh(args, opts);
  return JSON.parse(out);
}
