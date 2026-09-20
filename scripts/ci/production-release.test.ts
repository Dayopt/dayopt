import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RELEASE_PROJECTS,
  buildManifest,
  findDeploymentForSha,
  gitDiffFiles,
  parseRedeployRequest,
  readImpactAffected,
  resolveProjectImpact,
  runProductionRelease,
  smokeDeployment,
  waitForReadyCandidates,
  writeReleaseManifest,
  writeReleaseStatus,
} from './production-release.mjs';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
/** target より新しい（子孫の）commit。supersession の判定に使う。 */
const NEWER_SHA = 'd'.repeat(40);

/**
 * 架空の履歴。OLD_SHA → SHA → NEWER_SHA の直線で、OTHER_SHA は分岐（判定不能）。
 * 実 git は架空 SHA を知らないので、祖先判定は注入する。
 */
const ANCESTRY: Record<string, number> = { [OLD_SHA]: 1, [SHA]: 2, [NEWER_SHA]: 3 };
const isAncestorImpl = (a: string, b: string) => {
  const ra = ANCESTRY[a];
  const rb = ANCESTRY[b];
  if (ra === undefined || rb === undefined) return null; // 分岐 / 未知は判定不能
  return ra < rb;
};
const TOKEN = 'vercel-token-must-not-appear';
const BYPASS = 'bypass-secret-must-not-appear';

/** 実際の smoke marker をすべて含む body。個別テストで上書きする。 */
const SMOKE_BODY =
  '<html lang="en"><a href="https://app.dayopt.app/auth/signup">start</a>{"status":"healthy"}</html>';

/** RELEASE_PROJECTS が期待する x-matched-path を返す smoke response。 */
const MATCHED_PATHS: Record<string, string> = {
  '/': '/en',
  '/ja': '/ja',
  '/api/health': '/api/health',
  '/auth/login': '/[locale]/auth/login',
  '/auth/signup': '/[locale]/auth/signup',
  '/ja/auth/login': '/[locale]/auth/login',
};

function smokeResponse(url: string, body = SMOKE_BODY) {
  const path = new URL(url).pathname;
  return new Response(body, {
    status: 200,
    headers: { 'x-matched-path': MATCHED_PATHS[path] ?? path },
  });
}

function deployment(uid: string, sha: string, readyState = 'READY', created = 2000) {
  return {
    uid,
    url: `${uid}.vercel.app`,
    readyState,
    created,
    target: 'production',
    meta: { githubCommitSha: sha },
  };
}

/** GET /v13/deployments/{id} が返す形。 */
function deploymentRecord(
  id: string,
  sha: string,
  createdAt = 1000,
  extra: { projectId?: string; readyState?: string } = {},
) {
  return {
    id,
    url: `${id}.vercel.app`,
    readyState: 'READY',
    createdAt,
    target: 'production',
    meta: { githubCommitSha: sha },
    ...extra,
  };
}

const DOMAINS: Record<string, string> = { web: 'dayopt.app', product: 'app.dayopt.app' };

/**
 * URL からどちらの project 向けかを判定する。
 * `target=production` の中に 'product' が含まれるので、先に取り除いてから判定する。
 */
function projectFromUrl(url: string): 'web' | 'product' {
  const withoutTarget = url.replaceAll('production', '');
  if (withoutTarget.includes('app.dayopt.app') || withoutTarget.includes('product')) {
    return 'product';
  }
  return 'web';
}

/**
 * `runProductionRelease` の `logger = console` 既定引数により、production-release.mjs
 * 側の型推論（allowJs 由来、checkJs は off）は `logger` を `Console` 型と見なす。
 * 実際に呼ばれるのは `.log()` のみなので、ここでは意図的に最小 stub を用意し、
 * `Console` として扱う（他メソッドを呼ぶコードパスが増えれば実行時に気付ける）。
 */
const noop = { log: () => {} } as unknown as Console;
const noSleep = () => Promise.resolve();

/**
 * live production は alias 起点で解決する。`targets.production` は build 中の
 * deployment も指すため使えない（実測で確認済み）。
 */
function createVercelMock(handlers: Record<string, () => unknown>) {
  // 一部の呼び出し元は PATCH 等を横取りするラッパーから (input, init) の 2 引数で
  // 委譲してくる。init 自体は使わないが、受け取れないと呼び出し側が型エラーになる。
  const fetchImpl = vi.fn(async (input: URL | string, _init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).origin !== 'https://api.vercel.com') return smokeResponse(url);
    const key = Object.keys(handlers).find((pattern) => url.includes(pattern));
    if (!key) throw new Error(`Unhandled request: ${url}`);
    return Response.json(handlers[key]!());
  });
  return { fetchImpl };
}

/** production env 契約を満たす metadata（audit を通過させるため） */
function auditMetadata(project: 'product' | 'web') {
  const sensitive = (key: string) => ({ key, target: ['production'], type: 'sensitive' });
  const plain = (key: string) => ({ key, target: ['production'], type: 'plain' });
  const shared = [
    sensitive('RESEND_API_KEY'),
    plain('RESEND_FROM_EMAIL'),
    sensitive('RESEND_WEBHOOK_SECRET'),
    plain('NEXT_PUBLIC_TURNSTILE_SITE_KEY'),
    plain('UPSTASH_REDIS_REST_URL'),
    sensitive('UPSTASH_REDIS_REST_TOKEN'),
  ];
  const product = [...shared, sensitive('RECOVERY_CODE_PEPPER')];
  return {
    envs: project === 'web' ? [...shared, sensitive('TURNSTILE_SECRET_KEY')] : product,
  };
}

/**
 * 両 project が candidate を持つ既定シナリオ。
 * promote / rollback は同じ endpoint なので、対象 deployment id で区別する。
 */
function createReleaseWorld(
  options: {
    productionSha?: string;
    smokeBody?: string;
    autoAssign?: boolean | null;
    webAlreadyAtTarget?: boolean;
    /** web の alias 読み取り n 回目に返す deployment id。末尾の値が以降も続く。 */
    webAliasSequence?: string[];
  } = {},
) {
  const bothAtTarget = options.productionSha === SHA;
  const live: Record<string, string> = {
    web: bothAtTarget || options.webAlreadyAtTarget ? 'dpl_web_new' : 'dpl_web_old',
    product: bothAtTarget ? 'dpl_product_new' : 'dpl_product_old',
  };
  const store: Record<string, ReturnType<typeof deploymentRecord>> = {
    dpl_web_old: deploymentRecord('dpl_web_old', OLD_SHA, 1000),
    dpl_product_old: deploymentRecord('dpl_product_old', OLD_SHA, 1000),
    dpl_web_new: deploymentRecord('dpl_web_new', SHA, 2000),
    dpl_product_new: deploymentRecord('dpl_product_new', SHA, 2000),
    dpl_web_hotfix: deploymentRecord('dpl_web_hotfix', OLD_SHA, 1500),
    // 判定の基準 SHA でも target でもない第三の commit。
    dpl_web_other: deploymentRecord('dpl_web_other', OTHER_SHA, 1600),
  };
  // promote endpoint は autoAssignCustomDomains を true に戻す（vercel/vercel#15095）。
  const autoAssign: Record<string, boolean | null> = {
    web: options.autoAssign === undefined ? false : options.autoAssign,
    product: options.autoAssign === undefined ? false : options.autoAssign,
  };
  const patches: { project: string; value: unknown }[] = [];
  const candidates = {
    web: deployment('dpl_web_new', SHA),
    product: deployment('dpl_product_new', SHA),
  };
  const pointCalls: { project: string; deploymentId: string }[] = [];
  let webAliasReads = 0;

  const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (new URL(url).origin !== 'https://api.vercel.com') {
      return smokeResponse(url, options.smokeBody);
    }

    const project = projectFromUrl(url);

    if (method === 'PATCH' && url.includes('/v9/projects/')) {
      const value = JSON.parse(String(init?.body ?? '{}')).autoAssignCustomDomains;
      patches.push({ project, value });
      autoAssign[project] = value;
      return new Response(null, { status: 200 });
    }
    if (method === 'POST' && url.includes('/promote/')) {
      const deploymentId = url.split('/promote/')[1]!.split('?')[0]!;
      // promote は project 名ではなく prj_ ID を使い、対象 project と一致すること。
      expect(url).toContain(`/projects/prj_${project}/promote/`);
      pointCalls.push({ project, deploymentId });
      live[project] = deploymentId;
      if (autoAssign[project] !== null) autoAssign[project] = true;
      return new Response(null, { status: 202 });
    }
    if (url.includes('/v7/deployments')) {
      return Response.json({ deployments: [candidates[project as 'web' | 'product']] });
    }
    if (url.includes('/env')) {
      return Response.json(auditMetadata(project));
    }
    if (url.includes('/v4/aliases/')) {
      if (project === 'web' && options.webAliasSequence) {
        const seq = options.webAliasSequence;
        const id = seq[Math.min(webAliasReads, seq.length - 1)]!;
        webAliasReads += 1;
        if (id !== live.web) {
          // 外部の promote が起きたとみなす。promote endpoint の副作用も再現する。
          live.web = id;
          if (autoAssign.web !== null) autoAssign.web = true;
        }
        return Response.json({ deploymentId: id });
      }
      return Response.json({ deploymentId: live[project] });
    }
    if (url.includes('/v13/deployments/')) {
      const id = url.split('/v13/deployments/')[1]!.split('?')[0]!;
      return Response.json(store[id] ?? deploymentRecord(id, OLD_SHA, 1000));
    }
    if (url.includes('/v9/projects/')) {
      // #1817 Phase 4: Production Config Audit がこの同じ endpoint を project 設定監査
      // （rootDirectory / commandForIgnoringBuildStep / enableAffectedProjectsDeployments）
      // にも使う。監査対象外の release テストを壊さないよう、契約に沿う既定値を返す。
      return Response.json({
        id: `prj_${project}`,
        autoAssignCustomDomains: autoAssign[project],
        rootDirectory: `apps/${project}`,
        commandForIgnoringBuildStep: null,
        enableAffectedProjectsDeployments: false,
      });
    }
    throw new Error(`Unhandled request: ${url}`);
  });

  const promoted = () =>
    pointCalls.filter((call) => call.deploymentId.endsWith('_new')).map((call) => call.project);
  const rolledBack = () =>
    pointCalls.filter((call) => call.deploymentId.endsWith('_old')).map((call) => call.project);

  return { fetchImpl, pointCalls, promoted, rolledBack, patches, autoAssign, live, store, DOMAINS };
}

/** 両 app に影響する差分（root 設定）。project 別の影響は各 test で上書きする。 */
const AFFECTS_BOTH = () => ['pnpm-lock.yaml'];

/**
 * production-release.mjs の buildManifest() が実際に返す形（同ファイル参照）。
 * `runProductionRelease` は untyped な .mjs（checkJs off）なので、成功時の
 * resolve 値・失敗時に Object.assign で Error へ付与する値のどちらも
 * allowJs のベストエフォート推論に依存し、精度が粗い。テスト側で読む形を
 * ここに 1 箇所へ集約し、各 test の inline 型のバラつき・欠落を防ぐ。
 */
type ReleaseManifestProject = {
  name: string;
  productionDomain: string;
  affected: boolean | null;
  /** impact job（T0）の verdict。層 3 が走ったか（#2574）。 */
  impactAffected: boolean | null;
  reason: string | null;
  action:
    | 'unassigned'
    | 'promoted'
    | 'rolled-back'
    | 'already-serving'
    | 'uncertified'
    | 'pending'
    | 'skipped'
    | 'moved-externally';
  deploymentId: string | null;
  sourceSha: string | null;
  previousDeploymentId: string | null;
  observedAt: 'this-run' | 'run-start';
};

