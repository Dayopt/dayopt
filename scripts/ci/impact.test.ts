import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PRODUCT_BUILD_SCRIPTS,
  formatGithubOutput,
  formatSummary,
  readWorkspaceGraph,
  resolveImpact,
  resolveVercelIgnore,
} from './impact.mjs';

/**
 * Impact Resolver は merge gate / release / CI が共有する影響判定の正本。
 * 判定を誤ると「必要な検証を skip してマージする」方向に倒れるため、
 * 変更ファイル fixture のテーブルで期待値を固定する。
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Impact = {
  product: boolean;
  web: boolean;
  integration: boolean;
  productJourney: boolean;
  productUnit: boolean;
  webCi: boolean;
  webPreviewSmoke: boolean;
  docsOnly: boolean;
  unknown: string[];
};

/**
 * 期待値を書きやすくする省略形。省略キーは false 扱い。
 * ただし `productUnit` / `webCi` の既定だけは `product` / `web` と同値にする
 * （ずれるのは CI toolchain の変更だけなので、そのケースだけ明示的に書けばよい）。
 */
function expectImpact(files: string[], expected: Partial<Impact>) {
  const impact = resolveImpact(files) as Impact;
  const full: Omit<Impact, 'unknown'> = {
    product: false,
    web: false,
    integration: false,
    productJourney: false,
    productUnit: expected.product === true,
    webCi: expected.web === true,
    webPreviewSmoke: false,
    docsOnly: false,
    ...expected,
  };
  expect({
    product: impact.product,
    web: impact.web,
    integration: impact.integration,
    productJourney: impact.productJourney,
    productUnit: impact.productUnit,
    webCi: impact.webCi,
    webPreviewSmoke: impact.webPreviewSmoke,
    docsOnly: impact.docsOnly,
  }).toEqual(full);
  return impact;
}

describe('workspace 依存グラフ', () => {
  it('product / web 共通の package は両方から reachable（現在の manifest の固定）', () => {
    // このテストが落ちたら manifest が変わったということ。期待値を現実に合わせて
    // 更新すればよい（resolver 側は自動追従している）。
    // `packages/domain` は consumer が product のみだったため #2168 で
    // `apps/product/src/lib/time` へ統合済み（workspace package から除外）。
    const graph = readWorkspaceGraph() as Map<string, Set<string>>;
    expect(graph.get('packages/config')).toEqual(new Set(['product', 'web']));
    expect(graph.get('packages/i18n')).toEqual(new Set(['product', 'web']));
    expect(graph.get('packages/components')).toEqual(new Set(['product', 'web']));
  });
});

describe('docs のみの変更', () => {
  it.each([
    [['docs/strategy.md']],
    [['AGENTS.md', 'CLAUDE.md', 'README.md']],
    [['docs/decisions.md', '.claude/skills/dispatch/SKILL.md']],
    [['docs/engineering/conventions.md', 'docs/README.md']],
  ])('%j は docsOnly=true で app build を要求しない', (files) => {
    expectImpact(files, { docsOnly: true });
  });

  it('rls-snapshot.md は docsOnly でも integration を要求する', () => {
    // INTEGRATION_GLOBS に含まれる docs ファイル。docsOnly の shortcut で
    // integration まで消してはいけない。
    expectImpact(['docs/engineering/data/db/rls-snapshot.md'], {
      docsOnly: true,
      integration: true,
    });
  });
});

