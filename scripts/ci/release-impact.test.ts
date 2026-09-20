import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatOutputs,
  resolveReleaseImpact,
  resolveStorybookBase,
  resolveStorybookImpact,
} from './release-impact.mjs';

/**
 * merge 連動 promote（#2526 の nightly 案を置換）の層 3 起動判定。
 *
 * 守る不変条件は 1 つ: **判定できない時は必ず affected（= テストを走らせる）へ倒す**。
 * ここが fail open に転ぶと、未検証の main が promote される。
 */

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const PROJECTS = [
  { name: 'web', impactKey: 'web', productionDomain: 'dayopt.app' },
  { name: 'product', impactKey: 'product', productionDomain: 'app.dayopt.app' },
];

type Decision = { affected: boolean; reason: string };

function run(options: {
  sha?: string;
  headSha?: string | null;
  state?: (projectName: string) => Promise<unknown>;
  impact?: (args: { project: { name: string } }) => Decision;
}) {
  return resolveReleaseImpact({
    sha: options.sha ?? SHA,
    token: 'token',
    teamId: 'team',
    projects: PROJECTS as never,
    headShaImpl: () => (options.headSha === undefined ? SHA : options.headSha),
    projectStateImpl: (async ({ projectName }: { projectName: string }) =>
      options.state
        ? await options.state(projectName)
        : { production: { sha: OTHER_SHA } }) as never,
    storybookImpactImpl: () => false,
    projectImpactImpl: (options.impact ?? (() => ({ affected: true, reason: 'stub' }))) as never,
  });
}