type ReleaseManifest = {
  sha: string;
  status: string;
  projects: ReleaseManifestProject[];
};

/** release() が reject する時に Object.assign で manifest を付与した Error。 */
type ReleaseError = Error & { manifest?: ReleaseManifest };

function release(overrides: Record<string, unknown> = {}) {
  return runProductionRelease({
    sha: SHA,
    token: TOKEN,
    teamId: 'team',
    sleepImpl: noSleep,
    nowImpl: () => 0,
    logger: noop,
    bypassSecrets: { web: BYPASS, product: BYPASS },
    diffFilesImpl: AFFECTS_BOTH,
    // 既定は「checkout = release 対象」。実 repo の HEAD は SHA と一致しないので、
    // 注入しないと全 test が fail closed 経路（常に両方 affected）に落ちる。
    headShaImpl: () => SHA,
    isAncestorImpl,
    // impact job（T0）の verdict。**本番の既定は空 = 全 project 未検証（fail closed）**
    // なので、個別の意図が無い test はここで「両 project とも層 3 を通った」を宣言する。
    // 値が無い / false の時の挙動は『層 3 coverage の不変条件（#2574）』が明示的に検査する。
    impactAffected: { web: true, product: true },
    ...overrides,
  });
}

describe('findDeploymentForSha', () => {
  it('returns only the production deployment whose commit SHA matches', async () => {
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({
        deployments: [deployment('dpl_other', OLD_SHA), deployment('dpl_match', SHA)],
      }),
    });

    const found = await findDeploymentForSha({
      projectName: 'web',
      sha: SHA,
      token: TOKEN,
      teamId: 'team',
      fetchImpl,
    });

    expect(found?.id).toBe('dpl_match');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`sha=${SHA}`);
  });

  it('ignores deployments created outside the GitHub integration', async () => {
    const cliDeployment = {
      uid: 'dpl_cli',
      url: 'dpl_cli.vercel.app',
      readyState: 'ERROR',
      created: 3000,
      target: 'production',
      meta: { gitCommitSha: SHA },
    };
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [cliDeployment, deployment('dpl_match', SHA)] }),
    });

    const found = await findDeploymentForSha({
      projectName: 'web',
      sha: SHA,
      token: TOKEN,
      teamId: 'team',
      fetchImpl,
    });

    expect(found?.id).toBe('dpl_match');
  });

  it('ignores preview deployments that share the commit SHA', async () => {
    const preview = { ...deployment('dpl_preview', SHA), target: null };
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [preview] }),
    });

    await expect(
      findDeploymentForSha({
        projectName: 'web',
        sha: SHA,
        token: TOKEN,
        teamId: 'team',
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });
});

describe('waitForReadyCandidates', () => {
  const projects = [{ name: 'web' }, { name: 'product' }];

  it('resolves once every project reports READY', async () => {
    let round = 0;
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const project = String(input).includes('web') ? 'web' : 'product';
      round += 1;
      const state = project === 'web' || round > 2 ? 'READY' : 'BUILDING';
      return Response.json({ deployments: [deployment(`dpl_${project}`, SHA, state)] });
    });

    const ready = await waitForReadyCandidates({
      projects,
      sha: SHA,
      token: TOKEN,
      teamId: 'team',
      fetchImpl,
      sleepImpl: noSleep,
      nowImpl: () => 0,
      logger: noop,
    });

    expect(ready.map((entry: { deployment: { id: string } }) => entry.deployment.id)).toEqual([
      'dpl_web',
      'dpl_product',
    ]);
  });

  it('fails fast when a build ends in ERROR', async () => {
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [deployment('dpl_web', SHA, 'ERROR')] }),
    });

    await expect(
      waitForReadyCandidates({
        projects,
        sha: SHA,
        token: TOKEN,
        teamId: 'team',
        fetchImpl,
        sleepImpl: noSleep,
        nowImpl: () => 0,
        logger: noop,
      }),
    ).rejects.toThrow(/ended in ERROR/);
  });

  it('times out when a candidate never becomes READY', async () => {
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [deployment('dpl_web', SHA, 'BUILDING')] }),
    });
    let clock = 0;

    await expect(
      waitForReadyCandidates({
        projects,
        sha: SHA,
        token: TOKEN,
        teamId: 'team',
        fetchImpl,
        sleepImpl: noSleep,
        nowImpl: () => (clock += 60_000),
        logger: noop,
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/Timed out waiting for READY/);
  });
});

describe('smokeDeployment', () => {
  // fetchImpl として vi.fn() に渡すため、実際には (url, init) の 2 引数で呼ばれる。
  // 0 引数のままだと vi.fn() の mock 型が呼び出し引数を [] tuple と推論し、
  // `.mock.calls[n]?.[1]` が「index 1 は存在しない」型エラーになる。
  const okBody = (_url?: string, _init?: { headers?: Record<string, string> }) =>
    smokeResponse('https://dpl.vercel.app/');

  it('sends the bypass header only when a secret is configured', async () => {
    const withSecret = vi.fn(okBody);
    await smokeDeployment({
      projectName: 'web',
      deploymentUrl: 'dpl.vercel.app',
      checks: [{ path: '/' }],
      bypassSecret: BYPASS,
      fetchImpl: withSecret,
      sleepImpl: noSleep,
      logger: noop,
    });
    expect(withSecret.mock.calls[0]?.[1]?.headers).toHaveProperty('x-vercel-protection-bypass');

    const withoutSecret = vi.fn(okBody);
    await smokeDeployment({
      projectName: 'web',
      deploymentUrl: 'dpl.vercel.app',
      checks: [{ path: '/' }],
      bypassSecret: undefined,
      fetchImpl: withoutSecret,
      sleepImpl: noSleep,
      logger: noop,
    });
    expect(withoutSecret.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'x-vercel-protection-bypass',
    );
  });

  it('reports a missing Protection Bypass instead of retrying the SSO redirect', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://vercel.com/sso-api?url=x' },
        }),
    );

    await expect(
      smokeDeployment({
        projectName: 'web',
        deploymentUrl: 'dpl.vercel.app',
        checks: [{ path: '/' }],
        bypassSecret: BYPASS,
        fetchImpl,
        sleepImpl: noSleep,
        logger: noop,
      }),
    ).rejects.toThrow(/Protection Bypass for Automation/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 that was served by a different route', async () => {
    // product は未知 path でも 200 を返すため、status だけでは不足する。
    const fetchImpl = vi.fn(
      async () =>
        new Response('<title>Calendar</title>', {
          status: 200,
          headers: { 'x-matched-path': '/[locale]/[nday]' },
        }),
    );

    await expect(
      smokeDeployment({
        projectName: 'product',
        deploymentUrl: 'dpl.vercel.app',
        checks: [{ path: '/auth/login', matchedPath: '/[locale]/auth/login' }],
        bypassSecret: BYPASS,
        fetchImpl,
        sleepImpl: noSleep,
        logger: noop,
      }),
    ).rejects.toThrow(/was served by \/\[locale\]\/\[nday\]/);
    // route の不一致は retry しても変わらない。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 that streamed a Next.js failure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>NEXT_HTTP_ERROR_FALLBACK;404</html>', {
          status: 200,
          headers: { 'x-matched-path': '/en' },
        }),
    );

    await expect(
      smokeDeployment({
        projectName: 'web',
        deploymentUrl: 'dpl.vercel.app',
        checks: [{ path: '/', matchedPath: '/en' }],
        bypassSecret: BYPASS,
        fetchImpl,
        sleepImpl: noSleep,
        logger: noop,
      }),
    ).rejects.toThrow(/streamed NEXT_HTTP_ERROR_FALLBACK/);
  });

  it('sends an explicit Accept-Language so locale detection cannot redirect', async () => {
    const fetchImpl = vi.fn(okBody);
    await smokeDeployment({
      projectName: 'web',
      deploymentUrl: 'dpl.vercel.app',
      checks: [{ path: '/' }],
      bypassSecret: undefined,
      fetchImpl,
      sleepImpl: noSleep,
      logger: noop,
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'accept-language': 'en' });
  });

  it('retries transient failures and never leaks the bypass secret or response body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('internal detail', { status: 500 }))
      .mockResolvedValueOnce(smokeResponse('https://dpl.vercel.app/'));

    await expect(
      smokeDeployment({
        projectName: 'web',
        deploymentUrl: 'dpl.vercel.app',
        checks: [{ path: '/', matchedPath: '/en' }],
        bypassSecret: BYPASS,
        fetchImpl,
        sleepImpl: noSleep,
        logger: noop,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => new Response('internal detail', { status: 503 }));
    const error = (await smokeDeployment({
      projectName: 'product',
      deploymentUrl: 'dpl.vercel.app',
      checks: [{ path: '/api/health', contains: '"status":"healthy"' }],
      bypassSecret: BYPASS,
      fetchImpl: failing,
      sleepImpl: noSleep,
      logger: noop,
    }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toContain('503');
    expect(error.message).not.toContain(BYPASS);
    expect(error.message).not.toContain('internal detail');
  });
});

describe('runProductionRelease', () => {
  it('rejects a SHA that is not a full commit hash', async () => {
    await expect(release({ sha: 'main' })).rejects.toThrow(/40 character commit SHA/);
  });

  it('is a no-op when both projects already serve the SHA', async () => {
    const world = createReleaseWorld({ productionSha: SHA });

    await expect(release({ fetchImpl: world.fetchImpl })).resolves.toMatchObject({
      status: 'already-released',
    });
    expect(world.pointCalls).toEqual([]);
  });

  it('skips promote when a newer production deployment already exists', async () => {
    const { fetchImpl } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [deployment('dpl_new', SHA, 'READY', 1000)] }),
      '/v4/aliases/': () => ({ deploymentId: 'dpl_newer' }),
      '/v13/deployments/': () => deploymentRecord('dpl_newer', NEWER_SHA, 5000),
      '/v9/projects/': () => ({ id: 'prj_test', autoAssignCustomDomains: false }),
    });

    await expect(release({ fetchImpl })).resolves.toMatchObject({ status: 'superseded' });
  });

  it('promotes web before product after smoke and audit succeed', async () => {
    const world = createReleaseWorld();

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['web', 'product']);
    expect(world.rolledBack()).toEqual([]);
  });

  it('rolls web back to its previous deployment when product fails to promote', async () => {
    const world = createReleaseWorld();

    await expect(
      release({ fetchImpl: world.fetchImpl, simulateFailure: 'promote:product' }),
    ).rejects.toThrow(/Simulated failure at promote:product/);

    expect(world.promoted()).toEqual(['web']);
    expect(world.rolledBack()).toEqual(['web']);
  });

  it('leaves production untouched when smoke fails before any promote', async () => {
    const world = createReleaseWorld();

    await expect(
      release({ fetchImpl: world.fetchImpl, simulateFailure: 'smoke:web' }),
    ).rejects.toThrow(/Simulated failure at smoke:web/);

    expect(world.pointCalls).toEqual([]);
  });

  it('stops before promote when a candidate serves an unhealthy /api/health', async () => {
    const world = createReleaseWorld({ smokeBody: '{"status":"degraded"}' });

    await expect(release({ fetchImpl: world.fetchImpl })).rejects.toThrow(
      /without the expected content/,
    );
    expect(world.pointCalls).toEqual([]);
  });

  it('rolls back a promote whose confirmation never lands', async () => {
    // POST は受理されたが production 割当の反映が確認できない場合。
    // 確認待ちで諦めると web だけ新 SHA という部分公開が残る。
    const world = createReleaseWorld();
    let clock = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/promote/dpl_web_new')) {
        // 受理はするが production 割当は動かさない。
        world.pointCalls.push({ project: 'web', deploymentId: 'dpl_web_new' });
        return new Response(null, { status: 202 });
      }
      return world.fetchImpl(input, init);
    });

    const error = (await release({
      fetchImpl,
      nowImpl: () => (clock += 60_000),
    }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toMatch(/promote did not take effect/);
    expect(world.rolledBack()).toEqual(['web']);
  });

  it('demands a manual rollback when the automatic rollback also fails', async () => {
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/promote/dpl_web_old')) {
        return new Response(null, { status: 500 });
      }
      // 以降は既定の world mock に委ねる。
      return world.fetchImpl(input, init);
    });

    // rollback POST が 5xx = 受理されたか不明なので着地待ちへ入る。窓を進める。
    let clock = 0;
    const error = (await release({
      fetchImpl,
      nowImpl: () => (clock += 60_000),
      simulateFailure: 'promote:product',
    }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    expect(error.message).toContain('dpl_web_old');
    expect(error.message).not.toContain(TOKEN);
  });

  it('restores autoAssignCustomDomains that promote flips back on', async () => {
    // vercel/vercel#15095: promote endpoint が project 設定を書き換える。
    // 放置すると次の main merge が gate を通らず直接公開される。
    const world = createReleaseWorld();

    await expect(release({ fetchImpl: world.fetchImpl })).resolves.toMatchObject({
      status: 'promoted',
    });

    expect(world.patches).toEqual([
      { project: 'web', value: false },
      { project: 'product', value: false },
    ]);
    expect(world.autoAssign).toEqual({ web: false, product: false });
  });

  it('leaves autoAssignCustomDomains alone while it is intentionally enabled', async () => {
    // 段階適用の Phase A では Auto-assign が ON のままでよい。
    // 事前値へ戻すだけなので、勝手に無効化しない。
    const world = createReleaseWorld({ autoAssign: true });

    await release({ fetchImpl: world.fetchImpl });

    expect(world.patches).toEqual([]);
    expect(world.autoAssign).toEqual({ web: true, product: true });
  });

  it('fails the run without rolling back when the setting cannot be restored', async () => {
    // 設定復元の失敗で正常なリリースを巻き戻すと、production が理由なく旧 SHA へ戻る。
    // production はそのままにし、run だけ失敗させて次の merge 前の対処を促す。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        return new Response(null, { status: 500 });
      }
      return world.fetchImpl(input, init);
    });

    const error = (await release({ fetchImpl }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toMatch(/autoAssignCustomDomains could not be restored/);
    expect(world.promoted()).toEqual(['web', 'product']);
    expect(world.rolledBack()).toEqual([]);
  });

  it('names a pre-existing split it cannot roll back', async () => {
    // 前回 run が中断して web だけ公開された状態。web は戻し先を持たないので
    // 自動 rollback の対象にできない。名指しだけはする。
    const world = createReleaseWorld({ webAlreadyAtTarget: true });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(result.preexistingSplit).toEqual(['web']);
    // web は既に対象 SHA を配信しているので promote しない。
    expect(world.promoted()).toEqual(['product']);
  });

  it('refuses to promote over production that moved while waiting', async () => {
    // 待機中にオペレータが Instant Rollback した場合、その判断を上書きしない。
    // 1回目=before snapshot、2回目以降=待機後。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_hotfix'],
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/Production moved while waiting/);
    expect(world.promoted()).toEqual([]);
    // 外部 promote は auto-assign を true へ戻す。ここで掃かずに抜けると次の
    // main merge が gate を通らず直接公開される。
    expect(world.patches).toContainEqual({ project: 'web', value: false });
    expect(world.autoAssign).toEqual({ web: false, product: false });
    // 復旧手順は manifest を一次情報にする。run 開始時点の値では live を取り違える。
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('still checks the setting when both projects already serve the SHA', async () => {
    // 前回 run が復元に失敗して終わった後の再実行。ここで success を返すと
    // auto-assign が true のまま tag gate を通ってしまう。
    const world = createReleaseWorld({ productionSha: SHA, autoAssign: true });
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl, expectedAutoAssign: false })).rejects.toThrow(
      /could not be restored/,
    );
  });

  it('respects a manual promote of the same candidate during the wait', async () => {
    // 待機中に人が同じ candidate を promote した場合は競合ではない。
    // 止めず、かつ二重 promote もしない。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
    });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
  });

  it('refuses to promote when production moves during smoke and audit', async () => {
    // 待機後の再取得と promote の間には smoke と audit があり数分かかる。
    // 1回目=before, 2回目=待機後, 3回目=promote 直前。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_old', 'dpl_web_hotfix'],
    });

    await expect(release({ fetchImpl: world.fetchImpl })).rejects.toThrow(
      /production moved to dpl_web_hotfix/,
    );
    expect(world.promoted()).toEqual([]);
  });

  it('restores the setting for a project it skipped promoting', async () => {
    // 外部が同じ candidate を promote した場合、その promote も auto-assign を
    // true に戻す。promote を飛ばした project も設定は揃えて終える。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
      autoAssign: false,
    });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
    // promote していない web も、最後の掃きで false に戻る。
    expect(world.patches).toContainEqual({ project: 'web', value: false });
  });

  it('smokes candidates that Vercel already auto-assigned', async () => {
    // Auto-assign が有効な段階適用中は candidate が待機中に自動割当され、
    // promote 対象が空になる。それでも smoke は走らせ、毎 merge を
    // smoke と bypass secret の実働テストにする。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
    });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
    // promote しなかった web の candidate にも smoke が飛んでいる。
    const smokeUrls = world.fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('dpl_web_new.vercel.app'));
    expect(smokeUrls.length).toBeGreaterThan(0);
  });

  it('sweeps the setting even when smoke aborts the run', async () => {
    // 待機中に外部が web candidate を promote して auto-assign が true に戻り、
    // その後 product の smoke が失敗した場合。ここで抜けると誰も設定を戻さず、
    // 次の merge が gate を迂回する。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
      smokeBody: '{"status":"degraded"}',
    });

    await expect(release({ fetchImpl: world.fetchImpl })).rejects.toThrow(
      /without the expected content/,
    );
    expect(world.pointCalls).toEqual([]);
    // 失敗経路でも web の設定は false へ戻っている。
    expect(world.patches).toContainEqual({ project: 'web', value: false });
  });

  it('names projects whose setting could not be restored when smoke aborts', async () => {
    // 掃き自体が失敗した場合、run は smoke の失敗だけを報告して終わる。
    // auto-assign が有効なまま残る事実を名指ししないと、次の merge が
    // gate を迂回することにオペレータが気づけない。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
      smokeBody: '{"status":"degraded"}',
    });
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });
    const logs: string[] = [];
    const logger = { log: (message: string) => logs.push(message) };

    await expect(release({ fetchImpl, logger })).rejects.toThrow(/without the expected content/);
    expect(logs.join('\n')).toMatch(/could not be restored for web/);
  });

  it('reports whether the gate checks actually ran', async () => {
    const normal = createReleaseWorld();
    await expect(release({ fetchImpl: normal.fetchImpl })).resolves.toMatchObject({
      gateChecksRan: true,
    });

    const forced = createReleaseWorld();
    await expect(release({ fetchImpl: forced.fetchImpl, force: true })).resolves.toMatchObject({
      gateChecksRan: false,
    });
  });

  it('skips smoke and audit under Force Promote', async () => {
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('/env')) throw new Error('audit must not run under force');
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl, force: true })).resolves.toMatchObject({
      status: 'promoted',
    });
    expect(world.promoted()).toEqual(['web', 'product']);
  });
});

