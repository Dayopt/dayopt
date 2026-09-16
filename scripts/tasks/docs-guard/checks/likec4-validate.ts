/**
 * Check: LikeC4 model の構文検証（条件付き・advisory）
 *
 * `docs/engineering/data/architecture/*.c4` は生成物なので、生成器を壊すと**無効な DSL を
 * 黙って吐く**。生成自体は成功し、`architecture:check` の drift 検査も「最新」と言うため、
 * 誰かが explorer を開くまで気づかない。実際、生成器を書いている間に 3 回それをやった
 * （予約語 `kind`、自己参照 relation、`include` の構文）。
 *
 * ただし検証には `likec4` 本体が要る。devDependency にすると unpacked 11.6MB に加えて
 * playwright 1.60.0（repo は ^1.63.0）と vite 8 が全開発者の install へ入るので、
 * **依存は足さず `pnpm dlx` で都度取る**。代わりに毎 PR で走らせず、生成器か生成物が
 * 変わった PR だけに絞る（#2775 の判断 2）。
 *
 * **advisory**: 失敗しても docs-guard は落とさない。ネットワークが要る検査で merge を
 * 止めない方針のため。GitHub Actions の annotation として出すので、PR の Checks から見える。
 */

import { spawnSync } from 'node:child_process';

import { colors, ROOT } from '../config.ts';
import { listGitChanges } from '../git-changes.ts';

/** 生成器か生成物が変わった時だけ検証する。 */
const WATCHED_PATHSPECS = [
  'scripts/lib/architecture-map',
  'docs/engineering/data/architecture',
] as const;

const MODEL_DIR = 'docs/engineering/data/architecture';

/**
 * 検証に使う version。`docs/engineering/data/architecture/README.md` の手順と揃える。
 * 固定するのは、dlx が勝手に新しい major を取ってきて構文判定が変わるのを避けるため。
 */
export const LIKEC4_VERSION = '1.59.3';

export type LikeC4ValidateOutcome = 'skipped' | 'valid' | 'invalid' | 'unavailable';

export interface LikeC4ValidateResult {
  outcome: LikeC4ValidateOutcome;
  /** invalid / unavailable の時の likec4 出力（末尾のみ） */
  detail?: string;
}

/** 監視対象の path に変更があるか。 */
export function hasWatchedChanges(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) =>
    WATCHED_PATHSPECS.some((watched) => path === watched || path.startsWith(`${watched}/`)),
  );
}

function collectChangedPaths(): string[] {
  const paths: string[] = [];
  for (const pathspec of WATCHED_PATHSPECS) {
    for (const change of listGitChanges(pathspec)) paths.push(change.path);
  }
  return paths;
}

export function runLikeC4ValidateCheck(): LikeC4ValidateResult {
  let changedPaths: string[];
  try {
    changedPaths = collectChangedPaths();
  } catch (error) {
    // base ref が解決できない環境（shallow clone 等）では検証を諦める。止めはしない。
    return {
      outcome: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!hasWatchedChanges(changedPaths)) return { outcome: 'skipped' };

  const result = spawnSync('pnpm', ['dlx', `likec4@${LIKEC4_VERSION}`, 'validate', MODEL_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    // dlx の取得を含めても通常は数十秒。固まったまま CI を占有しないよう上限を置く。
    timeout: 300_000,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const tail = output.split('\n').slice(-20).join('\n');

  // likec4 を取得できない（ネットワーク断・registry 障害）のと、DSL が無効なのは別扱い。
  if (result.error !== undefined) return { outcome: 'unavailable', detail: result.error.message };
  if (result.status !== 0) return { outcome: 'invalid', detail: tail };
  return { outcome: 'valid' };
}

/** advisory なので常に true を返す。失敗は annotation と標準出力で見せる。 */
export function reportLikeC4ValidateCheck(result: LikeC4ValidateResult): boolean {
  switch (result.outcome) {
    case 'skipped':
      console.log(
        `${colors.green}✅ likec4-validate: 対象の変更なし（scripts/lib/architecture-map / ${MODEL_DIR}）${colors.reset}`,
      );
      return true;
    case 'valid':
      console.log(`${colors.green}✅ likec4-validate: model は valid${colors.reset}`);
      return true;
    case 'unavailable':
      console.log(
        `${colors.yellow}⚠️ likec4-validate: 実行できなかった（${result.detail ?? '理由不明'}）${colors.reset}`,
      );
      return true;
    case 'invalid':
      console.log(`${colors.red}⚠️ likec4-validate: model が invalid（advisory）${colors.reset}`);
      console.log(result.detail ?? '');
      console.log(
        `   再現: pnpm dlx likec4@${LIKEC4_VERSION} validate ${MODEL_DIR}\n` +
          `   直す場所は生成器（scripts/lib/architecture-map/likec4-model.ts）。.c4 を手で直さない。`,
      );
      // PR の Checks 画面に出す（ログの奥に埋もれると気づかれないため）
      console.log(
        `::warning file=scripts/lib/architecture-map/likec4-model.ts::LikeC4 model が invalid です。pnpm dlx likec4@${LIKEC4_VERSION} validate ${MODEL_DIR} で再現できます`,
      );
      return true;
  }
}