describe('release impact（層 3 の起動判定）', () => {
  it('project ごとに判定を返し、GITHUB_OUTPUT 行へ落とす', async () => {
    const results = await run({
      impact: ({ project }) =>
        project.name === 'web'
          ? { affected: false, reason: 'no web impact' }
          : { affected: true, reason: 'changed' },
    });

    expect(formatOutputs(results)).toBe(
      'web_affected=false\nproduct_affected=true\nstorybook_affected=false',
    );
  });

  it('live production SHA を基準に判定する（push 範囲ではない）', async () => {
    let seenBase: string | undefined;
    await run({
      state: async () => ({ production: { sha: OTHER_SHA } }),
      impact: ((args: { baseSha: string }) => {
        seenBase = args.baseSha;
        return { affected: false, reason: 'stub' };
      }) as never,
    });

    // push の parent ではなく、alias が指している deployment の SHA が base になる。
    expect(seenBase).toBe(OTHER_SHA);
  });

  it('再配備で名指しされた project は、live が target SHA でも層 3 を走らせる（#2735）', async () => {
    const results = await resolveReleaseImpact({
      sha: SHA,
      token: 'token',
      teamId: 'team',
      projects: PROJECTS as never,
      headShaImpl: () => SHA,
      projectStateImpl: (async () => ({ production: { sha: SHA } })) as never,
      storybookImpactImpl: () => false,
      redeploy: { projectName: 'product', deploymentId: 'dpl_redeploy' } as never,
    });

    // 判定は実物の resolveProjectImpact に任せる（stub すると配線の欠落を見逃す）。
    expect(formatOutputs(results)).toBe(
      'web_affected=false\nproduct_affected=true\nstorybook_affected=false',
    );
  });

  it('promote.yml は再配備要求を impact と release の両 job へ同じ式で渡す', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/promote.yml'), 'utf8');
    const wiring = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('RELEASE_REDEPLOY:'));

    // 片方の job だけに渡ると、release が affected・impact が unaffected で必ず食い違う。
    expect(wiring).toHaveLength(2);
    expect(new Set(wiring).size).toBe(1);
    // push 起動の run に入力は無い。dispatch の時だけ読む。
    expect(wiring[0]).toContain("github.event_name == 'workflow_dispatch' && inputs.redeploy");
  });

  it('Vercel API が失敗した project は affected へ倒す（fail closed）', async () => {
    const results = await run({
      state: async (projectName) => {
        if (projectName === 'web') throw new Error('vercel 500');
        return { production: { sha: OTHER_SHA } };
      },
      impact: () => ({ affected: false, reason: 'no impact' }),
    });

    expect(formatOutputs(results)).toBe(
      'web_affected=true\nproduct_affected=false\nstorybook_affected=true',
    );
    expect(results[0].reason).toContain('vercel 500');
  });

  it('live production が読めない（alias 未解決）時も affected へ倒す', async () => {
    // getProjectState は alias が引けないと production: null を返す。
    // resolveProjectImpact 側の「current production SHA is unknown」経路へ渡る。
    let seenBase: unknown = 'not-called';
    const results = await run({
      state: async () => ({ production: null }),
      impact: ((args: { baseSha: unknown }) => {
        seenBase = args.baseSha;
        return { affected: true, reason: 'current production SHA is unknown (fail closed)' };
      }) as never,
    });

    expect(seenBase).toBeUndefined();
    expect(formatOutputs(results)).toBe(
      'web_affected=true\nproduct_affected=true\nstorybook_affected=false',
    );
  });

  it('target SHA が 40-hex でなければ API を叩かず全 project affected にする', async () => {
    let stateCalls = 0;
    const results = await run({
      sha: 'not-a-sha',
      state: async () => {
        stateCalls += 1;
        return { production: { sha: OTHER_SHA } };
      },
    });

    expect(stateCalls).toBe(0);
    expect(formatOutputs(results)).toBe(
      'web_affected=true\nproduct_affected=true\nstorybook_affected=true',
    );
  });

  it('fetchImpl を渡さなければ global fetch を既定にする', async () => {
    // `callVercel` は `fetchImpl(url, init)` を直接呼ぶ（既定を持たない）。ここで
    // undefined を渡すと全 project が「fetchImpl is not a function」で affected へ
    // 倒れ、fail closed ではあるが「影響のある suite だけ走らせる」設計が丸ごと死ぬ。
    // 他の test はすべて fake を注入するため、既定はここでしか検査されない。
    let seenFetch: unknown;
    await resolveReleaseImpact({
      sha: SHA,
      token: 'token',
      teamId: 'team',
      projects: PROJECTS as never,
      headShaImpl: () => SHA,
      projectStateImpl: (async ({ fetchImpl }: { fetchImpl: unknown }) => {
        seenFetch = fetchImpl;
        return { production: { sha: OTHER_SHA } };
      }) as never,
      projectImpactImpl: (() => ({ affected: false, reason: 'stub' })) as never,
    });

    expect(seenFetch).toBe(globalThis.fetch);
  });

  it('checkout が target SHA でない時はその旨を判定へ渡す（fail closed の材料）', async () => {
    let seenCheckoutAtTarget: unknown;
    await run({
      headSha: OTHER_SHA,
      impact: ((args: { checkoutAtTarget: boolean }) => {
        seenCheckoutAtTarget = args.checkoutAtTarget;
        return { affected: true, reason: 'stub' };
      }) as never,
    });

    expect(seenCheckoutAtTarget).toBe(false);
  });
});