describe('resolveProjectImpact', () => {
  const web = RELEASE_PROJECTS.find((project) => project.name === 'web')!;
  const product = RELEASE_PROJECTS.find((project) => project.name === 'product')!;

  it('treats an unknown production SHA as affected', () => {
    // GitHub 連携以外で作られた deployment には commit SHA が無い。
    // 基準が取れないまま skip すると、変更が production へ出ないまま success になる。
    expect(resolveProjectImpact({ project: product, baseSha: null, targetSha: SHA }).affected).toBe(
      true,
    );
  });

  it('treats an unreadable git history as affected', () => {
    // shallow clone / gc 済みで基準 commit が無い場合。Vercel の判定ではなく
    // Dayopt 側の判定を正とする以上、判定不能は必ず fail closed へ倒す。
    const decision = resolveProjectImpact({
      project: product,
      baseSha: OLD_SHA,
      targetSha: SHA,
      diffFilesImpl: () => {
        throw new Error('bad object');
      },
    });
    expect(decision).toMatchObject({ affected: true });
    expect(decision.reason).toMatch(/fail closed/);
  });

  it('treats an empty diff as unaffected', () => {
    // git が正常終了して 0 件を返したのは「差分なし」の確定的な答えであって、
    // 一覧の取得失敗ではない。
    expect(
      resolveProjectImpact({
        project: web,
        baseSha: OLD_SHA,
        targetSha: SHA,
        diffFilesImpl: () => [],
      }).affected,
    ).toBe(false);
  });

  it('separates product-only changes from web', () => {
    const diffFilesImpl = () => ['apps/product/src/app/page.tsx'];
    expect(
      resolveProjectImpact({ project: product, baseSha: OLD_SHA, targetSha: SHA, diffFilesImpl })
        .affected,
    ).toBe(true);
    expect(
      resolveProjectImpact({ project: web, baseSha: OLD_SHA, targetSha: SHA, diffFilesImpl })
        .affected,
    ).toBe(false);
  });

  it('lists both sides of a rename through the real git', () => {
    // 既定の diff 実装（引数の綴り・-z 分割・--no-renames）を実際の git で確認する。
    // ここが壊れても injection 付きの test は全て通る。
    //
    // 使い捨て repo を作るのは、CI の Unit job が shallow clone（fetch-depth: 1）で
    // 動くため。この repo の HEAD~1 に依存すると CI でだけ落ちる。
    const repo = mkdtempSync(join(tmpdir(), 'release-diff-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    mkdirSync(join(repo, 'apps/product/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/product/src/page.tsx'), 'export const page = 1;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    // app から docs へ動かす。rename 検出が有効だと移動先しか出ず、product の
    // build 入力からファイルが消えた事実を取りこぼす。
    mkdirSync(join(repo, 'docs'), { recursive: true });
    renameSync(join(repo, 'apps/product/src/page.tsx'), join(repo, 'docs/page.tsx'));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'move');
    const target = git('rev-parse', 'HEAD').trim();

    expect(gitDiffFiles(base, target, { cwd: repo }).sort()).toEqual([
      'apps/product/src/page.tsx',
      'docs/page.tsx',
    ]);
  });
});

describe('runProductionRelease (affected-aware)', () => {
  it('promotes only product when web is untouched', async () => {
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
    // web の candidate は待たない。Vercel が deployment を作らないので待てば timeout する。
    const webCandidateLookups = world.fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/v7/deployments') && url.includes('projectId=web'));
    expect(webCandidateLookups).toEqual([]);
  });

  it('promotes only web when product is untouched', async () => {
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/web/src/app/page.tsx'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['web']);
  });

  it('promotes both when a shared package changes', async () => {
    // 実在する共有 package を使う。存在しない package 名だと未知 path の
    // fail closed で両方 affected になり、依存グラフ解決を検証したことにならない。
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['packages/i18n/src/index.ts'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['web', 'product']);
  });

  it('promotes only product when a product-local-only path changes', async () => {
    // packages/domain（product だけが依存する共有 package）は #2168 で
    // apps/product/src/lib/time へ統合済み。この移動後、残る shared package は
    // すべて product + web の 2 consumer を持つため、依存グラフ traversal で
    // 「product だけが影響を受ける」を実証する実在 shared package の代替が無い
    // （product-local path は apps/product/ prefix で product 判定されるため、
    // このケースは依存グラフ解決を経由しない）。グラフ traversal 自体の検証は
    // scripts/__tests__/impact.test.ts の synthetic fixture（product-only
    // workspace package）が引き続き担う。
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/lib/time/index.ts'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
  });

  it('is a no-op success when the merge affects no app', async () => {
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['docs/engineering/infra.md', '.github/workflows/promote.yml'],
    });

    expect(result.status).toBe('unaffected');
    expect(world.pointCalls).toEqual([]);
    // production が動いていない以上、この commit を tag できてよい。
    expect(result.manifest.projects.map((entry: { action: string }) => entry.action)).toEqual([
      'skipped',
      'skipped',
    ]);
  });

  it('is a no-op when one project already serves the SHA and the other is untouched', async () => {
    // 前回 run が web だけ公開して中断した後の再実行。product の影響は product 自身の
    // live SHA から測り直すので、product に影響が無ければこの状態は完結していて
    // 何もしないのが正しい。manifest で両者の live SHA が読めることを担保する。
    const world = createReleaseWorld({ webAlreadyAtTarget: true });

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['docs/engineering/infra.md'],
    });

    expect(result.status).toBe('unaffected');
    expect(result.preexistingSplit).toEqual([]);
    expect(world.pointCalls).toEqual([]);
    expect(result.manifest.projects).toEqual([
      expect.objectContaining({ name: 'web', action: 'already-serving', sourceSha: SHA }),
      expect.objectContaining({ name: 'product', action: 'skipped', sourceSha: OLD_SHA }),
    ]);
  });

  it('marks manifest values this run did not observe itself', async () => {
    // unaffected な project の値は run 開始時点の観測。待機中に人が動かしていれば
    // 実態とズレるため、復旧時に取り違えないよう出所を残す。
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
    });

    expect(result.manifest.projects).toEqual([
      expect.objectContaining({ name: 'web', observedAt: 'run-start' }),
      expect.objectContaining({ name: 'product', observedAt: 'this-run' }),
    ]);
  });

  it('classifies everything as affected when the checkout is not the release target', async () => {
    // workflow_dispatch で古い SHA を再試行した場合。依存グラフは checkout の
    // manifest から解決するため、target 当時と違うグラフで分類しかねない
    // （target の後で依存を外していると「consumer 無し」と誤判定する）。
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      headShaImpl: () => OLD_SHA,
      diffFilesImpl: () => ['docs/engineering/infra.md'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['web', 'product']);
  });

  it('verifies a build that is already live before calling the commit released', async () => {
    // Auto-assign や中断した run が gate を通さずに live にした build を、
    // promote 0 件の success で「live として認証」してしまわないこと。
    const world = createReleaseWorld({ productionSha: SHA, smokeBody: '{"status":"degraded"}' });

    await expect(
      release({ fetchImpl: world.fetchImpl, diffFilesImpl: () => ['docs/x.md'] }),
    ).rejects.toThrow(/without the expected content/);
  });

  it('runs the audit against a build that is already live', async () => {
    const world = createReleaseWorld({ productionSha: SHA });
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('/env')) return Response.json({ envs: [] }); // 契約違反の metadata
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl, diffFilesImpl: () => ['docs/x.md'] })).rejects.toThrow(
      /Production Config Audit failed/,
    );
  });

  it('records a candidate that goes live during the wait as live, not pending', async () => {
    // 待機中に Auto-assign が candidate を live にすると pending filter で除外され、
    // promote loop に届かない。manifest 上「未着手」に見せない。
    const world = createReleaseWorld({ webAliasSequence: ['dpl_web_old', 'dpl_web_new'] });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(world.promoted()).toEqual(['product']);
    expect(result.manifest.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'already-serving',
        deploymentId: 'dpl_web_new',
        observedAt: 'this-run',
      }),
    );
  });

  it('smokes both production domains after a one-sided promote', async () => {
    // 片側だけ進んだ production は、その組み合わせが初めて世に出る状態になる。
    const world = createReleaseWorld();

    await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
    });

    const smoked = world.fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter(
        (url) => url.startsWith('https://dayopt.app') || url.startsWith('https://app.dayopt.app'),
      );
    expect(smoked).toContain('https://dayopt.app/');
    expect(smoked).toContain('https://app.dayopt.app/api/health');
  });

  it('smokes the production domains even when Vercel auto-assigned the candidate', async () => {
    // Auto-assign が有効な段階適用中は promote 件数が 0 になる。promote 件数で
    // 分岐すると cutover までこの smoke が一度も走らない。
    const world = createReleaseWorld({ webAliasSequence: ['dpl_web_old', 'dpl_web_new'] });

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/web/src/app/page.tsx'],
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual([]);
    const smoked = world.fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(smoked).toContain('https://dayopt.app/');
    expect(smoked).toContain('https://app.dayopt.app/api/health');
  });

  it('refuses to report a SHA as live when the domain moved off the candidate', async () => {
    // 待機中に auto-assign された candidate は promote loop を通らないため、その後
    // 誰かが rollback しても ID を確認する経路が無かった。smoke は health しか見ないので
    // 健全な別 deployment が応答すれば通り、live でない SHA に success が付く。
    // 1回目=before, 2回目=待機後（自動割当）, 3回目=最終確認（別 deployment へ移動）。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new', 'dpl_web_hotfix'],
    });

    await expect(release({ fetchImpl: world.fetchImpl })).rejects.toThrow(
      /web: production serves dpl_web_hotfix, not the released dpl_web_new/,
    );

    // この run が promote したのは product だけ。戻すのもそれだけ。
    expect(world.promoted()).toEqual(['product']);
    expect(world.rolledBack()).toEqual(['product']);
  });

  it('refuses to report an already-live SHA when the domain moves during the gate', async () => {
    // promote 0 件の経路は candidate の ID 突き合わせを通らない。smoke と audit の
    // 数分の間に人が Instant Rollback すると、live でない commit に success が付く。
    // 1回目=run 開始時（target を配信中）、2回目=検証時（別 SHA へ移動）。
    const world = createReleaseWorld({
      productionSha: SHA,
      webAliasSequence: ['dpl_web_new', 'dpl_web_hotfix'],
    });

    await expect(
      release({ fetchImpl: world.fetchImpl, diffFilesImpl: () => ['docs/x.md'] }),
    ).rejects.toThrow(/web: production moved to dpl_web_hotfix after the gates ran/);
    expect(world.pointCalls).toEqual([]);
  });

  it('leaves a project alone when another actor moved production before the rollback', async () => {
    // 我々の promote 後に人が hotfix を promote した場合。ここで entry.previous を
    // promote すると、その hotfix を古い deployment で上書きしてしまう。
    // 1-3回目=promote まで, 4回目=promote 反映確認, 5回目以降=外部が hotfix へ移動。
    const world = createReleaseWorld({
      webAliasSequence: [
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_new',
        'dpl_web_hotfix',
      ],
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toMatch(/Left alone because another actor moved production first: web/);
    // web は外部の hotfix が乗っているので触らない。product だけ戻す。
    expect(world.rolledBack()).toEqual(['product']);
  });

  it('records an externally moved deployment as such, not as promoted', async () => {
    // runbook は manifest の `action: promoted` を「戻す対象」として案内する。
    // 他者の hotfix が live の側をそう記録すると、その hotfix を戻させてしまう。
    const world = createReleaseWorld({
      webAliasSequence: [
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_new',
        'dpl_web_hotfix',
      ],
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('refuses to roll back when the live deployment cannot be read', async () => {
    // 読めない状態を「競合なし」と扱うと、守ろうとしている hotfix を上書きしうる。
    // production を変更するより人の確認へ回す。
    const world = createReleaseWorld();
    let aliasReads = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // rollback 直前の live 読み取り（web の alias）だけを落とす。
      if (url.includes('/v4/aliases/dayopt.app')) {
        aliasReads += 1;
        if (aliasReads >= 5) return new Response(null, { status: 500 });
      }
      return world.fetchImpl(input, init);
    });

    const error = (await release({ fetchImpl, simulateFailure: 'promote:product' }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    expect(error.message).toMatch(/live deployment unreadable/);
    // 読めない状態で production を触っていない。
    expect(world.rolledBack()).toEqual([]);
  });

  it('rechecks a preexisting target deployment in a mixed release', async () => {
    // web は run 開始時点で既に target を配信（candidates に入らない）、product は
    // affected。gate 実行中に web が動かされると「全 affected が target を配信」が嘘になる。
    // web は targets に入らないため alias を読むのは 2 回だけ（run 開始時と最終確認）。
    const world = createReleaseWorld({
      webAlreadyAtTarget: true,
      webAliasSequence: ['dpl_web_new', 'dpl_web_hotfix'],
    });

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
      }),
    ).rejects.toThrow(/web: production moved to dpl_web_hotfix after the gates ran/);
  });

  it('checks deployment identity even under Force Promote', async () => {
    // Force Promote が免除するのは health / config の gate であって、
    // 「promote した SHA が今も live」という主張そのものではない。
    const world = createReleaseWorld({
      webAliasSequence: [
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_new',
        'dpl_web_hotfix',
      ],
    });

    await expect(release({ fetchImpl: world.fetchImpl, force: true })).rejects.toThrow(
      /web: production serves dpl_web_hotfix, not the released dpl_web_new/,
    );
  });

  it('rechecks a skipped project before publishing success', async () => {
    // unaffected と判定した project が run 中に別 commit へ動くと、その判定は
    // 別の基準で下されたことになり陳腐化する。candidates にも alreadyServing にも
    // 入らないため、以前はどの確認も通らなかった。
    const world = createReleaseWorld({ webAliasSequence: ['dpl_web_old', 'dpl_web_other'] });

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
      }),
    ).rejects.toThrow(/web: production moved to dpl_web_other after the gates ran/);
  });

  it('forgets a move that returns to baseline before the manifest is built', async () => {
    // 待機中に candidate が別 deployment（dpl_web_other）へ動くと movedElsewhere が
    // 検出し、その project の live を manifest 用に observedLive へ記録する
    // （読み: #1=初期取得=baseline、#2=待機後の再取得=dpl_web_other）。この run は
    // movedElsewhere を検出した直後に `refreshObservedLive()` で全 project を
    // 読み直すが（読み: #3）、その時点で既に baseline（dpl_web_old）へ戻っていた
    // 場合、`expected` が古い観測（dpl_web_other）のままだと「まだ動いている」と
    // 誤認する。動きは無かったことにする（§refreshObservedLive）。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_other', 'dpl_web_old'],
    });

    const error = (await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/web/src/app/page.tsx'],
    }).catch(
      (
        thrown: Error & {
          manifest?: { projects: { name: string; action: string; observedAt: string }[] };
        },
      ) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/Production moved while waiting for candidates/);
    const web = error.manifest?.projects.find((entry) => entry.name === 'web');
    // moved-externally ではなく run 開始時点の deployment（pending）のまま。
    expect(web?.action).not.toBe('moved-externally');
    expect(web?.action).toBe('pending');
    // 観測を「無かったことにした」証拠: 記録が消え、run 開始時点の値扱いに戻る。
    // 記録が残っていれば（=動きを引きずっていれば）'this-run' のままになる。
    expect(web?.observedAt).toBe('run-start');
  });

  it('sweeps auto-assign again after the already-live gates', async () => {
    // gate の実行中に外部 promote が設定を飛ばすと、gate 前の復元は無効になる。
    // 掃き直さないと次の main merge が gate を迂回して直接公開される。
    const world = createReleaseWorld({ productionSha: SHA, autoAssign: false });
    let flipped = false;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // 最初の smoke（= gate 実行中）で外部 promote が起きたことにする。
      if (!url.startsWith('https://api.vercel.com') && !flipped) {
        flipped = true;
        world.autoAssign.web = true;
      }
      return world.fetchImpl(input, init);
    });

    const result = await release({ fetchImpl, diffFilesImpl: () => ['docs/x.md'] });

    expect(result.status).toBe('already-released');
    expect(world.patches).toContainEqual({ project: 'web', value: false });
    expect(world.autoAssign).toEqual({ web: false, product: false });
  });

  it('sweeps auto-assign when the candidate wait fails', async () => {
    // 25 分の待機中に人が promote すると auto-assign が true へ戻る。その後に
    // 別 candidate が ERROR になっても掃かずに抜けると、次の main merge が
    // gate を通らず直接公開される。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v7/deployments') && url.includes('projectId=product')) {
        // 待機中に外部 promote があったことにしてから、build を失敗させる。
        world.autoAssign.web = true;
        return Response.json({
          deployments: [
            {
              uid: 'dpl_product_new',
              url: 'x',
              readyState: 'ERROR',
              target: 'production',
              created: 2000,
              meta: { githubCommitSha: SHA },
            },
          ],
        });
      }
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl })).rejects.toThrow(/ended in ERROR/);
    expect(world.patches).toContainEqual({ project: 'web', value: false });
    expect(world.autoAssign).toEqual({ web: false, product: false });
  });

  it('sweeps auto-assign before returning superseded', async () => {
    // 古い SHA の再試行で、より新しい deployment が既に live のケース。その手動
    // promote が auto-assign を戻していると、release は正しく失敗するのに
    // 次の main deployment が自動で live になる。
    const { fetchImpl: base } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [deployment('dpl_new', SHA, 'READY', 1000)] }),
      '/v4/aliases/': () => ({ deploymentId: 'dpl_newer' }),
      '/v13/deployments/': () => deploymentRecord('dpl_newer', NEWER_SHA, 5000),
      '/v9/projects/': () => ({ id: 'prj_test', autoAssignCustomDomains: true }),
    });
    const patches: unknown[] = [];
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patches.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(null, { status: 200 });
      }
      return base(input, init);
    });

    const result = await release({ fetchImpl, expectedAutoAssign: false });

    expect(result.status).toBe('superseded');
    expect(patches).toContainEqual({ autoAssignCustomDomains: false });
  });

  it('keeps a promote whose request outcome is unknown in the rollback scope', async () => {
    // POST の response を失っただけで Vercel が受理していることがある。
    // rollback 対象から外すと、run 終了後に target が live になり、戻す先を
    // 誰も知らないまま片側公開が残る。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        // 受理されたが response を失ったケース（production は動かないまま観測される）。
        return new Response(null, { status: 502 });
      }
      return world.fetchImpl(input, init);
    });

    // 着地待ちの窓（ASSIGN_TIMEOUT_MS）を進めるため clock を動かす。
    let clock = 0;
    await expect(release({ fetchImpl, nowImpl: () => (clock += 60_000) })).rejects.toThrow(
      /promote\(web\) failed with status 502/,
    );
    // 空振りでも previous へ戻しに行く（何も起きていなければ実質 no-op）。
    expect(world.rolledBack()).toEqual(['web']);
  });

  it('records a move detected just before promoting', async () => {
    // 待機後 snapshot と promote の間（smoke と audit の数分）に動かされた場合。
    // 1回目=before, 2回目=待機後, 3回目=promote 直前。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_old', 'dpl_web_hotfix'],
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/production moved to dpl_web_hotfix/);
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
        observedAt: 'this-run',
      }),
    );
  });

  it('does not roll back a promote that Vercel explicitly rejected', async () => {
    // 4xx は「受理されなかった」が確定する。ここで戻しに行くと、何も起きていない
    // production へ 2 度目の mutation を撃ち、同じ理由で失敗して誤報になる。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 403 });
      }
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl })).rejects.toThrow(/promote\(web\) failed with status 403/);
    expect(world.pointCalls).toEqual([]);
  });

  it('separates a settings-only failure from a failed promotion', async () => {
    // production は正しい SHA を配信している。manifest の status が failed のままだと
    // runbook の「失敗した run の promoted は戻す」で健全な deployment が巻き戻される。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });

    const error = (await release({ fetchImpl }).catch(
      (thrown: Error & { manifest?: { status: string } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/autoAssignCustomDomains could not be restored/);
    expect(error.manifest?.status).toBe('settings-drift');
    expect(world.rolledBack()).toEqual([]);
  });

  it('withdraws a settings-only failure once the wrapper cleanup sweep succeeds', async () => {
    // production は正しい SHA を配信しており、autoAssignCustomDomains の復元だけが
    // 一時的に失敗した。stabilize() 自身の再試行（PATCH #1-6: promote ループの復元
    // 2 件 + stabilize 内の掃き 2 周分）は失敗させ続けて settings-drift を throw させ、
    // wrapper の catch がもう一度 stabilize を回した時点（PATCH #7 以降）で PATCH を
    // 成功させる。回数は実測値（本 PR の調査で確認済み）。
    const world = createReleaseWorld();
    let patchCount = 0;
    const FAIL_UNTIL = 6;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patchCount += 1;
        if (patchCount <= FAIL_UNTIL) return new Response(null, { status: 500 });
      }
      return world.fetchImpl(input, init);
    });

    const result = await release({ fetchImpl });

    // settings-drift の失敗は取り下げられ、通常の promoted 成功として終わる。
    expect(result.status).toBe('promoted');
    expect(result.manifest?.status).toBe('promoted');
    // 取り下げの条件どおり、alias の再検証（stabilize）を経て設定も実際に復元されている。
    expect(world.autoAssign).toEqual({ web: false, product: false });
  });

  it('rebuilds the failure manifest when an alias moves during the final cleanup', async () => {
    // 失敗経路の最後に走る掃きの間にも alias は動きうる。manifest は内側で既に
    // 作られているため、ここで読み直さないと「掃き中に promote された hotfix」を
    // この run の candidate として案内し、復旧手順が hotfix を巻き戻してしまう。
    //
    // web の alias 読み取り: 1-3 回目=promote 前、4 回目=promote の反映待ち、
    // 5 回目=stabilize の検証、6 回目=cleanup 後の読み直し。
    const world = createReleaseWorld({
      webAliasSequence: [
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_old',
        'dpl_web_new',
        'dpl_web_new',
        'dpl_web_hotfix',
      ],
    });
    // 設定復元だけを失敗させ、内側に settings-drift の manifest を作らせる。
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });

    const error = (await release({ fetchImpl }).catch(
      (
        thrown: Error & {
          manifest?: { status: string; projects: { name: string; action: string }[] };
        },
      ) => thrown,
    )) as ReleaseError;

    // production が動いた以上「設定だけの失敗」ではない。
    expect(error.manifest?.status).toBe('failed');
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
    // product は掃きの間も動いていないので、この run の promote として残る。
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({ name: 'product', action: 'promoted' }),
    );
  });

  it('records a move that only the final check observes', async () => {
    // 最終確認で検出した移動も manifest へ載せる。載せないと復旧手順が
    // run 開始時点の deployment を live と誤認する。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new', 'dpl_web_hotfix'],
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('treats a rate-limited promote as a rejection, not an ambiguous one', async () => {
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 429 });
      }
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl })).rejects.toThrow(/failed with status 429/);
    // 拒否が確定しているので production は触らない。
    expect(world.pointCalls).toEqual([]);
  });

  it('does not call an ambiguous promote rolled back when it lands late', async () => {
    // POST は 5xx を返したが Vercel は受理していた場合。previous は一度も live を
    // 外れないので assignment の確認は即座に通る。猶予後に target が現れたら、
    // run 終了後に着地するのと同じ状態なので手動確認へ回す。
    const world = createReleaseWorld();
    let readsAfterRollback = -1;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 503 }); // 受理されたが response を失った
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        readsAfterRollback = 0;
        return new Response(null, { status: 202 });
      }
      if (readsAfterRollback >= 0 && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        // 1 回目 = rollback の反映確認（previous は一度も外れていないので即通る）。
        // 2 回目 = 猶予後の再確認。ここで遅れて着地した元の promote が見える。
        return Response.json({
          deploymentId: readsAfterRollback === 1 ? 'dpl_web_old' : 'dpl_web_new',
        });
      }
      return world.fetchImpl(input, init);
    });

    // 着地待ちは窓の最後まで見るので clock を進める。
    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    expect(error.message).toMatch(/a delayed promote landed on dpl_web_new/);
  });

  it('fails when the production domain has no deployment at the final check', async () => {
    // alias が外れた場合も観測結果。live が null だからと素通りさせない。
    const world = createReleaseWorld();
    let readsAfterPromote = -1;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_product_new')) {
        readsAfterPromote = 0;
        return world.fetchImpl(input, init);
      }
      // 2 回目（= 最終確認）だけ alias 未割当を返す。以降は通常どおり応答させないと
      // rollback の反映確認が永久に満たされない。
      if (readsAfterPromote >= 0 && url.includes('/v4/aliases/app.dayopt.app')) {
        readsAfterPromote += 1;
        if (readsAfterPromote === 2) return Response.json({});
      }
      return world.fetchImpl(input, init);
    });

    await expect(release({ fetchImpl })).rejects.toThrow(
      /product: production serves none, not the released dpl_product_new/,
    );
  });

  it('does not claim rollback when the settle window is unreadable throughout', async () => {
    // 読めない間に遅れた promote が着地していても分からない。「previous のままだった」
    // は観測に基づかないので、戻ったと宣言しない。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    let readsAfterRollback = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 503 });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return new Response(null, { status: 202 });
      }
      // rollback の反映確認は通し、その後の着地待ちの読み取りだけ落とす。
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        if (readsAfterRollback === 1) return Response.json({ deploymentId: 'dpl_web_old' });
        return new Response(null, { status: 500 });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    expect(error.message).toMatch(/unreadable throughout the settle window/);
  });

  it('leaves a hotfix that appears during the settle window alone', async () => {
    // 着地待ちの間に現れたのが我々の candidate でないなら他者の選択。戻すと上書き。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    let readsAfterRollback = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 503 });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return new Response(null, { status: 202 });
      }
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        if (readsAfterRollback === 1) return Response.json({ deploymentId: 'dpl_web_old' });
        return Response.json({ deploymentId: 'dpl_web_hotfix' });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/Left alone because another actor moved production first: web/);
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('smokes every domain when certifying an already-live target', async () => {
    // 片側だけ見て success を出すと、健全でない skip 側の domain を認証したまま
    // tag を打てる。web は既に target を配信、product は影響なしの混在ケース。
    const world = createReleaseWorld({ webAlreadyAtTarget: true });
    const smoked: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://dayopt.app') || url.startsWith('https://app.dayopt.app')) {
        smoked.push(new URL(url).origin);
      }
      return world.fetchImpl(input, init);
    });

    const result = await release({ fetchImpl, diffFilesImpl: () => ['docs/x.md'] });

    expect(result.status).toBe('unaffected');
    expect(new Set(smoked)).toEqual(new Set(['https://dayopt.app', 'https://app.dayopt.app']));
  });

  it('clears a transient restore failure that a later sweep recovers', async () => {
    // ループ内の復元が一度失敗しても、最後の掃きで直っていれば設定は正しい。
    // 過去の失敗を積み上げて release を止めると、tag を打てなくなる。
    const world = createReleaseWorld();
    let patchAttempts = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patchAttempts += 1;
        if (patchAttempts === 1) return new Response(null, { status: 500 });
      }
      return world.fetchImpl(input, init);
    });

    const result = await release({ fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.autoAssign).toEqual({ web: false, product: false });
  });

  it('keeps its own delayed promote out of moved-externally', async () => {
    // 遅れて着地したのが自分の candidate なら、manifest を moved-externally に
    // しない。runbook が「戻さない」と案内するのに、エラーは MANUAL ROLLBACK
    // REQUIRED を出す矛盾になる。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    let readsAfterRollback = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 503 });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return new Response(null, { status: 202 });
      }
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        if (readsAfterRollback === 1) return Response.json({ deploymentId: 'dpl_web_old' });
        return Response.json({ deploymentId: 'dpl_web_new' }); // 自分の promote が着地
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    const web = error.manifest?.projects.find((p) => p.name === 'web');
    expect(web?.action).not.toBe('moved-externally');
    expect(web).toMatchObject({ action: 'promoted', previousDeploymentId: 'dpl_web_old' });
  });

  it('fails when the web page drops its signup CTA', async () => {
    // product 側の /auth/signup が生きていても、web からの導線が消えれば入口は失われる。
    const world = createReleaseWorld({
      smokeBody: '<html lang="en">{"status":"healthy"}</html>', // CTA なし
    });

    await expect(release({ fetchImpl: world.fetchImpl })).rejects.toThrow(
      /web: smoke \/ returned 200 without the expected content/,
    );
  });

  it('keeps the superseded diagnosis even when the setting cannot be restored', async () => {
    // superseded は「より新しい deployment が live」と証明した経路。settings-drift
    // （= 正しい SHA が live）へ塗り替えると復旧手順が矛盾する。
    const { fetchImpl: base } = createVercelMock({
      '/v7/deployments': () => ({ deployments: [deployment('dpl_new', SHA, 'READY', 1000)] }),
      '/v4/aliases/': () => ({ deploymentId: 'dpl_newer' }),
      '/v13/deployments/': () => deploymentRecord('dpl_newer', NEWER_SHA, 5000),
      '/v9/projects/': () => ({ id: 'prj_test', autoAssignCustomDomains: true }),
    });
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Response(null, { status: 500 });
      return base(input, init);
    });

    const result = await release({ fetchImpl, expectedAutoAssign: false });

    expect(result.status).toBe('superseded');
  });

  it('refuses to certify a replacement deployment that the gates never tested', async () => {
    // 同じ commit の別 deployment でも build 時の設定は違いうるし、smoke も audit も
    // 通っていない。`READY` と source SHA は gate が証明している内容ではない。
    const world = createReleaseWorld({ webAliasSequence: ['dpl_web_old', 'dpl_web_hotfix'] });

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
      }),
    ).rejects.toThrow(/never smoked or audited/);
  });

  it('keeps watching after a hotfix appears during the settle window', async () => {
    // hotfix を見た時点で打ち切ると、その後に自分の promote が着地して hotfix を
    // 上書きしても「他者が動かしたので触らない」と記録したまま run が終わる。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    let readsAfterRollback = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        return new Response(null, { status: 503 }); // 受理されたが response を失った
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return new Response(null, { status: 202 });
      }
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        // 1=rollback の反映確認 → 2=他者の hotfix → 3=自分の promote が遅れて着地
        if (readsAfterRollback === 1) return Response.json({ deploymentId: 'dpl_web_old' });
        if (readsAfterRollback === 2) return Response.json({ deploymentId: 'dpl_web_hotfix' });
        return Response.json({ deploymentId: 'dpl_web_new' });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    // hotfix で打ち切らず、最後に着地した自分の candidate を手動確認へ回す。
    expect(error.message).toMatch(/a delayed promote landed on dpl_web_new/);
    expect(error.message).not.toMatch(/Left alone because another actor/);
  });

  it('marks a mid-wait assignment that failed the gates as uncertified', async () => {
    // 待機中に Auto-assign で live になった candidate は promote していないので自動
    // rollback の対象外。gate が落ちた場合「already-serving（= 触るな）」と書くと、
    // 認証を通っていない build が live のまま放置される。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
      smokeBody: '{"status":"degraded"}', // product の smoke を落とす
    });

    const error = (await release({ fetchImpl: world.fetchImpl }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/without the expected content/);
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'uncertified',
        deploymentId: 'dpl_web_new',
        previousDeploymentId: 'dpl_web_old',
      }),
    );
  });

  it('does not restore an alias an operator removed before the rollback', async () => {
    // 人が意図して外した domain に traffic を戻す判断は release run の権限ではない。
    const world = createReleaseWorld();
    let promotedWeb = false;
    let readsAfterPromote = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        promotedWeb = true;
        return world.fetchImpl(input, init);
      }
      // promote の反映確認は通し、その後（rollback 直前の読み取り）で外れている。
      if (promotedWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterPromote += 1;
        if (readsAfterPromote > 1) return Response.json({});
      }
      return world.fetchImpl(input, init);
    });

    const error = (await release({ fetchImpl, simulateFailure: 'promote:product' }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toMatch(/Left alone because another actor moved production first: web/);
    // 未割当の domain へ promote を撃っていない。
    expect(world.rolledBack()).toEqual([]);
  });

  it('records a skipped project that moved before its production smoke failed', async () => {
    // gate が落ちた時点で、その project の live が run 開始時点から動いていても
    // 誰も記録していなかった。manifest が run 開始時点の deployment を skipped として
    // 載せると、runbook が「触るな」と案内して unhealthy な domain を放置させる。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_hotfix'],
      smokeBody: '{"status":"degraded"}', // product の smoke を落とす
    });

    const error = (await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
    }).catch(
      (thrown: Error & { manifest?: { projects: { name: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toMatch(/without the expected content/);
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('promotes into a domain that was unassigned from the start', async () => {
    // 未割当を「外部が動かした」と誤判定すると、READY な candidate を promote せずに
    // 抜けてしまい、domain は無配信のまま残る。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // web の alias は最初から未割当。promote 後は通常どおり応答させる。
      if (url.includes('/v4/aliases/dayopt.app') && !world.live.webPromoted) {
        return Response.json({});
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        world.live.webPromoted = 'yes';
      }
      return world.fetchImpl(input, init);
    });

    const result = await release({ fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toContain('web');
  });

  it('fails when production keeps changing through every stabilization attempt', async () => {
    // 検証の後に必ず promote が起きる状態。最後の掃きの後を検証できていないので
    // success の根拠が無い。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // 設定を読むたびに「有効化されている」ことにする（外部 promote の連続）。
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/v9/projects/')) {
        const project = url.includes('web') ? 'web' : 'product';
        world.autoAssign[project] = true;
      }
      return world.fetchImpl(input, init);
    });

    // gate 運用の宣言値（false）を明示する。省略すると run 開始時点の観測（この mock
    // では true）が期待値になり、掃きが何もしない。
    await expect(release({ fetchImpl, expectedAutoAssign: false })).rejects.toThrow(
      /kept changing while verifying/,
    );
  });

  it('leaves a hotfix alone when the rollback confirmation fails', async () => {
    // rollback の POST は受理されたが反映確認の間に他者が hotfix を promote した場合。
    // 「previous へ戻せ」と指示すると、その hotfix を上書きさせることになる。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return new Response(null, { status: 202 });
      }
      // 反映確認は他者の hotfix を返し続けるので timeout する。
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        return Response.json({ deploymentId: 'dpl_web_hotfix' });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({
      fetchImpl,
      nowImpl: () => (clock += 60_000),
      simulateFailure: 'promote:product',
    }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toMatch(/Left alone because another actor moved production first: web/);
    expect(error.message).not.toMatch(/MANUAL ROLLBACK REQUIRED/);
  });

  it('invalidates a rollback record when the domain moves afterwards', async () => {
    // rollback を確認した後、次の project を処理している間に他者が動かした場合。
    // `rolled-back`（= previous を配信中）のままだと、復旧手順が実態を取り違える。
    const world = createReleaseWorld();
    let rolledBackWeb = false;
    let readsAfterRollback = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_old')) {
        rolledBackWeb = true;
        return world.fetchImpl(input, init);
      }
      // 1 回目 = rollback の反映確認、2 回目以降（最終 refresh）= 他者が動かした後。
      if (rolledBackWeb && url.includes('/v4/aliases/dayopt.app')) {
        readsAfterRollback += 1;
        if (readsAfterRollback > 1) return Response.json({ deploymentId: 'dpl_web_hotfix' });
      }
      return world.fetchImpl(input, init);
    });

    const error = (await release({
      fetchImpl,
      simulateFailure: 'promote:product',
    }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'moved-externally',
        deploymentId: 'dpl_web_hotfix',
      }),
    );
  });

  it('watches an ambiguous promote even when a hotfix is already visible', async () => {
    // 受理が不確かな promote は、他者の deployment が見えていても窓を見る。
    // ここで抜けると「hotfix は触らない」と記録した後に promote が着地し、
    // その hotfix を ungated な candidate で置き換える。
    const world = createReleaseWorld();
    let webPromoteFailed = false;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        webPromoteFailed = true;
        return new Response(null, { status: 503 }); // 受理されたが response を失った
      }
      // rollback 直前は他者の hotfix、窓の中で自分の promote が着地する。
      if (webPromoteFailed && url.includes('/v4/aliases/dayopt.app')) {
        return Response.json({
          deploymentId: world.live.settled ? 'dpl_web_new' : 'dpl_web_hotfix',
        });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({
      fetchImpl,
      nowImpl: () => {
        clock += 60_000;
        if (clock > 120_000) world.live.settled = 'yes'; // 窓の途中で着地
        return clock;
      },
    }).catch((thrown: Error) => thrown)) as Error;

    // hotfix を「触らない」で終わらせず、着地した candidate を手動確認へ回す。
    expect(error.message).toMatch(/a delayed promote landed on dpl_web_new/);
  });

  it('watches an ambiguous promote even when there is nothing to roll back to', async () => {
    // run 開始時点で未割当だと戻し先が無く、rollback loop は即 stranded にしていた。
    // 受理が不確かな promote は後から着地しうるので、窓は見届ける。
    const world = createReleaseWorld();
    let webPromoteFailed = false;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      // web は最初から未割当。
      if (url.includes('/v4/aliases/dayopt.app') && !webPromoteFailed) {
        return Response.json({});
      }
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/promote/dpl_web_new')) {
        webPromoteFailed = true;
        return new Response(null, { status: 503 }); // 受理されたが response を失った
      }
      // 窓の中で着地する。
      if (webPromoteFailed && url.includes('/v4/aliases/dayopt.app')) {
        return Response.json({ deploymentId: 'dpl_web_new' });
      }
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({ fetchImpl, nowImpl: () => (clock += 60_000) }).catch(
      (thrown: Error) => thrown,
    )) as Error;

    expect(error.message).toMatch(/dpl_web_new is live and ungated/);
  });

  it('sends no bypass secret to the production domains', async () => {
    // production domain に Deployment Protection が付く設定事故を捕まえるための
    // smoke なので、bypass header で迂回してはいけない。
    const world = createReleaseWorld();
    const headers: (HeadersInit | undefined)[] = [];
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (String(input).startsWith('https://dayopt.app')) headers.push(init?.headers);
      return world.fetchImpl(input, init);
    });

    await release({ fetchImpl });

    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(JSON.stringify(header)).not.toContain(BYPASS);
      expect(header).not.toHaveProperty('x-vercel-protection-bypass');
    }
  });

  it('rolls back this run own promote when the production smoke fails', async () => {
    const world = createReleaseWorld();

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
        simulateFailure: 'production-smoke:web',
      }),
    ).rejects.toThrow(/Simulated failure at production-smoke:web/);

    // web は promote していないので rollback 対象外。product だけ戻す。
    expect(world.promoted()).toEqual(['product']);
    expect(world.rolledBack()).toEqual(['product']);
  });

  it('keeps a project it did not promote out of the rollback scope', async () => {
    // web は前の run から対象 SHA を配信している。戻し先が無いので rollback せず、
    // 名指しだけして人の判断に委ねる。
    const world = createReleaseWorld({ webAlreadyAtTarget: true });

    const error = (await release({
      fetchImpl: world.fetchImpl,
      simulateFailure: 'promote:product',
    }).catch((thrown: Error) => thrown)) as Error;

    expect(error.message).toMatch(/Simulated failure at promote:product/);
    expect(world.rolledBack()).toEqual([]);
    expect(error.message).toMatch(/Outside this run's rollback scope: web/);
  });

  it('records each project deployment id and source SHA in the manifest', async () => {
    const world = createReleaseWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/product/src/app/page.tsx'],
    });

    expect(result.manifest).toMatchObject({ sha: SHA, status: 'promoted' });
    expect(result.manifest.projects).toEqual([
      expect.objectContaining({
        name: 'web',
        affected: false,
        action: 'skipped',
        deploymentId: 'dpl_web_old',
        sourceSha: OLD_SHA,
      }),
      expect.objectContaining({
        name: 'product',
        affected: true,
        action: 'promoted',
        deploymentId: 'dpl_product_new',
        sourceSha: SHA,
        previousDeploymentId: 'dpl_product_old',
      }),
    ]);
  });

  it('keeps rolled-back projects out of the surviving list when a rollback strands one', async () => {
    // 両方 promote 後に失敗し、web の rollback だけが失敗する。戻せた product を
    // 「新 SHA 配信中」と記録すると、復旧の担当者が触る必要のない側を触る。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('/promote/dpl_web_old'))
        return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({
      fetchImpl,
      nowImpl: () => (clock += 60_000),
      simulateFailure: 'production-smoke:web',
    }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.message).toContain('MANUAL ROLLBACK REQUIRED');
    expect(world.rolledBack()).toEqual(['product']);
    expect(error.manifest?.projects).toEqual([
      // 戻せなかった側だけが新 SHA を配信している。
      expect.objectContaining({ name: 'web', action: 'promoted', deploymentId: 'dpl_web_new' }),
      expect.objectContaining({
        name: 'product',
        action: 'rolled-back',
        deploymentId: 'dpl_product_old',
      }),
    ]);
  });

  it('records a candidate another actor promoted as live, not pending', async () => {
    // gate 実行中に外部 actor が同じ candidate を promote した場合。この run は
    // 動かしていないが live ではあるので、未着手に見せない。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_old', 'dpl_web_new'],
    });

    const result = await release({ fetchImpl: world.fetchImpl });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['product']);
    expect(result.manifest.projects).toContainEqual(
      expect.objectContaining({
        name: 'web',
        action: 'already-serving',
        deploymentId: 'dpl_web_new',
        sourceSha: SHA,
        observedAt: 'this-run',
      }),
    );
  });

  it('records the surviving deployment when the run fails after a promote', async () => {
    // 部分失敗の復旧では、手動 rollback 先が manifest から読めることが要件。
    const world = createReleaseWorld();
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      if (String(input).includes('/promote/dpl_web_old'))
        return new Response(null, { status: 500 });
      return world.fetchImpl(input, init);
    });

    let clock = 0;
    const error = (await release({
      fetchImpl,
      nowImpl: () => (clock += 60_000),
      simulateFailure: 'promote:product',
    }).catch(
      (thrown: Error & { manifest?: { projects: { name: string; action: string }[] } }) => thrown,
    )) as ReleaseError;

    expect(error.manifest?.status).toBe('failed');
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({ name: 'web', action: 'promoted', deploymentId: 'dpl_web_new' }),
    );
  });
});