describe('app とその依存', () => {
  it('apps/product のみ → product 側だけ', () => {
    expectImpact(['apps/product/src/components/Button.tsx'], {
      product: true,
      productJourney: true,
    });
  });

  it('apps/product の server 境界 → integration も要求する', () => {
    expectImpact(['apps/product/src/features/tags/server/router.ts'], {
      product: true,
      productJourney: true,
      integration: true,
    });
  });

  it('apps/web のみ → web 側だけ', () => {
    expectImpact(['apps/web/src/app/page.tsx', 'apps/web/content/blog/en/hello.mdx'], {
      web: true,
      webPreviewSmoke: true,
    });
  });

  it('apps/product/src/lib/time（旧 packages/domain）→ product のみ、integration も要求', () => {
    expectImpact(['apps/product/src/lib/time/time-conflict.ts'], {
      product: true,
      productJourney: true,
      integration: true, // apps/product/src/lib/time/** は INTEGRATION_GLOBS に含まれる
    });
  });

  it('共通 package（config）→ 両方', () => {
    expectImpact(['packages/config/src/env.ts'], {
      product: true,
      web: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
  });

  it('supabase/migrations → product + integration', () => {
    expectImpact(['supabase/migrations/20260804000000_add_table.sql'], {
      product: true,
      productJourney: true,
      integration: true,
    });
  });

  it('root の build 入力（pnpm-lock.yaml）→ 両方 + integration', () => {
    expectImpact(['pnpm-lock.yaml'], {
      product: true,
      web: true,
      productJourney: true,
      webPreviewSmoke: true,
      integration: true, // INTEGRATION_GLOBS に含まれる
    });
  });

  it('.npmrc は両方を要求する（pnpm の依存解決設定は install 結果を変える）', () => {
    // auto-install-peers / strict-peer-dependencies は両 app の install 結果＝build
    // 対象を左右する。lockfile の diff を伴わない単独変更がありうるため、中立に倒すと
    // install 起因の build 失敗を検証しないまま merge できる。
    expectImpact(['.npmrc'], {
      product: true,
      web: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
  });

  it('docs と product の混在は docsOnly=false', () => {
    expectImpact(['docs/README.md', 'apps/product/src/app/layout.tsx'], {
      product: true,
      productJourney: true,
    });
  });
});

describe('中立 path（app 成果物に影響しない）', () => {
  it.each([
    [['scripts/tasks/finish-branch.sh', 'scripts/__tests__/finish-branch.test.ts']],
    // impact.mjs 自身も中立。トレードオフを明示して固定する: ignoreCommand の実動作
    // （shallow clone / exit code 変換）を変えた PR は実 Vercel 経路を通らずに merge
    // できるが、誤りは fail open（exit 非 0 = build 続行）に倒れるため integrity は
    // 崩れない。wrong-skip 方向の regression は本ファイルの unit test が防波堤になる。
    [['scripts/ci/impact.mjs', 'scripts/ci/impact.test.ts']],
    [['scripts/hooks/pre-tool-guard.mjs', '.claude/settings.json']],
    [['.husky/pre-push', '.vscode/settings.json']],
    [['apps/storybook/.storybook/main.ts']],
    [['eslint.config.mjs', '.prettierrc', 'vitest.scripts.config.ts']],
    // static / scripts の検査が入力として読む設定。未分類のままだと unknown に載り、
    // validation-plan 側で migration の無い PR が隔離 DB を待って恒久 blocked になる
    // （#2811 / PR #2868）。app の bundle にも runtime 挙動にも入らない
    [['.gitleaks.toml', '.boundary-budget.json']],
    [['.op-env.agent.example', '.op-env.human.example']],
    [['lint-staged.config.mjs', 'tsconfig.scripts.json']],
  ])('%j は app build を要求しない', (files) => {
    expectImpact(files, {});
  });

  it('.github の integration 対象（setup action）は integration を要求する', () => {
    // productUnit / webCi も true になる（下の「CI toolchain」describe が理由を固定する）。
    expectImpact(['.github/actions/setup/action.yml'], {
      integration: true,
      productUnit: true,
      webCi: true,
    });
  });

  it('nightly.yml の変更は integration を要求する（共有部品経由の影響を安全側へ倒す）', () => {
    // #2483 で旧 integration.yml から統合。nightly.yml は CI_TOOLCHAIN_FILES には
    // 含まれないため productUnit / webCi は誘発しない（setup action とは違う扱い）。
    expectImpact(['.github/workflows/nightly.yml'], { integration: true });
  });

  it('ci.yml / check.mjs（integration job の配線を持つ）の変更は integration を要求する', () => {
    // #2539 で integration を独立 job へ切り出したことによる変更。**job まるごとが
    // `if:` で skip されうる**ようになったため、配線を変えた PR で integration=false に
    // なると、Supabase 起動〜`check.mjs integration` が一度も実走しないまま merge できる。
    // job 分割前は「単一 test job が必ず走り、中の条件分岐だけが未検証」だったので
    // 中立で済んでいた（下の CI toolchain describe が旧線引きの残りを固定する）。
    expectImpact(['.github/workflows/ci.yml'], { integration: true });
    expectImpact(['scripts/ci/check.mjs'], { integration: true });
  });
});

/**
 * `productUnit` は「Actions 上で product の unit test を走らせるか」で、
 * `product`（Vercel build / release を走らせるか）とは別物。CI の toolchain を
 * 変えた PR で **前者だけ** true になることを固定する。
 */
describe('CI toolchain（productUnit / webCi と product / web の分離）', () => {
  it('setup action は Actions 側の実行キーだけを要求し、Vercel build は誘発しない', () => {
    const impact = expectImpact(['.github/actions/setup/action.yml'], {
      integration: true,
      productUnit: true,
      webCi: true,
    });
    // product が false のままであることが要点。true にすると merge gate が
    // `Vercel – product` context を要求し、Phase 4 で止めた preview build が復活する。
    expect(impact.product).toBe(false);
    expect(impact.web).toBe(false);
  });

  it('ci.yml はあえて productUnit を要求しない（意図的な線引き）', () => {
    // ci.yml を変えた PR ではその新しい ci.yml 自体が実行されるため、gate 判定・
    // job 構成・無条件 step は検証される。ここを productUnit に含めると
    // product=false な PR の 1/3（実測 19 件中 7 件）で skip できなくなる。
    //
    // **integration は別**（#2539 の job 分割で INTEGRATION_GLOBS へ追加済み）。
    // unit job は ci.yml を変えた PR で必ず走る（＝この線引きが今も成立する）が、
    // integration job は job ごと skip されうるため同じ理屈が通らない。
    const impact = expectImpact(['.github/workflows/ci.yml'], { integration: true });
    expect(impact.productUnit).toBe(false);
    expect(impact.product).toBe(false);
  });

  it('product 変更と同時なら productUnit も当然 true', () => {
    expectImpact(['.github/actions/setup/action.yml', 'apps/product/src/app/layout.tsx'], {
      product: true,
      productJourney: true,
      productUnit: true,
      webCi: true,
      integration: true,
    });
  });
});

describe('Vercel の build が実行する root script', () => {
  it('DB型生成ラッパー単独の変更でもintegrationを実行する', () => {
    expectImpact(['scripts/tasks/generate-database-types.mjs'], { integration: true });
  });

  it.each([
    ['scripts/tasks/check-client-bundle-secrets.mjs'],
    ['scripts/tasks/check-bundle-budget.ts'],
  ])('%s は product を要求する（scripts/ の中立扱いより優先）', (file) => {
    // これらは apps/product/vercel.json の buildCommand（verify:bundle）が直接実行する。
    // 中立に倒すと product=false になり、変更した当の検証を走らせないまま merge できる。
    expectImpact([file], { product: true, productJourney: true });
  });

  it('build に関与しない scripts/ は従来どおり中立', () => {
    expectImpact(['scripts/tasks/finish-branch.sh'], {});
  });

  it('patches/ は両 app の build 入力（pnpm patchedDependencies）', () => {
    // install 時に node_modules を書き換えるので中立ではない。未分類（unknown）でもない
    // ——unknown は validation-plan 側で隔離 DB を要求し、migration の無い PR を
    // 恒久 blocked にする（#2811 / PR #2868）
    expectImpact(['patches/image-size@2.0.2.patch'], {
      product: true,
      web: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
    expect(resolveImpact(['patches/image-size@2.0.2.patch']).unknown).toEqual([]);
  });

  it('PRODUCT_BUILD_SCRIPTS が product の build 定義と一致する（drift 検出）', () => {
    // 手で書いた集合は、buildCommand や verify:bundle に script が足された時に腐る。
    // manifest から導出した実際の参照集合と突き合わせて、追加漏れを機械的に捕まえる。
    const vercelConfig = JSON.parse(
      readFileSync(join(rootDir, 'apps/product/vercel.json'), 'utf8'),
    ) as { buildCommand: string };
    const packageJson = JSON.parse(
      readFileSync(join(rootDir, 'apps/product/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    // buildCommand から `pnpm <script>` を再帰展開し、root scripts/ への参照を集める
    const expandCommand = (command: string, seen = new Set<string>()): string[] => {
      const expanded = [command];
      for (const [, name] of command.matchAll(/pnpm\s+([\w:-]+)/g)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const script = packageJson.scripts[name];
        if (script) expanded.push(...expandCommand(script, seen));
      }
      return expanded;
    };

    const referenced = new Set(
      expandCommand(vercelConfig.buildCommand)
        .flatMap((command) => [...command.matchAll(/\.\.\/\.\.\/(scripts\/[\w./-]+)/g)])
        .map(([, path]) => path),
    );

    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].sort()).toEqual([...(PRODUCT_BUILD_SCRIPTS as Set<string>)].sort());
  });
});

describe('vercel.json ignoreCommand contract（Vercel Ignored Build Step）', () => {
  // apps/{product,web}/vercel.json の `ignoreCommand` が壊れると、Vercel の build container が
  // その project の全 deployment を無条件 build（コマンド解決失敗は exit != 0 = build 継続なので
  // 安全側だが Impact Resolver の判定が一切効かなくなる）に倒れる。path は Root Directory 基準の
  // 相対 path（`../../scripts/ci/impact.mjs`）で書く必要があり、CLI 引数は project 名と一致する
  // 必要がある。この 2 点を固定する。
  it.each([
    ['apps/product/vercel.json', 'apps/product', 'product'],
    ['apps/web/vercel.json', 'apps/web', 'web'],
  ])(
    '%s は scripts/ci/impact.mjs --vercel %s を正しい相対 path で呼ぶ',
    (configPath, appDir, projectKey) => {
      const config = JSON.parse(readFileSync(join(rootDir, configPath), 'utf8')) as {
        ignoreCommand?: string;
      };

      expect(config.ignoreCommand).toBe(`node ../../scripts/ci/impact.mjs --vercel ${projectKey}`);

      // Root Directory（appDir）が build container の cwd になる前提で相対 path を組んでいる。
      // ここから実際に解決した絶対 path が scripts/ci/impact.mjs と一致することを確認する
      // （深さがずれる、あるいは app を追加して階層が変わった時に drift を検出する）。
      const match = config.ignoreCommand?.match(/^node (\S+) --vercel \S+$/);
      expect(match).not.toBeNull();
      const resolvedScriptPath = resolve(join(rootDir, appDir), match![1]);
      expect(resolvedScriptPath).toBe(join(rootDir, 'scripts/ci/impact.mjs'));
    },
  );
});

describe('fail closed', () => {
  it('未知の root ファイルは全 affected に倒す', () => {
    const impact = expectImpact(['mystery.config.xyz'], {
      product: true,
      web: true,
      integration: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
    expect(impact.unknown).toEqual(['mystery.config.xyz']);
  });

  it('未知の packages ディレクトリも全 affected に倒す', () => {
    // manifest の無い package（作りかけ・rename 直後）を「影響なし」と
    // 誤判定しないこと。
    expectImpact(['packages/brand-new/src/index.ts'], {
      product: true,
      web: true,
      integration: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
  });

  it('docs と未知の混在を docsOnly と誤判定しない', () => {
    expectImpact(['docs/README.md', 'mystery.config.xyz'], {
      product: true,
      web: true,
      integration: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
  });

  it('空の変更一覧は判定不能として全 affected に倒す', () => {
    // 「影響なし」と「ファイル一覧を取得できなかった」を区別できないため、
    // 空入力を green に流さない。
    expectImpact([], {
      product: true,
      web: true,
      integration: true,
      productJourney: true,
      webPreviewSmoke: true,
    });
  });
});

describe('CLI', () => {
  it('--stdin で newline 区切りの一覧を受け、JSON を返す', () => {
    const result = spawnSync('node', [join(rootDir, 'scripts/ci/impact.mjs'), '--stdin'], {
      input: 'apps/product/src/foo.ts\ndocs/README.md\n',
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const impact = JSON.parse(result.stdout) as Impact;
    expect(impact.product).toBe(true);
    expect(impact.web).toBe(false);
    expect(impact.docsOnly).toBe(false);
  });

  it('--summary は Markdown を返し、未知 path の警告を含む', () => {
    const result = spawnSync(
      'node',
      [join(rootDir, 'scripts/ci/impact.mjs'), '--stdin', '--summary'],
      {
        input: 'mystery.config.xyz\n',
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Impact Resolver');
    expect(result.stdout).toContain('未知の path');
  });

  it('--github-output は GITHUB_OUTPUT 向けの key=value を返す', () => {
    const result = spawnSync(
      'node',
      [join(rootDir, 'scripts/ci/impact.mjs'), '--stdin', '--github-output'],
      { input: 'scripts/ci/impact.mjs\n', encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'docs_only=false\nproduct_unit=false\nweb_ci=false\nintegration=false\nmcp_conformance=true\n',
    );
  });
});

/**
 * ci.yml の gate job が各 job / step の `if:` に配る値。**skip 側の真偽が
 * キーごとに逆**（docs_only は true が skip、product / web は false が skip）なので、
 * 判定できない時の既定値も逆向きになる。この対称性が崩れると「検証せずに
 * required check が success」になるため、両方向を固定する。
 */
describe('formatGithubOutput', () => {
  it('product に影響する変更では product=true / web_ci=false / integration=false', () => {
    expect(formatGithubOutput(resolveImpact(['apps/product/src/foo.ts']))).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=false\nintegration=false\nmcp_conformance=false\n',
    );
  });

  it('web に影響する変更では web_ci=true / product=false / integration=false', () => {
    expect(formatGithubOutput(resolveImpact(['apps/web/src/foo.ts']))).toBe(
      'docs_only=false\nproduct_unit=false\nweb_ci=true\nintegration=false\nmcp_conformance=false\n',
    );
  });

  it('CI toolchain の変更は web_ci=true（web は false のまま）・integration=true', () => {
    // productUnit と同じ非対称。web:job も同じ setup action で動くため Actions 上の
    // build + E2E は走らせたいが、`web` に倒すと Vercel の web preview build まで
    // 誘発してしまう（Phase 4 で止めたもの）。`.github/actions/setup/action.yml` は
    // INTEGRATION_GLOBS にも含まれるため integration=true になる。
    const impact = resolveImpact(['.github/actions/setup/action.yml']) as Impact;
    expect(impact.web).toBe(false);
    expect(formatGithubOutput(impact)).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=true\nintegration=true\nmcp_conformance=true\n',
    );
  });

  it('公開コンテンツ（apps/web/content）の変更は web_ci=true / integration=false', () => {
    expect(formatGithubOutput(resolveImpact(['apps/web/content/blog/en/foo.mdx']))).toBe(
      'docs_only=false\nproduct_unit=false\nweb_ci=true\nintegration=false\nmcp_conformance=false\n',
    );
  });

  it('中立 path のみの変更では product=false（Unit の product test を skip できる）・integration=false', () => {
    expect(formatGithubOutput(resolveImpact(['scripts/tasks/finish-branch.sh']))).toBe(
      'docs_only=false\nproduct_unit=false\nweb_ci=false\nintegration=false\nmcp_conformance=false\n',
    );
  });

  it('docs のみの変更では docs_only=true・integration=false', () => {
    expect(formatGithubOutput(resolveImpact(['docs/README.md']))).toBe(
      'docs_only=true\nproduct_unit=false\nweb_ci=false\nintegration=false\nmcp_conformance=false\n',
    );
  });

  it('判定不能（変更ファイル一覧が空）は全キーとも実行側に倒す', () => {
    expect(formatGithubOutput(resolveImpact([]))).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=true\nintegration=true\nmcp_conformance=true\n',
    );
  });

  it('未知 path を含む変更は全キーとも実行側に倒す', () => {
    expect(formatGithubOutput(resolveImpact(['mystery.config.xyz']))).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=true\nintegration=true\nmcp_conformance=true\n',
    );
  });

  it('impact が壊れていても実行側に倒す（fail closed）', () => {
    expect(formatGithubOutput(undefined)).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=true\nintegration=true\nmcp_conformance=true\n',
    );
    expect(formatGithubOutput({})).toBe(
      'docs_only=false\nproduct_unit=true\nweb_ci=true\nintegration=true\nmcp_conformance=true\n',
    );
  });
});

describe('formatSummary', () => {
  it('全キーを表に含める', () => {
    const summary = formatSummary(resolveImpact(['apps/product/src/foo.ts'])) as string;
    for (const key of [
      'product',
      'web',
      'integration',
      'productJourney',
      'webPreviewSmoke',
      'docsOnly',
    ]) {
      expect(summary).toContain(key);
    }
  });
});

/**
 * `resolveVercelIgnore` の純粋ロジック部分。`diffFilesImpl` を差し替えて git を
 * spawn せずに fail open / fail closed の分岐だけを検証する（CLI 全体の実地検証は
 * 下の「Vercel Ignored Build Step CLI（実 git fixture）」で行う）。
 */
describe('resolveVercelIgnore（純粋ロジック）', () => {
  it('production build は変更内容によらず skip しない', () => {
    // VERCEL_GIT_PREVIOUS_SHA は「前回成功した build」であって live SHA ではない。
    // 未 promote の candidate を基準に skip すると、release（live SHA 基準）が存在
    // しない candidate を待ち続けて詰まる（PR #1835 Codex P1）。diff や resolver に
    // 到達する前に build へ倒れることを固定する。
    const result = resolveVercelIgnore({
      projectKey: 'product',
      prevSha: 'deadbeef',
      vercelEnv: 'production',
      diffFilesImpl: () => {
        throw new Error('must not be called for production builds');
      },
    });
    expect(result.shouldBuild).toBe(true);
    expect(result.reason).toContain('production build is never skipped');
  });

  it('VERCEL_GIT_PREVIOUS_SHA が無い場合は build に倒す（fail open）', () => {
    const result = resolveVercelIgnore({ projectKey: 'product', prevSha: undefined });
    expect(result.shouldBuild).toBe(true);
    expect(result.reason).toContain('VERCEL_GIT_PREVIOUS_SHA');
  });

  it('未知の project key は build に倒す（fail open）', () => {
    const result = resolveVercelIgnore({ projectKey: 'storybook', prevSha: 'deadbeef' });
    expect(result.shouldBuild).toBe(true);
    expect(result.reason).toContain('unknown Vercel project key');
  });

  it('git diff が失敗したら build に倒す（fail open。shallow clone で SHA が無い場合を模す）', () => {
    const result = resolveVercelIgnore({
      projectKey: 'product',
      prevSha: 'deadbeef',
      diffFilesImpl: () => {
        throw new Error('fatal: bad object deadbeef');
      },
    });
    expect(result.shouldBuild).toBe(true);
    expect(result.reason).toContain('fail open');
  });

  it('resolver が例外を投げたら build に倒す（fail open）', () => {
    const result = resolveVercelIgnore({
      projectKey: 'product',
      prevSha: 'deadbeef',
      diffFilesImpl: () => ['apps/product/x.ts'],
      resolveImpactImpl: () => {
        throw new Error('boom');
      },
    });
    expect(result.shouldBuild).toBe(true);
    expect(result.reason).toContain('fail open');
  });

  it('差分 0 件は skip に倒す（変更が無いという確定的な答え）', () => {
    const result = resolveVercelIgnore({
      projectKey: 'product',
      prevSha: 'deadbeef',
      diffFilesImpl: () => [],
    });
    expect(result.shouldBuild).toBe(false);
    expect(result.reason).toContain('no file changes');
  });

  it('product のみ変更 → product は build、web は skip', () => {
    const diffFilesImpl = () => ['apps/product/src/foo.ts'];
    expect(
      resolveVercelIgnore({ projectKey: 'product', prevSha: 'deadbeef', diffFilesImpl })
        .shouldBuild,
    ).toBe(true);
    expect(
      resolveVercelIgnore({ projectKey: 'web', prevSha: 'deadbeef', diffFilesImpl }).shouldBuild,
    ).toBe(false);
  });

  it('共有 package（packages/config）の変更 → product / web ともに build', () => {
    const diffFilesImpl = () => ['packages/config/src/env.ts'];
    expect(
      resolveVercelIgnore({ projectKey: 'product', prevSha: 'deadbeef', diffFilesImpl })
        .shouldBuild,
    ).toBe(true);
    expect(
      resolveVercelIgnore({ projectKey: 'web', prevSha: 'deadbeef', diffFilesImpl }).shouldBuild,
    ).toBe(true);
  });
});

/**
 * `--vercel <product|web>` CLI モードの実地検証。実 git repo fixture 上で実 CLI
 * process を spawn し、`apps/{product,web}/vercel.json` の `ignoreCommand` が呼ぶのと
 * 同じ経路（env 読み取り → git diff → resolveImpact → exit code）を通す。
 *
 * fixture は `os.tmpdir()` を `realpathSync` で解決してから作る。macOS は `/tmp` が
 * `/private/tmp` への symlink で、解決前の path を渡すと `resolve(process.argv[1])`
 * と `fileURLToPath(import.meta.url)`（Node が実 path で解決する）が食い違い、
 * 本体側の `isDirectRun` 判定が false になって CLI 分岐が丸ごと無反応になる
 * （出力なし・exit 0 のまま）。実 CI コンテナではこの症状は出ないが、ローカル
 * macOS での再現性を保つために先に解決しておく。
 */
describe('Vercel Ignored Build Step CLI（実 git fixture）', () => {
  let fixtureDir: string;
  let scriptPath: string;
  let initSha: string;
  let productOnlySha: string;
  let sharedPackageSha: string;

  function git(args: string[], cwd: string) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  function commit(cwd: string, message: string) {
    git(['add', '-A'], cwd);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', message], cwd);
    return git(['rev-parse', 'HEAD'], cwd);
  }

  function runCli(projectKey: string, cwd: string, env: Record<string, string | undefined>) {
    return spawnSync('node', [scriptPath, '--vercel', projectKey], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  beforeAll(() => {
    const rawTmp = mkdtempSync(join(tmpdir(), 'impact-vercel-fixture-'));
    fixtureDir = realpathSync(rawTmp);
    scriptPath = join(fixtureDir, 'scripts/ci/impact.mjs');

    mkdirSync(join(fixtureDir, 'scripts/ci'), { recursive: true });
    mkdirSync(join(fixtureDir, 'apps/product'), { recursive: true });
    mkdirSync(join(fixtureDir, 'apps/web'), { recursive: true });
    mkdirSync(join(fixtureDir, 'packages/config'), { recursive: true });
    mkdirSync(join(fixtureDir, 'packages/domain'), { recursive: true });
    cpSync(join(rootDir, 'scripts/ci/impact.mjs'), scriptPath);

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'fixture-root' }));
    writeFileSync(
      join(fixtureDir, 'apps/product/package.json'),
      JSON.stringify({
        name: '@dayopt/product',
        dependencies: { '@dayopt/config': 'workspace:*', '@dayopt/domain': 'workspace:*' },
      }),
    );
    writeFileSync(
      join(fixtureDir, 'apps/web/package.json'),
      JSON.stringify({ name: '@dayopt/web', dependencies: { '@dayopt/config': 'workspace:*' } }),
    );
    writeFileSync(
      join(fixtureDir, 'packages/config/package.json'),
      JSON.stringify({ name: '@dayopt/config' }),
    );
    writeFileSync(
      join(fixtureDir, 'packages/domain/package.json'),
      JSON.stringify({ name: '@dayopt/domain' }),
    );
    writeFileSync(join(fixtureDir, 'apps/product/a.txt'), 'a');
    writeFileSync(join(fixtureDir, 'apps/web/b.txt'), 'b');
    writeFileSync(join(fixtureDir, 'packages/config/index.ts'), 'export const config = 1;');
    writeFileSync(join(fixtureDir, 'packages/domain/index.ts'), 'export const domain = 1;');

    git(['init', '-q'], fixtureDir);
    initSha = commit(fixtureDir, 'init');

    writeFileSync(join(fixtureDir, 'apps/product/a.txt'), 'a2');
    productOnlySha = commit(fixtureDir, 'product only change');

    writeFileSync(join(fixtureDir, 'packages/config/index.ts'), 'export const config = 2;');
    sharedPackageSha = commit(fixtureDir, 'shared package change');
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('product のみ変更 → product は build（exit 1）、web は skip（exit 0）', () => {
    git(['checkout', '-q', productOnlySha], fixtureDir);

    const productResult = runCli('product', join(fixtureDir, 'apps/product'), {
      VERCEL_GIT_PREVIOUS_SHA: initSha,
    });
    expect(productResult.status).toBe(1);
    expect(productResult.stdout).toContain('BUILD');

    const webResult = runCli('web', join(fixtureDir, 'apps/web'), {
      VERCEL_GIT_PREVIOUS_SHA: initSha,
    });
    expect(webResult.status).toBe(0);
    expect(webResult.stdout).toContain('SKIP');
  });

  it('packages 共有変更（packages/config）→ product / web ともに build（exit 1）', () => {
    git(['checkout', '-q', sharedPackageSha], fixtureDir);

    const productResult = runCli('product', join(fixtureDir, 'apps/product'), {
      VERCEL_GIT_PREVIOUS_SHA: productOnlySha,
    });
    expect(productResult.status).toBe(1);

    const webResult = runCli('web', join(fixtureDir, 'apps/web'), {
      VERCEL_GIT_PREVIOUS_SHA: productOnlySha,
    });
    expect(webResult.status).toBe(1);
  });

  it('VERCEL_GIT_PREVIOUS_SHA が未設定 → build（exit 1、fail open）', () => {
    git(['checkout', '-q', productOnlySha], fixtureDir);

    const result = runCli('product', join(fixtureDir, 'apps/product'), {
      VERCEL_GIT_PREVIOUS_SHA: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VERCEL_GIT_PREVIOUS_SHA');
  });

  it('checkout の履歴に無い SHA → build（exit 1、fail open。shallow clone 相当）', () => {
    git(['checkout', '-q', productOnlySha], fixtureDir);

    const result = runCli('product', join(fixtureDir, 'apps/product'), {
      VERCEL_GIT_PREVIOUS_SHA: '0000000000000000000000000000000000dead',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fail open');
  });
});

describe('provider-neutral harness paths', () => {
  it.each(['.agents/skills/routing/SKILL.md', '.codex/README.md'])(
    'classifies %s as documentation',
    (file) => {
      expectImpact([file], { docsOnly: true });
    },
  );
  it.each([
    '.codex/hooks.json',
    '.codex/config.toml',
    '.agents/skills/review/runner.js',
    '.claude/skills',
  ])('keeps executable/config %s outside docs-only skipping', (file) => {
    expectImpact([file], { docsOnly: false });
  });
});

describe('MCP conformance impact', () => {
  it.each([
    'apps/product/src/app/api/mcp/_tools/registry.ts',
    'apps/product/src/app/mcp/route.ts',
    'apps/product/src/lib/mcp/auth.ts',
    'apps/product/src/lib/oauth-server/scopes.ts',
    'apps/product/scripts/mcp-conformance-expected-failures.yml',
    'apps/product/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/ci/impact.mjs',
    'scripts/ci/check.mjs',
    '.github/workflows/ci.yml',
  ])('%s runs protocol checks', (path) => {
    expect(resolveImpact([path]).mcpConformance).toBe(true);
  });
  it.each([
    'docs/operations/runbook.md',
    'apps/web/content/docs/ja/data/api-mcp.mdx',
    'apps/product/src/features/calendar/components/Calendar.tsx',
  ])('%s skips protocol checks', (path) => {
    expect(resolveImpact([path]).mcpConformance).toBe(false);
  });
  it('cannot silently skip on unknown or missing impact', () => {
    expect(resolveImpact([]).mcpConformance).toBe(true);
    expect(resolveImpact(['unknown.config']).mcpConformance).toBe(true);
    expect(formatGithubOutput(undefined)).toContain('mcp_conformance=true');
  });
});