describe('Storybook impact', () => {
  const decide = (files: string[]) =>
    resolveStorybookImpact({ baseSha: OTHER_SHA, targetSha: SHA, diffFilesImpl: () => files });
  it.each([
    'apps/product/src/a.tsx',
    'apps/web/src/a.tsx',
    'packages/components/src/a.tsx',
    'apps/storybook/.storybook/preview.tsx',
    'scripts/lib/story-test-collection.ts',
    '.github/workflows/promote.yml',
    '.github/actions/setup/action.yml',
    'pnpm-lock.yaml',
    'scripts/tasks/check-story-coverage.ts',
    'scripts/ci/release-impact.mjs',
  ])('%s の変更を検証する', (file) => {
    expect(decide([file])).toBe(true);
  });
  it('docs のみと同一 tree は免除する', () => {
    expect(decide(['docs/engineering/testing.md'])).toBe(false);
    expect(decide([])).toBe(false);
  });
  it('unknown SHA・checkout 不一致・diff 失敗は実行側に倒す', () => {
    expect(resolveStorybookImpact({ baseSha: undefined, targetSha: SHA })).toBe(true);
    expect(
      resolveStorybookImpact({ baseSha: OTHER_SHA, targetSha: SHA, checkoutAtTarget: false }),
    ).toBe(true);
    expect(
      resolveStorybookImpact({
        baseSha: OTHER_SHA,
        targetSha: SHA,
        diffFilesImpl: () => {
          throw new Error('diff failed');
        },
      }),
    ).toBe(true);
  });
  it('どちらかの配信中SHAからStory変更があれば実行する', () => {
    expect(
      formatOutputs([
        { project: PROJECTS[0], affected: false, storybookAffected: false },
        { project: PROJECTS[1], affected: false, storybookAffected: true },
      ] as never),
    ).toContain('storybook_affected=true');
  });
});

describe('Storybook の共通基準', () => {
  const recent = 'c'.repeat(40);
  const history = [OTHER_SHA, recent, SHA];
  const ancestor = (from: string, to: string) => history.indexOf(from) <= history.indexOf(to);

  it.each(['web', 'product'])(
    '片方だけ昇格済みでも docs-only で過去の %s 変更を再検査しない',
    async (advanced) => {
      const bases: string[] = [];
      const results = await resolveReleaseImpact({
        sha: SHA,
        token: 'token',
        teamId: 'team',
        projects: PROJECTS as never,
        headShaImpl: () => SHA,
        projectStateImpl: (async ({ projectName }: { projectName: string }) => ({
          production: { sha: projectName === advanced ? recent : OTHER_SHA },
        })) as never,
        projectImpactImpl: () => ({ affected: false, reason: 'docs only' }),
        isAncestorImpl: ancestor,
        storybookImpactImpl: (options) =>
          resolveStorybookImpact({
            ...options,
            diffFilesImpl: (base: string) => {
              bases.push(base);
              return base === recent ? ['docs/README.md'] : [`apps/${advanced}/src/page.tsx`];
            },
          }),
      });
      expect(bases).toEqual([recent]);
      expect(formatOutputs(results)).toContain('storybook_affected=false');
    },
  );

  it('新しい共通基準以降の未昇格 UI 変更は検査する', () => {
    const baseSha = resolveStorybookBase({
      baseShas: [OTHER_SHA, recent],
      targetSha: SHA,
      isAncestorImpl: ancestor,
    });
    expect(
      resolveStorybookImpact({
        baseSha,
        targetSha: SHA,
        diffFilesImpl: () => ['apps/product/src/page.tsx'],
      }),
    ).toBe(true);
  });

  it.each([false, null])('target の祖先と確認できない配信 SHA は免除しない (%s)', (ancestry) => {
    const baseSha = resolveStorybookBase({
      baseShas: [OTHER_SHA, recent],
      targetSha: SHA,
      isAncestorImpl: () => ancestry,
    });
    expect(resolveStorybookImpact({ baseSha, targetSha: SHA })).toBe(true);
  });

  it('両方が target の祖先でも配信履歴が分岐していれば免除しない', () => {
    expect(
      resolveStorybookBase({
        baseShas: [OTHER_SHA, recent],
        targetSha: SHA,
        isAncestorImpl: (from: string, to: string) => from === to || to === SHA,
      }),
    ).toBeUndefined();
  });

  it('配信 SHA の欠落を古い片方の情報で補わない', () => {
    expect(
      resolveStorybookBase({
        baseShas: [OTHER_SHA, undefined],
        targetSha: SHA,
        isAncestorImpl: ancestor,
      }),
    ).toBeUndefined();
  });
});