describe('層 3 coverage の不変条件（#2574）', () => {
  // impact job（T0）と release（T1）は **別時刻の live production SHA** を基準に独立して
  // 影響判定を行う。live が前進するだけなら T1 の affected は T0 の subset なので安全側
  // だが、Vercel Instant Rollback で live が後退すると T1 だけが affected になり、層 3 を
  // 走らせていない project を promote しうる。gate 式は T0 しか見ないので止まらない。
  //
  // ここでは live 基準の差分を `diffFilesImpl` で模す（影響判定に基準 SHA が入る経路は
  // そこだけで、既存 test も同じ idiom を使っている）。

  it('impact が unaffected と言った project は promote しない（rollback で live が後退）', async () => {
    const world = createReleaseWorld();
    const error = (await release({
      fetchImpl: world.fetchImpl,
      // T1: 両 project affected（rollback で基準が後退し product の差分が復活した状態）
      diffFilesImpl: AFFECTS_BOTH,
      // T0: product は unaffected と判定され、e2e job が skip されている
      impactAffected: { web: true, product: false },
    }).catch((thrown: Error) => thrown)) as ReleaseError;

    // `/product/` は文中の `production` にも一致してしまい、project が名指しされて
    // いることを何も担保しない。名指し部分をそのまま突き合わせる。
    expect(error.message).toContain('product: the impact job reported unaffected');
    expect(error.message).toMatch(/layer 3/i);
    // **1 件も promote していない。** 検証済みの web も含めて run 全体を止める
    // （片側だけ promote すると runbook ケース0-B の「部分リリース」を自作するうえ、
    // 未検証側について success が出て tag gate を素通りする）。
    expect(world.pointCalls).toEqual([]);
    expect(error.manifest?.status).toBe('impact-mismatch');
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({
        name: 'product',
        affected: true,
        impactAffected: false,
        action: 'pending',
      }),
    );
  });

  it('impact の verdict が無い（env 配線が落ちた）時も promote しない', async () => {
    const world = createReleaseWorld();
    await expect(release({ fetchImpl: world.fetchImpl, impactAffected: {} })).rejects.toThrow(
      /layer 3/i,
    );
    expect(world.pointCalls).toEqual([]);
  });

  it('force は検査ごと免除する（impact job が壊れている時の break-glass）', async () => {
    // force は層 3 job 自体を skip する（promote.yml の e2e / web job の `if:`）。
    // ここで検査を効かせると、最後の手段が最も要る場面で使えなくなる。
    const world = createReleaseWorld();
    await expect(
      release({ fetchImpl: world.fetchImpl, force: true, impactAffected: {} }),
    ).resolves.toMatchObject({ status: 'promoted' });
    // `status: 'promoted'` は promote 0 件でも成立しうる（Auto-assign で先に配信済み）。
    // force 経路で promote 自体が行われなくなる書き換えを捕まえるため実 promote を見る。
    expect(world.promoted()).toEqual(['web', 'product']);
  });

  it('待機中に外部 promote された project も検査対象にする（pending ではなく targets で見る）', async () => {
    // **この PR が塞ぐ穴そのもの。** 待機中に人 / Auto-assign が同じ candidate を
    // 先に live にすると、その project は `pending` から外れる（二重 promote を
    // 避けるため）。検査を `pending` に対して行うと、層 3 未実行の build が
    // stabilize を通って success になり、tag gate まで素通りする。
    // 判定は必ず `targets`（= decisions）で行う。
    const world = createReleaseWorld({
      webAliasSequence: ['dpl_web_old', 'dpl_web_new'],
    });

    const error = (await release({
      fetchImpl: world.fetchImpl,
      impactAffected: { web: false, product: true },
    }).catch((thrown: Error) => thrown)) as ReleaseError;

    expect(error.message).toContain('web: the impact job reported unaffected');
    // promote は 1 件も走っていない。
    expect(world.pointCalls).toEqual([]);
    // このシナリオでは manifest は `impact-mismatch` ではなく `failed` になる。
    // wrapper の catch が最後に live を読み直し、待機中に外部 promote で production が
    // 実際に動いていたこと（deviation）を検出して上書きするため。**production が動いた
    // 事実の方が復旧判断には重い**ので、この上書きは正しい（runbook は `failed` を
    // 「`action: promoted` の project を戻す」経路として扱うが、ここでは promoted が
    // 0 件なので戻す対象も無い）。
    expect(error.manifest?.status).toBe('failed');
    expect(error.manifest?.projects).toContainEqual(
      expect.objectContaining({ name: 'web', impactAffected: false }),
    );
  });

  it('impactAffected を渡さない呼び出しは fail closed（既定値が fail open へ倒れていない）', () => {
    // `undefined` を上書きで渡すと wrapper の既定注入が消え、`runProductionRelease` の
    // default parameter（`impactAffected = {}`）が実際に効く。「既定を true 側にすると
    // 配線落ちで層 3 ゼロの promote が通る」という実装コメントの契約をここで固定する。
    const world = createReleaseWorld();
    return expect(
      release({ fetchImpl: world.fetchImpl, impactAffected: undefined }),
    ).rejects.toThrow(/layer 3/i);
  });

  it('impact が affected・release が unaffected の向きでは止めない（superset は正常）', async () => {
    // 層 3 が余分に走っただけ。この向きで落とすと、rollback 後の docs merge が永久に止まる。
    const world = createReleaseWorld();
    const result = await release({
      fetchImpl: world.fetchImpl,
      diffFilesImpl: () => ['apps/web/src/app/page.tsx'],
      impactAffected: { web: true, product: true },
    });

    expect(result.status).toBe('promoted');
    expect(world.promoted()).toEqual(['web']);
  });

  it('promote 対象が 0 件の run は verdict が無くても success（tag gate を止めない）', async () => {
    // docs のみの merge は create-release.yml の tag gate 用に success を出す必要がある。
    // 検査は空集合に対して vacuous でなければならない。
    const world = createReleaseWorld();
    await expect(
      release({
        fetchImpl: world.fetchImpl,
        diffFilesImpl: () => ['docs/x.md'],
        impactAffected: {},
      }),
    ).resolves.toMatchObject({ status: 'unaffected' });
    expect(world.pointCalls).toEqual([]);
  });
});

