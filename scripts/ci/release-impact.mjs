/**
 * この push が走らせるべき層 3（E2E / Web Build & E2E）を決める。
 *
 * `promote.yml` の impact job から呼ばれ、`product_affected` / `web_affected` を
 * `GITHUB_OUTPUT` へ出す。promote する SHA に対して層 3 を必ず走らせる（#2382 の
 * 「赤い main はユーザーへ届かない」前提は merge 連動 promote で反転する）が、
 * 影響のある suite だけに絞ることで per-merge の実行時間を最小化する。
 *
 * **判定基準は「その project が今配信している SHA」→ target SHA の差分**であって、
 * push の前後（`github.event.before`..`github.sha`）ではない。push 範囲で判定すると
 * 次が起きる: push A（product 変更）の E2E が赤 → promote されず live は L のまま →
 * push B（docs のみ）の run が「product 変更なし」と判定して E2E を skip →
 * release job の `production-release.mjs` は L..B を自分で判定するので A の未検証
 * コードごと promote する。live 基準なら run B が E2E を走らせるので、この経路が閉じる。
 *
 * 判定不能はすべて affected（fail closed = テストを走らせる側）へ倒す。
 * `resolveProjectImpact` 自身も同じ原則で throw しない設計。
 *
 * 前提: Vercel の Ignored Build Step は production build を決して skip しない
 * （`scripts/ci/impact.mjs` の `resolveVercelIgnore`、PR #1835）。docs のみの merge でも
 * candidate deployment が必ず存在するため、release job が待ち続けることはない。
 */

import { appendFileSync } from 'node:fs';

import { resolveImpact } from './impact.mjs';

import {
  IMPACT_WIRING,
  RELEASE_PROJECTS,
  getProjectState,
  gitDiffFiles,
  gitHeadSha,
  resolveProjectImpact,
} from './production-release.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `GITHUB_OUTPUT` へ出すキー。promote.yml の `needs.impact.outputs.*` と 1:1。 */
export const IMPACT_OUTPUT_KEYS = [
  ...IMPACT_WIRING.map((wiring) => wiring.outputKey),
  'storybook_affected',
];

/** 配信中の両 app から Storybook の依存差分を見る。判定不能は実行側へ倒す。 */
export function resolveStorybookImpact({
  baseSha,
  targetSha,
  checkoutAtTarget = true,
  diffFilesImpl = gitDiffFiles,
}) {
  if (!SHA_PATTERN.test(baseSha ?? '') || !SHA_PATTERN.test(targetSha ?? '') || !checkoutAtTarget)
    return true;
  if (baseSha === targetSha) return false;
  try {
    const files = diffFilesImpl(baseSha, targetSha);
    if (files.length === 0) return false;
    const impact = resolveImpact(files);
    return (
      impact.product ||
      impact.web ||
      files.some(
        (file) =>
          file.startsWith('apps/storybook/') ||
          file === '.github/workflows/promote.yml' ||
          file === '.github/actions/setup/action.yml' ||
          file === 'scripts/tasks/check-story-coverage.ts' ||
          file === 'scripts/lib/story-test-collection.ts' ||
          file === 'scripts/ci/release-impact.mjs',
      )
    );
  } catch {
    return true;
  }
}

/**
 * 全 project の「promote 前に層 3 を走らせる必要があるか」を返す。
 *
 * 引数の `*Impl` は test が外部依存を差し替えるためだけの口。実行時は既定を使う。
 */
export async function resolveReleaseImpact({
  sha,
  token,
  teamId,
  // `production-release.mjs` の `runProductionRelease` と同じ既定にする。
  // **undefined のままにしてはいけない** —— `callVercel` は `fetchImpl(url, init)` を
  // 直接呼ぶため、渡さないと全 project が「cannot read live production:
  // fetchImpl is not a function」で affected へ倒れ、影響判定が常に全実行になる
  // （安全側だが、影響のある suite だけ走らせるという設計が丸ごと死ぬ）。
  fetchImpl = fetch,
  projects = RELEASE_PROJECTS,
  headShaImpl = gitHeadSha,
  projectStateImpl = getProjectState,
  projectImpactImpl = resolveProjectImpact,
  storybookImpactImpl = resolveStorybookImpact,
}) {
  // target SHA が壊れている時点で live との diff は取れない。全 suite を走らせる。
  if (!SHA_PATTERN.test(sha ?? '')) {
    return projects.map((project) => ({
      project,
      affected: true,
      storybookAffected: true,
      reason: 'release target SHA is not a 40 character SHA (fail closed)',
    }));
  }

  const checkoutAtTarget = headShaImpl() === sha;
  const results = [];

  for (const project of projects) {
    try {
      const state = await projectStateImpl({
        projectName: project.name,
        productionDomain: project.productionDomain,
        token,
        teamId,
        fetchImpl,
      });
      const decision = projectImpactImpl({
        project,
        baseSha: state?.production?.sha,
        targetSha: sha,
        checkoutAtTarget,
      });
      results.push({
        project,
        ...decision,
        storybookAffected: storybookImpactImpl({
          baseSha: state?.production?.sha,
          targetSha: sha,
          checkoutAtTarget,
        }),
      });
    } catch (error) {
      // Vercel API の失敗（token 失効・障害・rate limit）はここへ落ちる。
      // 判定できないなら層 3 を走らせる側へ倒す。
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        project,
        affected: true,
        storybookAffected: true,
        reason: `cannot read live production: ${message} (fail closed)`,
      });
    }
  }

  return results;
}

/** `key=value` 行の組み立て。GITHUB_OUTPUT が無い環境（ローカル実行）でも値を返す。 */
export function formatOutputs(results) {
  return results
    .map(({ project, affected }) => `${project.impactKey}_affected=${affected ? 'true' : 'false'}`)
    .concat(
      `storybook_affected=${results.some((result) => result.storybookAffected !== false) ? 'true' : 'false'}`,
    )
    .join('\n');
}

function appendTo(envPath, body) {
  if (!envPath) return;
  appendFileSync(envPath, `${body}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveReleaseImpact({
    sha: process.env.RELEASE_SHA,
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
  })
    .then((results) => {
      appendTo(process.env.GITHUB_OUTPUT, formatOutputs(results));
      appendTo(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## Release Impact',
          '',
          ...results.map(
            ({ project, affected, reason }) =>
              `- ${project.name}: ${affected ? '**affected**' : 'unaffected'} — ${reason}`,
          ),
        ].join('\n'),
      );
      for (const { project, affected, reason } of results) {
        console.log(`${project.name}: ${affected ? 'affected' : 'unaffected'} — ${reason}`);
      }
    })
    .catch((error) => {
      // resolveReleaseImpact は project 単位で catch するのでここへは来ない想定だが、
      // 来た場合も「層 3 を走らせる」側へ倒す。無出力のまま終わると promote.yml の
      // `outputs.* == 'true'` が偽になり、テストを走らせずに release が動く。
      const message = error instanceof Error ? error.message : String(error);
      console.error(`::error::release impact resolution failed: ${message}`);
      appendTo(
        process.env.GITHUB_OUTPUT,
        IMPACT_OUTPUT_KEYS.map((key) => `${key}=true`).join('\n'),
      );
      process.exitCode = 1;
    });
}