describe('readImpactAffected', () => {
  it('env の "true" / "false" だけを verdict として読む', () => {
    expect(
      readImpactAffected({
        RELEASE_IMPACT_WEB_AFFECTED: 'true',
        RELEASE_IMPACT_PRODUCT_AFFECTED: 'false',
      }),
    ).toEqual({ web: true, product: false });
  });

  it('それ以外はすべて null（未検証）へ倒す', () => {
    // '1' / 'TRUE' / 空文字を true へ丸めると、workflow の配線が落ちた時に
    // 「層 3 を通った」と誤解釈して fail open する。ここが唯一の変換点なので固定する。
    for (const raw of ['', undefined, 'TRUE', 'True', '1', 'yes']) {
      expect(readImpactAffected({ RELEASE_IMPACT_WEB_AFFECTED: raw }).web).toBeNull();
    }
  });

  it('project が増えたら env 名も増える（配線忘れは null = fail closed）', () => {
    expect(Object.keys(readImpactAffected({}))).toEqual(
      RELEASE_PROJECTS.map((project) => project.name),
    );
  });
});

describe('buildManifest', () => {
  const project = RELEASE_PROJECTS[0]!;
  const base = {
    sha: SHA,
    status: 'failed',
    projects: [project],
    decisions: new Map([[project.name, { affected: true, reason: 'changed' }]]),
    before: new Map([[project.name, { id: 'dpl_web_old', sha: OLD_SHA }]]),
    promoted: [],
    rolledBack: [],
  };

  it('labels a live target as uncertified unless this run gated it', () => {
    // 「gate を通ったか」は run の status から推測しない。status は gate の前に返る
    // 経路（superseded）もあれば、gate 通過後の設定失敗（settings-drift）もある。
    const atTarget = {
      ...base,
      before: new Map([[project.name, { id: 'dpl_web_new', sha: SHA }]]),
      decisions: new Map([[project.name, { affected: false, reason: 'already serving' }]]),
    };

    const ungated = buildManifest({ ...atTarget, gatesPassed: new Map() });
    expect(ungated.projects[0]).toMatchObject({
      action: 'uncertified',
      deploymentId: 'dpl_web_new',
      // run 開始時点から live なものが落ちた場合、その deployment 自身は戻し先に
      // ならない。null にして runbook 側で deployment 履歴を辿らせる。
      previousDeploymentId: null,
    });

    // 待機中に live になった場合は run 開始時点の deployment が実際の戻し先になる。
    const midRun = buildManifest({
      ...base,
      before: new Map([[project.name, { id: 'dpl_web_old', sha: OLD_SHA }]]),
      observedLive: new Map([[project.name, { id: 'dpl_web_new', sha: SHA }]]),
      gatesPassed: new Map(),
    });
    expect(midRun.projects[0]).toMatchObject({
      action: 'uncertified',
      deploymentId: 'dpl_web_new',
      previousDeploymentId: 'dpl_web_old',
    });

    // 認証は deployment 単位。同じ commit の別 deployment では認証済みにならない。
    const gated = buildManifest({
      ...atTarget,
      gatesPassed: new Map([[project.name, 'dpl_web_new']]),
    });
    expect(gated.projects[0]).toMatchObject({ action: 'already-serving' });
  });

  it('reports a run-start unassigned domain as unassigned, not pending', () => {
    // 既知の outage を「未着手」として隠さない。復旧手順（unassigned）へ導く。
    const manifest = buildManifest({
      ...base,
      before: new Map([[project.name, null]]),
      decisions: new Map([[project.name, { affected: true, reason: 'changed' }]]),
    });
    expect(manifest.projects[0]).toMatchObject({
      action: 'unassigned',
      deploymentId: null,
      // 戻し先が manifest に無いので、runbook 側で deployment 履歴を辿る。
      previousDeploymentId: null,
    });
  });

  it('lets a post-rollback observation override the rollback record', () => {
    // 戻した後に別 deployment が live になっていれば、`rolled-back`（= previous を
    // 配信中）は事実と違う。同じ commit の別 deployment でも同じ。
    const entry = {
      project,
      deployment: { id: 'dpl_web_new' },
      previous: { id: 'dpl_web_old', sha: OLD_SHA },
    };
    const manifest = buildManifest({
      ...base,
      promoted: [entry],
      rolledBack: [entry],
      observedLive: new Map([[project.name, { id: 'dpl_web_other', sha: SHA }]]),
      gatesPassed: new Map(),
    });
    expect(manifest.projects[0]).toMatchObject({
      deploymentId: 'dpl_web_other',
      action: 'uncertified', // target SHA だが gate を通していない deployment
    });
  });

  it('distinguishes an unassigned domain from another actor deployment', () => {
    const unassigned = buildManifest({
      ...base,
      observedLive: new Map([[project.name, { id: null, sha: null }]]),
    });
    expect(unassigned.projects[0]).toMatchObject({
      action: 'unassigned',
      deploymentId: null,
      observedAt: 'this-run',
    });

    const moved = buildManifest({
      ...base,
      observedLive: new Map([[project.name, { id: 'dpl_web_hotfix', sha: OLD_SHA }]]),
    });
    expect(moved.projects[0]).toMatchObject({
      action: 'moved-externally',
      deploymentId: 'dpl_web_hotfix',
    });
  });
});

describe('writeReleaseManifest', () => {
  it('writes the manifest only when a path is configured', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'release-manifest-')), 'manifest.json');
    const manifest = { sha: SHA, status: 'promoted', projects: [] };

    expect(writeReleaseManifest(manifest, { env: {} })).toBe(false);
    expect(writeReleaseManifest(manifest, { env: { RELEASE_MANIFEST_PATH: path } })).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(manifest);
  });
});

describe('writeReleaseStatus', () => {
  function outputFile() {
    return join(mkdtempSync(join(tmpdir(), 'release-status-')), 'output.txt');
  }

  it('writes each known status for the workflow to branch on', () => {
    for (const status of ['already-released', 'promoted', 'superseded', 'unaffected', 'failed']) {
      const path = outputFile();
      writeReleaseStatus(status, { env: { GITHUB_OUTPUT: path } });
      expect(readFileSync(path, 'utf8')).toBe(`release_status=${status}\n`);
    }
  });

  it('refuses to write a status outside the known set', () => {
    const path = outputFile();
    writeReleaseStatus('promoted\nmalicious=1', { env: { GITHUB_OUTPUT: path } });
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});

/**
 * 同一 commit の再配備（#2735）。env だけを更新して build し直した deployment は
 * source SHA が live と同じなので、通常 dispatch では `already serving` で終わる。
 * 名指しの deployment だけを、通常と同じ gate を通して promote する経路を検証する。
 */
describe('runProductionRelease（同一 commit の再配備）', () => {
  const REDEPLOY = { projectName: 'product', deploymentId: 'dpl_product_redeploy' };

  /** 両 project が既に target SHA を配信中で、product に env 更新後の build がある世界。 */
  function createRedeployWorld(
    record: ReturnType<typeof deploymentRecord> = deploymentRecord(
      'dpl_product_redeploy',
      SHA,
      3000,
      { projectId: 'prj_product' },
    ),
  ) {
    const world = createReleaseWorld({ productionSha: SHA });
    world.store.dpl_product_redeploy = record;
    return world;
  }

  const listedBySha = (world: ReturnType<typeof createReleaseWorld>) =>
    world.fetchImpl.mock.calls.filter(([input]) => String(input).includes('/v7/deployments'));

  it('入力が無ければ再配備として扱わない', () => {
    expect(parseRedeployRequest(undefined)).toBeNull();
    expect(parseRedeployRequest('  ')).toBeNull();
    expect(parseRedeployRequest('product:dpl_abc123')).toEqual({
      projectName: 'product',
      deploymentId: 'dpl_abc123',
    });
  });

  it.each(['product', 'dpl_abc123', 'storybook:dpl_abc123', 'product:abc123', 'product:dpl_a/b'])(
    '形式不正な入力 %s を通常 dispatch へ落とさず拒否する',
    (raw) => {
      expect(() => parseRedeployRequest(raw)).toThrow(/RELEASE_REDEPLOY must be/);
    },
  );

  it('名指しされた project だけ、同じ SHA でも affected にする', () => {
    const project = RELEASE_PROJECTS.find((entry) => entry.name === 'product')!;
    const base = { project, baseSha: SHA, targetSha: SHA };

    expect(resolveProjectImpact(base).affected).toBe(false);
    // .mjs（checkJs off）は既定値 null から引数型を推論するため、文字列を渡すには緩める。
    expect(resolveProjectImpact({ ...base, redeployDeploymentId: 'dpl_x' as never })).toEqual({
      affected: true,
      reason: expect.stringContaining('redeploy of dpl_x'),
    });
  });

  it('名指しの deployment だけを gate へ通して promote し、戻し先を残す', async () => {
    const world = createRedeployWorld();

    const result = await release({ fetchImpl: world.fetchImpl, redeploy: REDEPLOY });

    expect(result.status).toBe('promoted');
    expect(result.gateChecksRan).toBe(true);
    expect(world.pointCalls).toEqual([
      { project: 'product', deploymentId: 'dpl_product_redeploy' },
    ]);
    // 候補は ID で固定する。「SHA の最新 deployment」を探す経路は通らない。
    expect(listedBySha(world)).toEqual([]);
    // candidate 自体を smoke している（production domain の smoke とは別）。
    expect(
      world.fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('dpl_product_redeploy.vercel.app'),
      ),
    ).toBe(true);

    const manifest = result.manifest as ReleaseManifest;
    expect(manifest.projects.find((entry) => entry.name === 'product')).toMatchObject({
      action: 'promoted',
      deploymentId: 'dpl_product_redeploy',
      previousDeploymentId: 'dpl_product_new',
    });
    // web は動かさないが、run の後も gate を通した deployment として残る。
    expect(manifest.projects.find((entry) => entry.name === 'web')).toMatchObject({
      action: 'already-serving',
      deploymentId: 'dpl_web_new',
    });
  });

  it('promote 後の production smoke が落ちたら、元の deployment へ戻す', async () => {
    const world = createRedeployWorld();

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        redeploy: REDEPLOY,
        simulateFailure: 'production-smoke:product',
      }),
    ).rejects.toThrow();

    expect(world.pointCalls).toEqual([
      { project: 'product', deploymentId: 'dpl_product_redeploy' },
      { project: 'product', deploymentId: 'dpl_product_new' },
    ]);
    expect(world.live.product).toBe('dpl_product_new');
  });

  it('candidate の smoke が落ちたら promote しない', async () => {
    const world = createRedeployWorld();

    const error = (await release({
      fetchImpl: world.fetchImpl,
      redeploy: REDEPLOY,
      simulateFailure: 'smoke:product',
    }).catch((caught: unknown) => caught)) as ReleaseError;

    expect(error).toBeInstanceOf(Error);
    expect(world.pointCalls).toEqual([]);
    // live は run 開始時点のまま。同じ commit でも「戻せ」とは案内しない。
    expect(error.manifest?.projects.find((entry) => entry.name === 'product')).toMatchObject({
      action: 'pending',
      deploymentId: 'dpl_product_new',
    });
  });

  it('層 3 を通していない project の再配備は production を触らずに止める', async () => {
    const world = createRedeployWorld();

    await expect(
      release({
        fetchImpl: world.fetchImpl,
        redeploy: REDEPLOY,
        impactAffected: { web: false, product: false },
      }),
    ).rejects.toThrow(/without layer 3/);
    expect(world.pointCalls).toEqual([]);
  });

  it.each([
    [
      'live より古い build（env 更新前）',
      deploymentRecord('dpl_product_redeploy', SHA, 1500, { projectId: 'prj_product' }),
      /not newer than/,
    ],
    [
      '別 project の deployment',
      deploymentRecord('dpl_product_redeploy', SHA, 3000, { projectId: 'prj_web' }),
      /does not belong to product/,
    ],
    [
      'project が読めない deployment',
      deploymentRecord('dpl_product_redeploy', SHA, 3000),
      /does not belong to product/,
    ],
    [
      '別 commit の build',
      deploymentRecord('dpl_product_redeploy', OLD_SHA, 3000, { projectId: 'prj_product' }),
      /not a production build of/,
    ],
    [
      'build に失敗した deployment',
      deploymentRecord('dpl_product_redeploy', SHA, 3000, {
        projectId: 'prj_product',
        readyState: 'ERROR',
      }),
      /ended in ERROR/,
    ],
  ])('%s は candidate にしない', async (_label, record, message) => {
    const world = createRedeployWorld(record);

    await expect(release({ fetchImpl: world.fetchImpl, redeploy: REDEPLOY })).rejects.toThrow(
      message,
    );
    expect(world.pointCalls).toEqual([]);
  });

  it('live が別の commit なら再配備を拒否し、通常 dispatch へ誘導する', async () => {
    const world = createReleaseWorld();
    world.store.dpl_product_redeploy = deploymentRecord('dpl_product_redeploy', SHA, 3000, {
      projectId: 'prj_product',
    });

    await expect(release({ fetchImpl: world.fetchImpl, redeploy: REDEPLOY })).rejects.toThrow(
      /only replaces a deployment of the same commit/,
    );
    expect(world.pointCalls).toEqual([]);
  });

  it('Force Promote とは組み合わせられない', async () => {
    const world = createRedeployWorld();

    await expect(
      release({ fetchImpl: world.fetchImpl, redeploy: REDEPLOY, force: true }),
    ).rejects.toThrow(/cannot be combined with Force Promote/);
    expect(world.fetchImpl).not.toHaveBeenCalled();
  });

  it('名指しの deployment が既に live なら promote せず、gate を通して認証する', async () => {
    const world = createRedeployWorld();

    const result = await release({
      fetchImpl: world.fetchImpl,
      redeploy: { projectName: 'product', deploymentId: 'dpl_product_new' },
    });

    expect(result.status).toBe('already-released');
    expect(result.gateChecksRan).toBe(true);
    expect(world.pointCalls).toEqual([]);
  });
});
