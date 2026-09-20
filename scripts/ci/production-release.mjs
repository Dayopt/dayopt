import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveImpact } from './impact.mjs';
import { runProductionConfigAudit } from './production-config-audit.mjs';

const API_ORIGIN = 'https://api.vercel.com';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 並行性モデル（保証の境界）: single-writer 前提。CI は concurrency group で直列化され、
 * run 中の手動 Vercel 操作は runbook が禁じる。Vercel API にトランザクションが無い以上、
 * read と write の間の TOCTOU 窓はゼロにできない。この script が守るのは
 * 「知らない deployment を上書きしない / 読めない時は書かない / 観測した外部変更は
 * fail + manifest 報告」まで。窓を狭めるための再読み込みはこれ以上追加しない。
 * 正本: docs/engineering/infra.md §release の並行性モデル。
 */

/**
 * promote 順序 = 配列順。web を先に promote するため、2 つ目(product)が失敗した時に
 * rollback 対象になるのは web 側だけになる。
 *
 * `impactKey` は Impact Resolver（scripts/ci/impact.mjs）の出力キー。project 名と
 * 同じ文字列だが、判定側のキー名と release 側の project 名を別々に変えられるよう
 * 明示的に持つ。
 *
 * smoke は status だけでは足りない。product は未知 path でも 200 を返し
 * （`/[locale]/[nday]` が任意の 1 segment に一致する）、Next.js は streaming 中の
 * 失敗も 200 のまま返す。そこで Next.js が返す `x-matched-path` で
 * 「どの route が応答したか」を確定させ、内容が意味を持つ endpoint だけ本文も見る。
 */
export const RELEASE_PROJECTS = [
  {
    name: 'web',
    impactKey: 'web',
    bypassEnv: 'VERCEL_BYPASS_WEB',
    productionDomain: 'dayopt.app',
    smokeChecks: [
      // CTA の href まで見る。product 側の `/auth/signup` が生きていても、web から
      // その導線が消えていれば入口は失われる（destination の存在確認だけでは足りない）。
      // HeroSection は server component の素の <a href> なので SSR の本文に出る。
      { path: '/', matchedPath: '/en', contains: 'app.dayopt.app/auth/signup' },
      { path: '/ja', matchedPath: '/ja' },
    ],
  },
  {
    name: 'product',
    impactKey: 'product',
    bypassEnv: 'VERCEL_BYPASS_PRODUCT',
    productionDomain: 'app.dayopt.app',
    smokeChecks: [
      // health は degraded でも 200 を返すので、本文で healthy を確認する。
      { path: '/api/health', matchedPath: '/api/health', contains: '"status":"healthy"' },
      { path: '/auth/login', matchedPath: '/[locale]/auth/login' },
      // web の hero / header / pricing の CTA がここへ入る（app.dayopt.app/auth/signup）。
      // product 側だけを進めた release で消えると、web からの唯一の入口が落ちる。
      { path: '/auth/signup', matchedPath: '/[locale]/auth/signup' },
      // ja message bundle のロードまで通す。namespace 欠落は既知の事故モード。
      { path: '/ja/auth/login', matchedPath: '/[locale]/auth/login' },
    ],
  },
];

/**
 * impact job の output key（`<impactKey>_affected`）→ release job の step env 名。
 *
 * `release-impact.mjs` の `IMPACT_OUTPUT_KEYS` と 1:1 で、`promote.yml` の配線検査は
 * この 2 つを index で突き合わせてループする（片方だけ改名する事故を test で塞ぐ）。
 *
 * **ここから release-impact.mjs を import しないこと** —— あちらが既にこちらを
 * import しており、逆向きを張ると `IMPACT_OUTPUT_KEYS` の top-level 評価が
 * `RELEASE_PROJECTS` の TDZ を踏んで ReferenceError になる。
 */
export const impactEnvVar = (impactKey) => `RELEASE_IMPACT_${impactKey.toUpperCase()}_AFFECTED`;

/**
 * impact job の出力キーと release job の env 名を **1 つの構造から導出する**。
 *
 * 以前は `IMPACT_OUTPUT_KEYS` と `IMPACT_ENV_VARS` の 2 配列を index で対応させていたが、
 * それだと片方だけ並べ替えられた時（`.sort()` の追加、リテラル列挙への書き換え）に
 * contract test が **入れ替わった配線を要求する側へ回る**。runtime では
 * `readImpactAffected` が project 名で読むため、product の env に web の verdict が
 * 入っても静かに別 project の判定を使い、層 3 未実行の promote が通る。
 */
export const IMPACT_WIRING = RELEASE_PROJECTS.map((project) => ({
  name: project.name,
  outputKey: `${project.impactKey}_affected`,
  envVar: impactEnvVar(project.impactKey),
}));

/**
 * env → `runProductionRelease({ impactAffected })` の変換。
 *
 * **`'true'` 以外はすべて null（未検証）に倒す。** `'1'` / `'TRUE'` / 空文字を true へ
 * 丸めない —— そこが唯一の fail-open 経路になる。workflow の env 配線が 1 行落ちた時に
 * 「層 3 を通った」と誤って解釈すると、この gate ごと無効になる。
 */
export function readImpactAffected(env = process.env, projects = RELEASE_PROJECTS) {
  return Object.fromEntries(
    projects.map((project) => {
      const raw = env[impactEnvVar(project.impactKey)];
      return [project.name, raw === 'true' ? true : raw === 'false' ? false : null];
    }),
  );
}

/** 200 のまま streaming 中に失敗した Next.js response の目印。 */
const STREAMED_FAILURE_MARKERS = ['NEXT_HTTP_ERROR_FALLBACK', 'NEXT_REDIRECT'];

const READY_TIMEOUT_MS = 25 * 60 * 1000;
const READY_POLL_MS = 15 * 1000;
const ASSIGN_TIMEOUT_MS = 5 * 60 * 1000;
const ASSIGN_POLL_MS = 5 * 1000;
const SMOKE_ATTEMPTS = 3;
const SMOKE_TIMEOUT_MS = 15 * 1000;
const SMOKE_RETRY_DELAY_MS = 2 * 1000;
const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED', 'DELETED']);

/**
 * 「要求が受理されなかった」が確定する HTTP status。これ以外（5xx / transport 失敗）は
 * 届いたかどうか分からないので、production を動かした可能性がある側として扱う。
 * 429 も含める。rate limit は要求の拒否であって、受理して遅延しているのではない。
 */
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 429]);

/**
 * promote の受理が不確かな時、その反映を待つ窓。POST が 5xx / transport で失敗しても
 * Vercel 側が受理していることがあり、alias の変化は非同期に遅れて現れる。rollback 直後に
 * 「previous のままだから戻った」と即断すると、その後に元の promote が着地して
 * gate を通っていない deployment が live になる。
 *
 * 窓は `ASSIGN_TIMEOUT_MS` と同じにする。**この script 自身が assignment の反映に
 * その時間まで許しているのだから、遅れて着地する promote も同じ時間まで有効**。
 * これより短い窓にすると、その差の時間帯に着地する promote を必ず見逃す。
 */
const AMBIGUOUS_SETTLE_MS = ASSIGN_TIMEOUT_MS;

/**
 * 掃きと検証を交互に回す上限。外部 actor が promote を続ける限り収束しないので
 * 有限で打ち切り、最後の検証が通った時点の観測を根拠にする。
 */
const STABILIZE_ATTEMPTS = 3;

/**
 * この script が費やしうる最悪時間。workflow の `timeout-minutes` がこれを
 * 下回ると、rollback の途中で job が kill され、片方だけ promote された
 * production が手動 rollback の手掛かりごと失われる。
 * 内訳: candidate 待機 + 全 smoke の retry + promote 反映待ち + rollback 反映待ち。
 * smoke は candidate（promote 前）と production domain（promote 後）で 2 巡する。
 */
const WORST_CASE_SMOKE_MS =
  RELEASE_PROJECTS.reduce((total, project) => total + project.smokeChecks.length, 0) *
  (SMOKE_ATTEMPTS * SMOKE_TIMEOUT_MS + (SMOKE_ATTEMPTS - 1) * SMOKE_RETRY_DELAY_MS);

// project あたりの反映待ちは最大 3 回分。**promote の反映確認が timeout した場合**、
// その entry は受理が不確かなものとして扱われるので、
// 「promote の確認（timeout）+ rollback の確認 + 着地待ち」の 3 窓を連続で使う。
// transport 失敗で抜けた場合は promote の確認を行わないので 2 窓に収まる。
export const WORST_CASE_RELEASE_MS =
  READY_TIMEOUT_MS +
  WORST_CASE_SMOKE_MS * 2 +
  RELEASE_PROJECTS.length * (ASSIGN_TIMEOUT_MS * 2 + AMBIGUOUS_SETTLE_MS);

export class ReleaseError extends Error {
  constructor(message, { manualRollback } = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.manualRollback = manualRollback ?? null;
  }
}

// ─── 影響判定（Impact Resolver の release 側 consumer）──────────────────

const SHA_PATTERN = /^[0-9a-f]{40}$/;

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : 'unknown');

const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]+$/;

/**
 * 同一 commit の再配備要求（`RELEASE_REDEPLOY` = `<project>:<deployment id>`）を読む。
 *
 * env だけを更新して同じ commit を build し直した deployment は、source SHA が live と
 * 同じなので通常の影響判定では `already serving` になり、candidate 選択まで届かない
 * （#2735）。「SHA が同じなら最新を選ぶ」にしない理由は、同じ commit の deployment が
 * 複数ある時に **どの build を gate へ通すかを run の外で固定する**ため。ID を名指しに
 * すれば、dispatch 後に作られた別の build や env 更新前の古い build が紛れ込まない。
 *
 * 未指定（空文字）は null。形式不正は throw する —— 黙って通常 dispatch へ落とすと
 * `already-released` の success が返り、再配備が済んだように見える。
 */
export function parseRedeployRequest(raw, projects = RELEASE_PROJECTS) {
  const value = (raw ?? '').trim();
  if (value === '') return null;

  const separator = value.indexOf(':');
  const projectName = separator === -1 ? '' : value.slice(0, separator);
  const deploymentId = separator === -1 ? '' : value.slice(separator + 1);
  const names = projects.map((project) => project.name);
  if (!names.includes(projectName) || !DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new ReleaseError(
      `RELEASE_REDEPLOY must be <project>:<deployment id> ` +
        `(project = ${names.join(' | ')}, deployment id = dpl_...)`,
    );
  }
  return { projectName, deploymentId };
}

/**
 * 2 commit 間の変更ファイル一覧を返す。
 *
 * - `--no-renames` … rename 検出を切り、移動元の path も一覧へ残す。有効なままだと
 *   `apps/product/foo.ts` → `docs/foo.ts` の rename が新 path だけになり、ファイルが
 *   消えた側の app を unaffected と誤判定する（merge gate 側の previous_filename と同じ穴）
 * - `-z` … `core.quotePath` による非 ASCII path のエスケープを避ける
 *
 * 対象 commit が checkout に無い（shallow clone / gc 済み）場合は git が非 0 で終了し、
 * 呼び出し側の fail closed 経路へ落ちる。
 *
 * `cwd` は test が使い捨ての repo を渡すためだけの口。実行時は常に ROOT。
 */
export function gitDiffFiles(baseSha, targetSha, { cwd = ROOT } = {}) {
  const stdout = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', baseSha, targetSha],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // 失敗は戻り値（throw）で扱う。stderr をそのまま親へ流すと、fail closed の
      // 正常な分岐が run のログでは事故のように見える。
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return stdout.split('\0').filter(Boolean);
}

/**
 * `a` が `b` の祖先か。判定できなければ null（呼び出し側で fail closed に倒す）。
 *
 * `git merge-base --is-ancestor` は祖先なら exit 0、そうでなければ exit 1 を返す。
 * object が無い（shallow / gc 済み）場合は 128 前後で落ちるため、exit 1 と区別するには
 * stderr ではなく status を見る必要がある。
 */
export function gitIsAncestor(a, b, { cwd = ROOT } = {}) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', a, b], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (result.error || result.status === null) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null; // object が無い / 想定外
}

/** checkout の HEAD SHA。取れなければ null（fail closed 経路へ落とす）。 */
export function gitHeadSha({ cwd = ROOT } = {}) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 「この project の production を target SHA へ進める必要があるか」を判定する。
 *
 * 基準は **その project が今配信している deployment の source SHA**。project ごとに
 * 基準が違うのが要点で、web が 3 commit 遅れていても product だけが進んでいれば、
 * web の判定は web の live SHA から見た差分で行う。
 *
 * 判定不能はすべて affected（fail closed）へ倒す。Vercel の skip 判定ではなく
 * Dayopt 側の判定を正とする設計原則（overview.md §4-2）に従う。
 *
 * `checkoutAtTarget` は「checkout の tree が target SHA そのものか」。workspace 依存
 * グラフは **checkout の manifest** から解決するため、これが false だと target 当時と
 * 違うグラフで分類することになる。`workflow_dispatch` で古い SHA を再試行した時に
 * 起きる（promote.yml は main 包含だけを要求し、checkout は dispatch した ref のまま）。
 * 例えば target の後で web が package への依存を外していると、その package の変更が
 * 「web に consumer 無し」と判定され、live でない build に success が付く。
 */
export function resolveProjectImpact({
  project,
  baseSha,
  targetSha,
  checkoutAtTarget = true,
  diffFilesImpl = gitDiffFiles,
  /**
   * 同一 commit の再配備（§parseRedeployRequest）で名指しされた deployment ID。
   * 指定された project だけ、live が既に target SHA でも affected へ倒す。impact job
   * （層 3 の起動判定）と release の両方がこの同じ規則を使うので、再配備でも層 3 が走る。
   */
  redeployDeploymentId = null,
}) {
  if (!SHA_PATTERN.test(baseSha ?? '')) {
    return { affected: true, reason: 'current production SHA is unknown (fail closed)' };
  }
  if (baseSha === targetSha) {
    if (redeployDeploymentId) {
      return {
        affected: true,
        reason: `redeploy of ${redeployDeploymentId} requested for ${short(targetSha)}`,
      };
    }
    return { affected: false, reason: `already serving ${short(targetSha)}` };
  }
  if (!checkoutAtTarget) {
    return { affected: true, reason: 'checkout is not the release target (fail closed)' };
  }

  // この関数は throw しない。判定に関わるあらゆる失敗（git・workspace manifest の
  // 読み取り・分類）を affected へ倒す。呼び出し側は decisions を組み立てる前に
  // manifest を作れないので、ここで抜けると失敗経路だけ manifest を失う。
  try {
    const files = diffFilesImpl(baseSha, targetSha);

    // git が正常終了して 0 件を返したのは「差分が無い」という確定的な答え。
    // 変更ファイル一覧の取得失敗（resolveImpact 側の fail closed 対象）とは別物なので、
    // resolveImpact へ空配列を渡さずここで unaffected を確定させる。
    if (files.length === 0) {
      return { affected: false, reason: `no file changes since ${short(baseSha)}` };
    }

    const impact = resolveImpact(files);
    // 未知キー（impactKey の改名事故）も affected へ倒す。
    const affected = impact[project.impactKey] !== false;
    const trigger = impact.reasons?.[project.impactKey] ?? impact.unknown?.[0];
    return {
      affected,
      reason: affected
        ? `changed since ${short(baseSha)}${trigger ? ` (${trigger})` : ''}`
        : `no ${project.impactKey} impact since ${short(baseSha)}`,
    };
  } catch {
    return {
      affected: true,
      reason: `cannot resolve impact for ${short(baseSha)}..${short(targetSha)} (fail closed)`,
    };
  }
}

function apiUrl(path, teamId, params = {}) {
  const url = new URL(`${API_ORIGIN}${path}`);
  url.searchParams.set('teamId', teamId);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function callVercel(
  url,
  { token, fetchImpl, method = 'GET', label, body, parseJson = true },
) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (method !== 'GET') {
    // 公式 client は promote / rollback に空の JSON body を送る。
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }

  const response = await fetchImpl(url, init);
  if (!response.ok) {
    // Response body may echo request context; report the status only.
    // status は呼び出し側が「要求が確実に拒否されたか（4xx）」と「届いたか不明か
    // （5xx / transport）」を区別するために使う。
    throw Object.assign(
      new ReleaseError(`Vercel API ${label} failed with status ${response.status}`),
      { status: response.status },
    );
  }
  // promote / rollback answer 201 / 202 and may carry an empty body.
  return parseJson ? response.json() : null;
}

function normalizeDeployment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.uid ?? raw.id;
  if (typeof id !== 'string') return null;
  return {
    id,
    url: typeof raw.url === 'string' ? raw.url : null,
    state: raw.readyState ?? raw.state ?? null,
    createdAt: raw.createdAt ?? raw.created ?? null,
    target: raw.target ?? null,
    // GitHub 連携以外（CLI / API）の deployment はこの値を持たない。
    // 正規経路の build だけを release 対象にするため、これを必須にする。
    sha: raw.meta?.githubCommitSha ?? null,
    // 名指しの再配備（§getPinnedDeployment）が「別 project の deployment ではない」ことを
    // 確かめるために使う。一覧系の応答には無いことがある。
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
  };
}

/**
 * 名指しされた deployment を 1 件読み、再配備の candidate として受理できるか検証する。
 *
 * 受理条件はすべて fail closed（値が読めない時も拒否）:
 *
 * - その project の deployment である（他 project の ID を production domain へ載せない）
 * - GitHub 連携の production build で、source SHA が release 対象と一致する
 * - **live より後に作られている。** 同じ commit の deployment は祖先関係で新旧を
 *   決められないので、ここだけは作成時刻で比べる。env 更新より前の古い build を
 *   名指しして「再配備」すると、更新したはずの設定が production から消える
 */
export async function getPinnedDeployment({
  projectName,
  projectId,
  deploymentId,
  sha,
  liveCreatedAt,
  token,
  teamId,
  fetchImpl,
}) {
  const raw = await callVercel(
    apiUrl(`/v13/deployments/${encodeURIComponent(deploymentId)}`, teamId),
    { token, fetchImpl, label: `deployment(${projectName})` },
  );
  const deployment = normalizeDeployment(raw);
  const refuse = (why) =>
    new ReleaseError(`${projectName}: refusing to redeploy ${deploymentId}: ${why}`);

  if (deployment === null || deployment.id !== deploymentId) {
    throw refuse('the deployment could not be read');
  }
  if (deployment.projectId !== projectId) {
    throw refuse(`it does not belong to ${projectName}`);
  }
  if (deployment.target !== 'production' || deployment.sha !== sha) {
    throw refuse(`it is not a production build of ${sha}`);
  }
  if (
    typeof deployment.createdAt !== 'number' ||
    typeof liveCreatedAt !== 'number' ||
    deployment.createdAt <= liveCreatedAt
  ) {
    throw refuse('it is not newer than the deployment that production serves now');
  }
  return deployment;
}

/** target SHA の production deployment を 1 件返す。無ければ null。 */
export async function findDeploymentForSha({ projectName, sha, token, teamId, fetchImpl }) {
  const url = apiUrl('/v7/deployments', teamId, {
    projectId: projectName,
    target: 'production',
    sha,
    limit: '20',
  });
  const body = await callVercel(url, {
    token,
    fetchImpl,
    label: `deployments(${projectName})`,
  });

  const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
  // server 側の filter を信用しきらず、SHA と target を手元で再確認する。
  const matches = deployments
    .map(normalizeDeployment)
    .filter(
      (deployment) =>
        deployment !== null && deployment.sha === sha && deployment.target === 'production',
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return matches[0] ?? null;
}

/**
 * project の現在状態を 1 回の呼び出しで取る。
 *
 * `/v9/projects/{idOrName}` は名前で引けるが、promote / rollback の path は
 * `prj_` ID を要求する。ここで得た ID を以降の書き込みに使い、名前解決の
 * 曖昧さを release 経路から外す。
 */
export async function getProjectMeta({ projectName, token, teamId, fetchImpl }) {
  const url = apiUrl(`/v9/projects/${encodeURIComponent(projectName)}`, teamId);
  const body = await callVercel(url, {
    token,
    fetchImpl,
    label: `project(${projectName})`,
  });
  if (typeof body?.id !== 'string') {
    throw new ReleaseError(`${projectName}: could not resolve the Vercel project id`);
  }
  return {
    projectId: body.id,
    // promote endpoint がこの設定を書き換えるため、事前値を控えて後で戻す。
    autoAssignCustomDomains: body.autoAssignCustomDomains ?? null,
  };
}

/**
 * production domain を「今」配信している deployment を返す。未割当なら null。
 *
 * `/v9/projects/{id}` の `targets.production` は使えない。あれは production target の
 * **最新** deployment を指し、まだ build 中でもその値になる。実際に merge 直後
 * 8 秒（build 完了の 60 秒前）で新 deployment を指すことを実測した。alias が唯一
 * 「今どれが配信しているか」を表す。
 */
export async function getLiveProduction({
  projectName,
  productionDomain,
  projectId,
  token,
  teamId,
  fetchImpl,
}) {
  const aliasUrl = apiUrl(`/v4/aliases/${encodeURIComponent(productionDomain)}`, teamId, {
    projectId,
  });
  const alias = await callVercel(aliasUrl, {
    token,
    fetchImpl,
    label: `alias(${projectName})`,
  });

  const deploymentId = alias?.deploymentId ?? alias?.deployment?.id;
  if (typeof deploymentId !== 'string') return null;

  const deployment = await callVercel(
    apiUrl(`/v13/deployments/${encodeURIComponent(deploymentId)}`, teamId),
    { token, fetchImpl, label: `deployment(${projectName})` },
  );
  return normalizeDeployment(deployment);
}

export async function getProjectState({ projectName, productionDomain, token, teamId, fetchImpl }) {
  const meta = await getProjectMeta({ projectName, token, teamId, fetchImpl });
  const production = await getLiveProduction({
    projectName,
    productionDomain,
    projectId: meta.projectId,
    token,
    teamId,
    fetchImpl,
  });
  return { ...meta, production };
}

/**
 * promote / rollback の副作用で書き換わった Auto-assign Custom Domains を戻す。
 *
 * `POST /v10/projects/{id}/promote/{deploymentId}` は project 設定の
 * `autoAssignCustomDomains` を `true` に戻す（vercel/vercel#15095、未修正）。
 * 放置すると次の main merge が gate を通らず直接公開されるため、
 * release の直前に観測した値へ必ず戻す。
 */
async function restoreAutoAssignCustomDomains({
  projectName,
  projectId,
  expected,
  token,
  teamId,
  fetchImpl,
  logger,
}) {
  if (typeof expected !== 'boolean') {
    // gate の前提は「Auto-assign が無効であること」なので、観測できなかった事実は残す。
    logger.log(`${projectName}: autoAssignCustomDomains was not observable; skipping restore`);
    return false;
  }

  const current = await getProjectMeta({ projectName, token, teamId, fetchImpl });
  if (current.autoAssignCustomDomains === expected) return false;

  await callVercel(apiUrl(`/v9/projects/${encodeURIComponent(projectId)}`, teamId), {
    token,
    fetchImpl,
    method: 'PATCH',
    label: `restore-auto-assign(${projectName})`,
    body: { autoAssignCustomDomains: expected },
    parseJson: false,
  });
  logger.log(`${projectName}: restored autoAssignCustomDomains to ${expected}`);
  return true;
}

/**
 * 全 project の candidate が READY になるまで待つ。
 * ERROR / CANCELED は復帰しないので即座に失敗させる。
 */
export async function waitForReadyCandidates({
  projects,
  sha,
  token,
  teamId,
  fetchImpl,
  sleepImpl,
  nowImpl,
  logger,
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  /**
   * project 名 → `{ deploymentId, projectId, liveCreatedAt }`。載っている project は
   * 「SHA の最新 deployment」を探さず、名指しの deployment だけを candidate にする。
   */
  pinned = new Map(),
}) {
  const deadline = nowImpl() + timeoutMs;
  const ready = new Map();

  for (;;) {
    for (const project of projects) {
      if (ready.has(project.name)) continue;

      const pin = pinned.get(project.name);
      const deployment = pin
        ? await getPinnedDeployment({
            projectName: project.name,
            ...pin,
            sha,
            token,
            teamId,
            fetchImpl,
          })
        : await findDeploymentForSha({
            projectName: project.name,
            sha,
            token,
            teamId,
            fetchImpl,
          });
      if (!deployment) continue;

      if (TERMINAL_FAILURE_STATES.has(deployment.state)) {
        throw new ReleaseError(
          `${project.name}: production build for ${sha} ended in ${deployment.state}`,
        );
      }
      if (deployment.state === 'READY') {
        logger.log(`${project.name}: candidate ${deployment.id} is READY`);
        ready.set(project.name, deployment);
      }
    }

    if (ready.size === projects.length) {
      return projects.map((project) => ({ project, deployment: ready.get(project.name) }));
    }

    if (nowImpl() >= deadline) {
      const pending = projects
        .filter((project) => !ready.has(project.name))
        .map((project) => project.name)
        .join(', ');
      throw new ReleaseError(
        `Timed out waiting for READY production builds of ${sha} (pending: ${pending})`,
      );
    }

    await sleepImpl(pollMs);
  }
}

function isProtectionRedirect(response) {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers?.get?.('location');
  if (!location) return false;
  try {
    const url = new URL(location);
    return url.host === 'vercel.com' && url.pathname === '/sso-api';
  } catch {
    return false;
  }
}

/**
 * candidate deployment の unique URL を read-only で検証する。
 * Deployment Protection が有効なため bypass secret が必須。
 */
export async function smokeDeployment({
  projectName,
  deploymentUrl,
  checks,
  bypassSecret,
  fetchImpl,
  sleepImpl,
  logger,
  attempts = SMOKE_ATTEMPTS,
  timeoutMs = SMOKE_TIMEOUT_MS,
}) {
  const headers = {
    // 明示しないと locale 検出でトップページが別 locale へ redirect されうる。
    'accept-language': 'en',
    ...(bypassSecret ? { 'x-vercel-protection-bypass': bypassSecret } : {}),
  };

  for (const { path, matchedPath, contains } of checks) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`https://${deploymentUrl}${path}`, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (isProtectionRedirect(response)) {
          // Retrying cannot fix a missing bypass secret.
          throw new ReleaseError(
            `${projectName}: Deployment Protection blocked ${path}. ` +
              `Enable Protection Bypass for Automation and set the matching repository secret.`,
          );
        }
        if (response.status === 200) {
          // 以下の不一致は routing / render の問題なので retry しても変わらない。
          const matched = response.headers?.get?.('x-matched-path');
          if (matchedPath && matched !== matchedPath) {
            throw new ReleaseError(
              `${projectName}: smoke ${path} was served by ${matched ?? 'an unknown route'} ` +
                `(expected ${matchedPath})`,
            );
          }

          const body = await response.text();
          const streamedFailure = STREAMED_FAILURE_MARKERS.find((marker) => body.includes(marker));
          if (streamedFailure) {
            throw new ReleaseError(
              `${projectName}: smoke ${path} returned 200 but streamed ${streamedFailure}`,
            );
          }
          if (contains && !body.includes(contains)) {
            throw new ReleaseError(
              `${projectName}: smoke ${path} returned 200 without the expected content`,
            );
          }

          lastError = null;
          break;
        }
        lastError = new ReleaseError(
          `${projectName}: smoke ${path} returned ${response.status} (expected 200)`,
        );
      } catch (error) {
        if (error instanceof ReleaseError) throw error;
        // Network/timeout failures carry no response body; keep only the reason name.
        lastError = new ReleaseError(
          `${projectName}: smoke ${path} failed (${error?.name ?? 'RequestFailed'})`,
        );
      }

      if (attempt < attempts) await sleepImpl(SMOKE_RETRY_DELAY_MS);
    }

    if (lastError) throw lastError;
    logger.log(`${projectName}: smoke ${path} ok`);
  }
}

async function waitForProductionAssignment({
  projectName,
  productionDomain,
  projectId,
  deploymentId,
  token,
  teamId,
  fetchImpl,
  sleepImpl,
  nowImpl,
  action,
  timeoutMs = ASSIGN_TIMEOUT_MS,
  pollMs = ASSIGN_POLL_MS,
}) {
  const deadline = nowImpl() + timeoutMs;

  for (;;) {
    const production = await getLiveProduction({
      projectName,
      productionDomain,
      projectId,
      token,
      teamId,
      fetchImpl,
    });
    if (production?.id === deploymentId) return production;

    if (nowImpl() >= deadline) {
      throw new ReleaseError(
        `${projectName}: ${action} did not take effect for deployment ${deploymentId}`,
      );
    }
    await sleepImpl(pollMs);
  }
}

/**
 * production domain を指定 deployment へ向けるよう要求する。反映確認はしない。
 *
 * promote と rollback で同じ endpoint を使う。REST API には rollback 専用の
 * `/v1/projects/{id}/rollback/{deploymentId}` もあるが、対象が
 * `isRollbackCandidate` に限られる。promote は「任意の deployment へ production
 * traffic を向ける」ことが明記されており、復旧経路では同じ run の中で先に
 * 成功実績を作る呼び出しを再利用する方が失敗確率が低い。
 *
 * 要求と確認を分けているのは、POST が受理された時点で production が動きうるため。
 * 呼び出し側は確認を待つ前に rollback 対象として記録する。
 */
async function requestProductionPointer({
  projectName,
  projectId,
  deploymentId,
  token,
  teamId,
  fetchImpl,
  action,
}) {
  const url = apiUrl(
    `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
    teamId,
  );
  await callVercel(url, {
    token,
    fetchImpl,
    method: 'POST',
    label: `${action}(${projectName})`,
    parseJson: false,
  });
}

/** production domain を既知の正常 deployment へ戻し、反映まで確認する。 */
async function rollbackDeployment({
  projectName,
  productionDomain,
  projectId,
  deploymentId,
  autoAssignCustomDomains,
  token,
  teamId,
  fetchImpl,
  sleepImpl,
  nowImpl,
  logger,
}) {
  await requestProductionPointer({
    projectName,
    projectId,
    deploymentId,
    token,
    teamId,
    fetchImpl,
    action: 'rollback',
  });
  const production = await waitForProductionAssignment({
    projectName,
    productionDomain,
    projectId,
    deploymentId,
    token,
    teamId,
    fetchImpl,
    sleepImpl,
    nowImpl,
    action: 'rollback',
  });
  // production pointer は戻っている。設定復元の失敗をここで throw すると
  // 「rollback 自体が失敗した」と誤報し、既に戻っている先への手動 rollback を
  // 指示することになる。両者を分けて返す。
  let autoAssignDrifted = false;
  try {
    await restoreAutoAssignCustomDomains({
      projectName,
      projectId,
      expected: autoAssignCustomDomains,
      token,
      teamId,
      fetchImpl,
      logger,
    });
  } catch {
    autoAssignDrifted = true;
  }
  return { production, autoAssignDrifted };
}

/**
 * 復元をまとめて試し、`drifted`（失敗した project）と `restored`（実際に直した
 * project）を返す。個別失敗は throw しない。
 *
 * `restored` が空でないことは「直前に外部の promote があった」証拠になる。alias を
 * 動かさない再 promote（同じ deployment を promote し直す）は設定だけを飛ばすので、
 * これが唯一の検出手段。
 */
async function restoreAll({ entries, token, teamId, fetchImpl, logger }) {
  const drifted = [];
  const restored = [];
  for (const entry of entries) {
    try {
      const didRestore = await restoreAutoAssignCustomDomains({
        projectName: entry.project.name,
        projectId: entry.projectId,
        expected: entry.autoAssignCustomDomains,
        token,
        teamId,
        fetchImpl,
        logger,
      });
      if (didRestore) restored.push(entry.project.name);
    } catch {
      drifted.push(entry.project.name);
    }
  }
  return { drifted, restored };
}

function driftError(sha, drifted) {
  return new ReleaseError(
    `Production serves ${sha}, but autoAssignCustomDomains could not be restored for ` +
      `${drifted.join(', ')}. Set it back before the next merge or the release gate is bypassed.`,
  );
}

function assertSimulationPoint(simulateFailure, point) {
  if (simulateFailure === point) {
    throw new ReleaseError(`Simulated failure at ${point} (release drill)`);
  }
}

// ─── release manifest ───────────────────────────────────────────────

/**
 * 「この run の後、どの project が何を配信しているか」を機械可読で残す。
 *
 * affected-aware 化で project ごとに live SHA が別々になりうるため、run の
 * ログを読まないと production の実態が分からない状態を避ける。部分失敗の
 * 復旧では、これが手動 rollback 先の一次情報になる。
 */
export function buildManifest({
  sha,
  status,
  projects,
  decisions,
  before,
  promoted,
  rolledBack,
  observedLive = new Map(),
  gatesPassed = new Map(),
  impactAffected = {},
}) {
  const promotedBy = new Map(promoted.map((entry) => [entry.project.name, entry]));
  const rolledBackNames = new Set(rolledBack.map((entry) => entry.project.name));

  return {
    sha,
    status,
    projects: projects.map((project) => {
      const decision = decisions.get(project.name);
      const live = before.get(project.name) ?? null;
      const entry = promotedBy.get(project.name);
      const rolled = entry && rolledBackNames.has(project.name);
      // promote 済みで rollback していない = その deployment が今も live。run が
      // 失敗している場合、これがそのまま手動 rollback の対象になる。
      const serving = entry && !rolled ? { id: entry.deployment.id, sha } : null;
      const restored = rolled
        ? { id: entry.previous?.id ?? null, sha: entry.previous?.sha ?? null }
        : null;
      // **観測は 1 本に統一する。** どの経路で読んだかを問わず「最後に観測した live」
      // だけを持ち、分類はそこから導く。2 つの map（同一 SHA の入れ替わり用と
      // それ以外用）に分けていた頃は、経路ごとに拾い漏れが出続けた。
      const observed = observedLive.get(project.name) ?? null;

      // 我々が置いたつもりの値。観測が無い時のみ使う。
      const placed = serving ?? restored ?? null;
      const effective = observed ?? placed ?? live;

      // **認証は deployment 単位。** 同じ commit の別 deployment は gate を通っていない。
      const certified = gatesPassed.get(project.name) === (effective?.id ?? null);

      /**
       * 分類の決定表。**観測が我々の記録より強い**（実際に配信しているものを載せる）。
       */
      const classify = () => {
        if (!effective?.id) return 'unassigned';

        const isOurCandidate = effective.id === entry?.deployment?.id;
        const isOurPrevious = entry?.previous?.id && effective.id === entry.previous.id;

        if (entry && isOurCandidate && !rolled) return 'promoted';
        if (entry && isOurPrevious && rolled) return 'rolled-back';

        // ここから先は「我々の操作の結果ではないものが live」。
        // 再配備が promote へ届かなかった run。live は run 開始時点のままで、同じ commit
        // なので下の SHA 比較へ進むと `uncertified`（= 戻せ）と案内してしまう。
        // `affected` かつ live が target SHA になるのは再配備だけ（通常は unaffected）。
        if (
          decision?.affected &&
          !entry &&
          effective.id === (live?.id ?? null) &&
          live?.sha === sha
        ) {
          return 'pending';
        }
        if (effective.sha === sha) return certified ? 'already-serving' : 'uncertified';
        if (effective.id === (live?.id ?? null) && !entry) {
          return decision?.affected ? 'pending' : 'skipped';
        }
        return 'moved-externally';
      };

      const action = classify();

      return {
        name: project.name,
        productionDomain: project.productionDomain,
        // `affected` はこの run（T1、promote 直前の live 基準）の判定。
        // `impactAffected` は impact job（T0、層 3 の起動判定）の判定 = その project で
        // 層 3 が走ったか。**2 つが食い違った時に production を触らずに止めた**ことを、
        // artifact だけで読めるようにする（#2574）。
        affected: decision?.affected ?? null,
        impactAffected: impactAffected[project.name] ?? null,
        reason: decision?.reason ?? null,
        action,
        deploymentId: effective?.id ?? null,
        sourceSha: effective?.sha ?? null,
        // 復旧先。promote entry があればその previous。それ以外（`uncertified` /
        // `unassigned`）では run 開始時点の deployment が唯一の手掛かりになる。
        // ただし **今 live なものと同じ ID は戻し先にならない** — run 開始時点で既に
        // target が live だった project が gate に落ちた場合、run 開始時点の deployment は
        // まさにその落ちた deployment なので、null にして runbook 側で履歴を辿らせる。
        previousDeploymentId:
          entry?.previous?.id ??
          ((action === 'uncertified' || action === 'unassigned') &&
          live?.id &&
          live.id !== effective?.id
            ? live.id
            : null),
        // この run が観測していない project の値は run 開始時点のもの。candidate 待機
        // （最大 25 分）の間に人が Instant Rollback していれば実態とズレる。復旧時に
        // 「いつ観測した値か」を取り違えないよう、出所を値と一緒に残す。
        observedAt: observed || entry ? 'this-run' : 'run-start',
      };
    }),
  };
}

/**
 * manifest を run の artifact として残す。path 未設定なら何もしない。
 *
 * 書き込み失敗で run の合否を変えない。manifest は診断用で、ここで throw すると
 * promote 済みの正常な release を artifact の都合で失敗扱いにしてしまう。
 */
export function writeReleaseManifest(manifest, { env = process.env, logger = console } = {}) {
  if (!manifest) return false;
  const path = env.RELEASE_MANIFEST_PATH;
  if (!path) return false;
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return true;
  } catch (error) {
    logger.error?.(`Could not write the release manifest (${error?.name ?? 'WriteFailed'})`);
    return false;
  }
}

/**
 * merge 済み SHA を、その merge の影響を受ける project の production domain へ公開する。
 *
 * 影響を受けない project は candidate を待たず promote もしない（Vercel が
 * deployment 自体を作らないため、待てば必ず timeout する）。production を動かす
 * 意図があった run は、最後に**全 project の production domain**を smoke する。
 * 片側だけ進んだ production は、その組み合わせが初めて世に出る状態だから。
 */
export async function runProductionRelease({
  sha,
  token,
  teamId,
  force = false,
  /**
   * impact job（層 3 の起動判定、T0）の verdict。**project 名** → `true` / `false` / `null`。
   *
   * この script 自身の影響判定（T1）とは基準にする live production SHA の時刻が違うため、
   * 両者は独立に食い違いうる（#2574）。`true` の project についてだけ層 3 が走っている。
   *
   * **既定は空 = 全 project「未検証」**。true 側を既定にすると fail open になり、
   * workflow の env 配線が 1 行落ちただけで層 3 ゼロの promote が通る。
   * `force`（break-glass）の時だけこの検査ごと免除する。
   */
  impactAffected = {},
  /**
   * 同一 commit の再配備要求 `{ projectName, deploymentId }`（§parseRedeployRequest）。
   * 名指しの project だけ、live が既に target SHA でも candidate を ID 固定で取り、
   * 通常と同じ gate（層 3 の検査・smoke・config audit・live 検証）を通して promote する。
   */
  redeploy = null,
  // gate が有効な運用（Auto-assign 無効化済み）では false を宣言する。
  // null の間は「run 開始時点の値へ戻す」だけになり、前回 run から持ち越した
  // ドリフトは検出できない。段階適用が終わったら宣言する。
  expectedAutoAssign = null,
  bypassSecrets = {},
  projects = RELEASE_PROJECTS,
  simulateFailure = '',
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = () => Date.now(),
  diffFilesImpl = gitDiffFiles,
  headShaImpl = gitHeadSha,
  isAncestorImpl = gitIsAncestor,
  logger = console,
}) {
  if (!token) throw new ReleaseError('VERCEL_TOKEN is required for Production Release');
  if (!teamId) throw new ReleaseError('VERCEL_TEAM_ID is required for Production Release');
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new ReleaseError('RELEASE_SHA must be a 40 character commit SHA');
  }
  if (redeploy && force) {
    // 再配備は「通常の検証を維持したまま同じ commit を出し直す」経路。force は検証を
    // 省くので、組み合わせると env 更新後の build が一度も検証されずに live になる。
    throw new ReleaseError('A redeploy cannot be combined with Force Promote');
  }
  if (redeploy && !projects.some((project) => project.name === redeploy.projectName)) {
    throw new ReleaseError(`Unknown redeploy project: ${redeploy.projectName}`);
  }

  const projectIds = new Map();
  const autoAssign = new Map();
  const before = new Map();
  for (const project of projects) {
    const state = await getProjectState({
      projectName: project.name,
      productionDomain: project.productionDomain,
      token,
      teamId,
      fetchImpl,
    });
    projectIds.set(project.name, state.projectId);
    autoAssign.set(project.name, state.autoAssignCustomDomains);
    before.set(project.name, state.production);
  }

  // job が任意の時点で消えても手動 rollback 先が run に残るよう、先に書き出す。
  const openingLines = ['## Production Release', '', `- Commit: \`${sha}\``];
  for (const project of projects) {
    const current = before.get(project.name);
    const line =
      `- ${project.name}: current production \`${current?.id ?? 'none'}\`` +
      ` (sha \`${current?.sha ?? 'unknown'}\`, autoAssign ${autoAssign.get(project.name)})`;
    openingLines.push(line);
    logger.log(line.slice(2));
  }
  writeStepSummary(openingLines);

  const expectedFor = (name) =>
    typeof expectedAutoAssign === 'boolean' ? expectedAutoAssign : autoAssign.get(name);

  // project ごとに「今配信している SHA → target SHA」の差分で影響を判定する。
  // 既に target を配信している project は差分が空になるため affected にならない
  // （alreadyServing と targets は排他）。
  // 依存グラフも diff も checkout の tree から読む。target と違う tree で分類すると
  // 当時と違うグラフで判定することになるため、一致しない run は fail closed に倒す。
  const checkoutAtTarget = headShaImpl() === sha;
  if (!checkoutAtTarget) {
    logger.log(`Checkout is not ${sha}; classifying every project as affected (fail closed).`);
  }

  // 名指しの deployment が既に live なら、再配備としてやることは残っていない。通常の
  // `already serving` 経路へ落とし、そこで smoke と audit を通して認証する。
  const redeployLive = redeploy ? before.get(redeploy.projectName) : null;
  const redeployPending = redeploy && redeployLive?.id !== redeploy.deploymentId;
  if (redeploy && !redeployPending) {
    logger.log(`${redeploy.projectName}: production already serves ${redeploy.deploymentId}.`);
  }

  const decisions = new Map();
  const decisionLines = [];
  for (const project of projects) {
    const decision = resolveProjectImpact({
      project,
      baseSha: before.get(project.name)?.sha ?? null,
      targetSha: sha,
      checkoutAtTarget,
      diffFilesImpl,
      redeployDeploymentId:
        redeployPending && redeploy.projectName === project.name ? redeploy.deploymentId : null,
    });
    decisions.set(project.name, decision);
    const line = `- ${project.name}: ${decision.affected ? 'affected' : 'skip'} — ${decision.reason}`;
    decisionLines.push(line);
    logger.log(line.slice(2));
  }
  writeStepSummary(['', '### Impact', '', ...decisionLines]);

  const targets = projects.filter((project) => decisions.get(project.name).affected);
  // 再配備の対象は target SHA を配信していても targets 側に入る。両方へ入れると
  // 「この run の rollback scope の外」と誤って案内してしまう（§preexistingSplit）。
  const alreadyServing = projects.filter(
    (project) => before.get(project.name)?.sha === sha && !targets.includes(project),
  );

  // この run が promote していないのに target SHA が live になった project。
  // 待機中や gate 実行中に外部 actor が同じ candidate を promote した場合に入る。
  /**
   * **この run が最後に観測した live（project 名 → {id, sha}）。**
   *
   * どの経路（待機後の再取得 / promote 直前 / rollback / 最終 refresh）で読んだかを
   * 問わず、ここへ上書きする。manifest の分類はこの 1 本から導く。観測用途で map を
   * 分けていた頃は、経路ごとに拾い漏れが出続けた。
   */
  const observedLive = new Map();

  /**
   * **この run の gate（production smoke + config audit + live 検証）を実際に通した
   * project 名。** 「target が live なのに gate を通っていない」を manifest で
   * `uncertified` として区別するために使う。
   *
   * run の status から推測しない。status は gate の前に返る経路（superseded）もあれば、
   * gate を通った後の設定失敗（settings-drift）もあり、どちらも「認証されたか」とは
   * 独立だから。
   */
  const gatesPassed = new Map();
  /** verifyLiveState が最後に確認した live ID（project 名 → ID）。 */
  const verifiedIds = new Map();

  // この run が promote した後に他者が別 deployment を live にした project。
  // rollback せず残すため、manifest には観測した live を載せる（我々の candidate を
  // 配信中と誤記すると、runbook の手順で「戻す」対象に見えてしまう）。

  /**
   * 失敗 manifest を作る前に、全 project の live を読み直して観測を反映する。
   *
   * gate（smoke / audit）が落ちた時点では、その project の live が run 開始時点から
   * 動いていても誰も記録していない。manifest が run 開始時点の deployment を
   * `skipped` / `already-serving` として載せると、runbook が「触るな」と案内して
   * unhealthy な domain を放置させる。読めない project は黙って飛ばす（best effort）。
   */
  const refreshObservedLive = async ({ expected: overrides = new Map() } = {}) => {
    const deviated = [];
    for (const project of projects) {
      // 比較対象は「今わかっている期待値」。rollback / promote を行った project は
      // 呼び出し側がその結果を渡す。**飛ばさない**（rollback 済みの project が
      // その後に動いた場合、`rolled-back` のまま古い deployment を案内してしまう）。
      const hasOverride = overrides.has(project.name);
      const expected = hasOverride
        ? overrides.get(project.name)
        : (observedLive.get(project.name)?.id ?? before.get(project.name)?.id ?? null);
      const live = await getLiveProduction({
        projectName: project.name,
        productionDomain: project.productionDomain,
        projectId: projectIds.get(project.name),
        token,
        teamId,
        fetchImpl,
      }).catch(() => undefined);
      if (live === undefined) continue; // 読めなかった
      const liveId = live?.id ?? null;
      if (liveId === expected) continue;

      // **baseline（run 開始時点の ID）へ戻っていたら、動きは無かったことにする。**
      // 待機中や gate 実行中に一時的に別 deployment へ動いた project が、この呼び出しの
      // 前に baseline へ戻っていた場合、`expected` は前回観測した「移動先」のままなので
      // ここまでは deviation として引っかかる。しかし戻り先は run 開始時点と同じであり、
      // 手順上は run 開始時点の deployment（skipped / already-serving）として扱ってよい。
      // 記録を残すと `deviated` に載って manifest が不要に `failed` へ倒れ、実際には
      // 解消済みの一時的な外部操作を `moved-externally` として案内してしまう。
      // override（この run が promote/rollback した project の期待値）がある場合は
      // 対象外にする ── そこでの baseline 一致は「本来の期待と違う」という実質的な
      // deviation（例: 我々の promote が外部に巻き戻された）であり、握り潰さない。
      if (!hasOverride && liveId === (before.get(project.name)?.id ?? null)) {
        observedLive.delete(project.name);
        continue;
      }

      // 期待と違う deployment を観測した。target を配信していても gate を通って
      // いなければ `uncertified`、別 SHA なら `moved-externally` に分類される。
      observedLive.set(project.name, { id: liveId, sha: live?.sha ?? null });
      deviated.push(project.name);
    }
    return deviated;
  };

  /**
   * この run の promote / rollback を踏まえた「今 live であるべき deployment」。
   * refresh の期待値に渡す。渡さないと、自分が promote した deployment を
   * 「外部が動かした」と誤って記録してしまう。
   */
  const expectedLiveIds = ({ promoted = [], rolledBack = [] } = {}) => {
    const rolledBackNames = new Set(rolledBack.map((entry) => entry.project.name));
    return new Map(
      promoted.map((entry) => [
        entry.project.name,
        rolledBackNames.has(entry.project.name)
          ? (entry.previous?.id ?? null)
          : entry.deployment.id,
      ]),
    );
  };

  const manifestFor = (status, { promoted = [], rolledBack = [] } = {}) =>
    buildManifest({
      sha,
      status,
      projects,
      decisions,
      before,
      promoted,
      rolledBack,
      observedLive,
      gatesPassed,
      impactAffected,
    });

  // 全 project の auto-assign を期待値へ戻す。外部の promote が待機中に設定を
  // 飛ばしている可能性があるため、失敗して抜けるどの経路でも最後に呼ぶ。
  // restoreAll は project 単位で失敗を握るので、この呼び出し自体は throw しない。
  const sweepSettings = () =>
    restoreAll({
      entries: projects.map((project) => ({
        project,
        projectId: projectIds.get(project.name),
        autoAssignCustomDomains: expectedFor(project.name),
      })),
      token,
      teamId,
      fetchImpl,
      logger,
    });

  // 掃きで復元に失敗した project は、元の失敗と別に名指しする。放置すると次の
  // merge が gate を迂回するのに、run の失敗理由には現れないため。
  const reportSweepDrift = (drifted) => {
    if (drifted.length === 0) return;
    const message =
      `autoAssignCustomDomains could not be restored for ${drifted.join(', ')}. ` +
      `Set it back before the next merge or the release gate is bypassed.`;
    logger.log(message);
    writeStepSummary(['', `> ${message}`]);
  };

  const alreadyServingNames = new Set(alreadyServing.map((project) => project.name));

  /**
   * **success を出す前に、判定の前提が今も成り立っているかを live 状態で確認する。**
   *
   * この run が置いた deployment だけを見ても足りない。release の success は
   * 「この commit が live」という主張で、tag gate（create-release.yml）がそれを信じる。
   * gate の実行中は数分あり、その間に人や Auto-assign が任意の project を動かせる。
   * project ごとに「何を期待するか」は判定の種類で決まる:
   *
   * - candidate を出した project … その deployment が live であること
   * - 既に target を配信していた project … 今も target SHA であること
   * - skip した project … 判定の基準にした SHA のままであること（変わっていれば
   *   「影響なし」の判定自体が別の基準で下されたことになり、陳腐化している）
   *
   * force でも実行する。Force Promote が免除するのは health / config の gate であって、
   * 「promote した SHA が今も live」という主張そのものではない。
   */
  const verifyLiveState = async (candidateEntries) => {
    const expectedId = new Map(
      candidateEntries.map(({ project, deployment }) => [project.name, deployment.id]),
    );

    for (const project of projects) {
      const live = await getLiveProduction({
        projectName: project.name,
        productionDomain: project.productionDomain,
        projectId: projectIds.get(project.name),
        token,
        teamId,
        fetchImpl,
      });

      // gate を通した時に「どの deployment を確認したか」を残す。認証は deployment
      // 単位で判断する（同じ commit の別 deployment は gate を通っていない）。
      verifiedIds.set(project.name, live?.id ?? null);

      const wanted = expectedId.get(project.name);
      if (wanted) {
        if (live?.id !== wanted) {
          // live が null（alias 未割当）も観測結果。落とすと manifest が
          // 「我々の candidate を配信中」のまま残る。
          observedLive.set(project.name, { id: live?.id ?? null, sha: live?.sha ?? null });
          throw new ReleaseError(
            `${project.name}: production serves ${live?.id ?? 'none'}, not the released ` +
              `${wanted}; refusing to report ${sha} as live`,
          );
        }
        continue;
      }

      // **deployment ID が run 開始時点から変わっていたら認証しない。**
      // 同じ commit の別 deployment でも build 時の設定は違いうるし、gate（smoke /
      // config audit）を一度も通っていない。`READY` と source SHA は gate が
      // 証明している内容ではないので、「SHA が同じなら受理」は認証の穴になる。
      const startId = before.get(project.name)?.id ?? null;
      if (live?.id !== startId) {
        observedLive.set(project.name, { id: live?.id ?? null, sha: live?.sha ?? null });
        throw new ReleaseError(
          `${project.name}: production moved to ${live?.id ?? 'no deployment'} after the gates ran; ` +
            `that deployment was never smoked or audited, so ${sha} is not certified`,
        );
      }

      // 基準 SHA が観測できていない project は affected へ倒っているのでここには来ない。
      const wantedSha = alreadyServingNames.has(project.name)
        ? sha
        : (before.get(project.name)?.sha ?? null);
      if (wantedSha && live?.sha !== wantedSha) {
        observedLive.set(project.name, { id: live?.id ?? null, sha: live?.sha ?? null });
        throw new ReleaseError(
          `${project.name}: production moved to ${live?.sha ?? 'an unknown commit'} while the ` +
            `gate was running; refusing to report ${sha} as live`,
        );
      }
    }
  };

  /**
   * **設定を掃いた後に live 状態を検証する。** この順序が要点で、逆にすると掃きが
   * 設定を直せてしまうために、検証後・掃き中に起きた promote が失敗として現れない。
   *
   * verify が不受理の移動を見つけたら throw する。**この関数は rollback で保護された
   * 領域の中から呼ぶ**こと（呼び出し側の catch が rollback と manifest を担う）。
   *
   * @returns 残っている drift（空でなければ設定復元が失敗している）
   */
  const stabilize = async (candidateEntries) => {
    let sweep = await sweepSettings();
    for (let attempt = 1; attempt <= STABILIZE_ATTEMPTS; attempt += 1) {
      // 検証を掃きの**後**に置く。逆順だと、掃きが設定を直せてしまうために、その間に
      // 起きた promote が失敗として現れない。
      await verifyLiveState(candidateEntries);

      // 検証の後にもう一度掃く。**同じ deployment を promote し直す操作は alias を
      // 動かさないので検証は通るが、auto-assign だけが飛ぶ。** 掃きが「直した」なら
      // その間に promote があったということなので、もう一周して検証し直す。
      sweep = await sweepSettings();
      if (sweep.restored.length === 0) return sweep.drifted;
      logger.log(
        `Auto-assign was re-enabled during verification; re-checking (attempt ${attempt}).`,
      );
    }
    // 回り切っても収束しない = 検証の後に必ず promote が起きている状態。最後の掃きの
    // 後を検証できていないので、success の根拠が無い。認証せず失敗させる。
    throw new ReleaseError(
      `Production kept changing while verifying ${sha}; refusing to certify it as live`,
    );
  };

  // **この関数のどの出口も、抜ける前に auto-assign を掃く。** 外部の promote は
  // 設定を true へ戻す（vercel/vercel#15095）。掃き忘れた出口が 1 つでもあると、
  // その run は正しく失敗したのに次の main merge が gate を通らず直接公開される。
  // 出口ごとに書くと必ず取り残しが出るため（実際 3 巡続けて別の出口が見つかった）、
  // 本体を包んで一括で掃く。restoreAll は差分がある時だけ PATCH するので、
  // 既に掃いた経路で重ねて呼んでも副作用は無い。
  //
  // finally ではなく catch + 後処理にしているのは、**最後の掃きで見つかった drift を
  // 失敗として扱う**ため。finally で throw すると実行中の例外を握り潰すので、
  // 失敗経路では報告だけに留め、成功経路でだけ settings-drift へ倒す。
  // 「この run が何を promote / rollback したか」。**wrapper の最終 cleanup も読む**ため
  // IIFE の外に置く。throw ごとに載せ直す方式だと、載せ忘れた経路で cleanup が自分の
  // promote を「外部が動かした」と誤認する（= 復旧手順が健全な deployment を戻す）。
  const promoted = [];
  let rolledBack = [];

  /**
   * **settings-drift で throw した時だけ、再試行に必要な文脈をここへ残す。**
   * wrapper の最終 catch は掃き直しただけで drift が解消したかを確認できるが、
   * 「production が正しい SHA を配信している」の再確認（alias 込み）には stabilize を
   * もう一度回す必要があり、そのために candidateEntries が要る。candidateEntries は
   * 内側の IIFE のローカル変数（例: `candidates`）なので、ここに退避しないと wrapper の
   * catch から参照できない。settings-drift 以外の throw では設定しない ── wrapper 側は
   * これが null かどうかで「取り下げてよい失敗か」を判定する（smoke / audit / live
   * 検証由来の失敗を誤って取り下げないための fail-closed 条件）。
   */
  let driftRecovery = null;

  const result = await (async () => {
    // 再配備は「live と同じ commit を、別の deployment で出し直す」操作に限る。live が
    // 別の commit なら通常の dispatch で足りる（影響判定が candidate 選択まで届く）ので、
    // ID 固定の口を広げない。ここまでは読み取りだけで、production は未変更。
    if (redeployPending && redeployLive?.sha !== sha) {
      throw Object.assign(
        new ReleaseError(
          `Refusing to redeploy ${redeploy.deploymentId}: ${redeploy.projectName} serves ` +
            `${short(redeployLive?.sha)}, not ${short(sha)}. A redeploy only replaces a ` +
            `deployment of the same commit. Production was left untouched; dispatch without ` +
            `the redeploy input to release ${short(sha)}.`,
        ),
        { manifest: manifestFor('failed') },
      );
    }

    // ── 層 3 未実行の promote を拒む（#2574）─────────────────────────────
    //
    // impact job（T0）と この script（T1）は **別時刻の live production SHA** を基準に
    // 独立して影響判定を行う。live が前進するだけなら `diff(base_T1..Y) ⊆ diff(base_T0..Y)`
    // なので T1 の affected 集合は T0 の subset になり安全側だが、**Instant Rollback で
    // live が後退すると T1 だけが affected になる**:
    //
    //   1. live: product = L / web = L
    //   2. merge Y は apps/web だけ変更 → impact（基準 L）は product unaffected → e2e skip
    //   3. web job の実行中（最大 20 分）に product を R（L より古い）へ Instant Rollback
    //   4. release（基準 R）は R..Y に product 変更を見て affected → E2E 未実行のまま promote
    //
    // release job の gate 式は `needs.impact.outputs.product_affected == 'false'` で層 3 を
    // 免除するため workflow 側では止まらない。そこで「promote 対象 ⊆ impact が affected と
    // 言った project」をここで強制する。
    //
    // **判定は `targets`（= decisions）で行う。`pending` で行ってはいけない** ——
    // 外部 actor や Auto-assign が先に candidate を live にすると pending から消えるため、
    // 未検証のまま stabilize を通って success になり、層 3 未実行の build へ tag gate 用の
    // status を出してしまう。
    const unverified = force
      ? // break-glass は層 3 job 自体を skip する（promote.yml の e2e / web job の `if:`）。
        // 検査を効かせると、impact job が壊れている時の最後の手段が使えなくなる。
        []
      : targets.filter((project) => impactAffected[project.name] !== true);
    if (unverified.length > 0) {
      const detail = unverified
        .map((project) => {
          const verdict = impactAffected[project.name];
          const reported = verdict === false ? 'unaffected' : 'nothing';
          return (
            `${project.name}: the impact job reported ${reported}, so layer 3 never ran for it, ` +
            `but this run resolved it as affected against live ` +
            `${short(before.get(project.name)?.sha)} (${decisions.get(project.name).reason})`
          );
        })
        .join('; ');
      // ここまでで production は 1 件も触っていない（`before` の読み取りだけ）。
      // wrapper の catch が sweepSettings() と manifest 出力を行うので、IIFE の内側で投げる。
      throw Object.assign(
        new ReleaseError(
          `Refusing to promote ${sha}: ${unverified.map((project) => project.name).join(', ')} ` +
            `would go out without layer 3. Production was left untouched. Re-run the WHOLE ` +
            `workflow once production has settled (\`gh workflow run promote.yml --ref main\`, ` +
            `or "Re-run all jobs") so the impact job re-baselines against the current live ` +
            `deployment. Do NOT use "Re-run failed jobs": it reuses the impact job's existing ` +
            `outputs, so the stale verdict comes straight back and this fails again. (${detail})`,
        ),
        { manifest: manifestFor('impact-mismatch') },
      );
    }

    // 前回 run が中断して片側だけ公開された状態。既に配信中の側は戻し先を持たないので
    // 自動 rollback の対象にはできない。せめて名指しして人が判断できるようにする。
    // promote する予定が無い run には rollback scope 自体が無いので警告しない。
    const preexistingSplit =
      alreadyServing.length > 0 && targets.length > 0
        ? alreadyServing.map((project) => project.name)
        : [];
    if (preexistingSplit.length > 0) {
      const message =
        `Pre-existing split: ${preexistingSplit.join(', ')} already serve ${sha} from an earlier run. ` +
        `They are outside this run's rollback scope; check them by hand if this run fails.`;
      logger.log(message);
      writeStepSummary(['', `> ${message}`]);
    }

    if (targets.length === 0) {
      const status = alreadyServing.length === projects.length ? 'already-released' : 'unaffected';
      logger.log(
        status === 'already-released'
          ? `All projects already serve ${sha}; nothing to promote.`
          : `No project is affected by ${sha}; nothing to promote.`,
      );
      // 前回 run が復元に失敗して終わっている可能性があるため、設定だけは見に行く。
      // **ここでは失敗にしない。** 一時的な失敗なら stabilize の掃きで直る。判定を
      // 最初の観測で確定させると、既に直っている状態で tag を打てなくする。
      const { drifted } = await sweepSettings();
      if (drifted.length > 0) {
        logger.log(`Initial restore failed for ${drifted.join(', ')}; stabilization decides.`);
      }

      // **promote が 0 件でも、この run が success を出せば「その build は live」として
      // tag gate を通る**（create-release.yml）。既に target を配信している project は
      // Auto-assign や中断した run が gate を通さずに live にした可能性があるため、
      // 認証する前に実際の production domain を見る。ここを素通りさせると、
      // smoke も audit も一度も通っていない build に tag を打ててしまう。
      //
      // gate の実行中に外部の promote が起きると auto-assign が再び true へ戻る。
      // 上の復元は gate より前なので、**抜ける経路すべてで掃き直す**（finally）。
      // 掃き忘れると次の main merge が gate を迂回して直接公開される。
      try {
        if (!force && alreadyServing.length > 0) {
          // **smoke は alreadyServing だけでなく全 project の domain へ。** 通常経路と
          // 同じ範囲にする。片側だけ見て success を出すと、健全でない skip 側の domain や
          // cross-app の組み合わせ破損を認証したまま tag を打てる。
          for (const project of projects) {
            assertSimulationPoint(simulateFailure, `production-smoke:${project.name}`);
            await smokeDeployment({
              projectName: `${project.name} production`,
              deploymentUrl: project.productionDomain,
              checks: project.smokeChecks,
              fetchImpl,
              sleepImpl,
              logger,
            });
          }
          // checkProjectSettings: false — project 設定監査（rootDirectory /
          // autoAssignCustomDomains 等、#1817 Phase 4）は release 中の一時的な状態
          // （外部 promote による auto-assign 復帰）と衝突する。release の gate は
          // 従来どおり env metadata のみを見る（scripts/ci/production-config-audit.mjs
          // の runProductionConfigAudit 冒頭コメント参照）。
          await runProductionConfigAudit({ token, teamId, fetchImpl, checkProjectSettings: false });
          logger.log('Production Config Audit passed against live Vercel metadata.');
        }

        // promote していなくても「この commit が live」を主張する以上、前提を確認する。
        // 掃きと検証は安定するまで交互に回す（§stabilize）。
        const residual = await stabilize([]);
        // ここまで来れば smoke / audit / live 検証を通っている。設定復元が失敗しても
        // 「認証された」事実は変わらないので、drift 判定より前に記録する。
        for (const [name, id] of verifiedIds) gatesPassed.set(name, id);
        if (residual.length > 0) {
          // wrapper の catch がここでの掃きを解決できた場合に再現できるよう、
          // 取り下げ判定に要る文脈を残す（§driftRecovery）。
          driftRecovery = {
            status,
            candidateEntries: [],
            preexistingSplit,
            gateChecksRan: !force && alreadyServing.length > 0,
          };
          throw Object.assign(driftError(sha, residual), {
            manifest: manifestFor('settings-drift'),
          });
        }
      } catch (error) {
        reportSweepDrift((await sweepSettings()).drifted);
        // refresh の結果は manifest へ必ず反映する。既に付いている manifest
        // （settings-drift 等）をそのまま返すと、cleanup 中に alias が動いた事実が
        // 落ちる。settings-drift は「production は正しい」を意味するので、動いていたら
        // その主張自体が成り立たない → `failed` へ落とす。
        if (!error.manifest || (await refreshObservedLive()).length > 0) {
          Object.assign(error, { manifest: manifestFor('failed') });
        }
        throw error;
      }

      return {
        status,
        sha,
        promoted: [],
        rolledBack: [],
        preexistingSplit,
        gateChecksRan: !force && alreadyServing.length > 0,
        manifest: manifestFor(status),
      };
    }

    const candidates = await waitForReadyCandidates({
      projects: targets,
      sha,
      token,
      teamId,
      fetchImpl,
      sleepImpl,
      nowImpl,
      logger,
      pinned: redeployPending
        ? new Map([
            [
              redeploy.projectName,
              {
                deploymentId: redeploy.deploymentId,
                projectId: projectIds.get(redeploy.projectName),
                liveCreatedAt: redeployLive?.createdAt ?? null,
              },
            ],
          ])
        : new Map(),
    }).catch(async (error) => {
      // 片方が READY で自動割当された一方、もう片方が timeout / ERROR というケース。
      // run 開始時点の snapshot だけで manifest を作ると、live になった候補が
      // `pending` として載り、runbook が「production は無傷」と案内する。
      await refreshObservedLive();
      throw Object.assign(error, { manifest: manifestFor('failed') });
    });

    // 待機は最大 25 分ブロックする。その間に人が Instant Rollback や手動 promote を
    // 行いうるため、判定は待機後の実状態で行う。unaffected な project は promote 対象で
    // ないので読み直さない（この run が動かさない先の状態は before で足りる）。
    const current = new Map();
    // **1 project ごとに分類まで終える。** 後続 project の API が失敗した時、
    // 先に観測した分が manifest へ入らないまま失敗すると、live な candidate が
    // `pending` として載る（= runbook が「production は無傷」と案内する）。
    const classifyCurrent = (project) => {
      const candidate = candidates.find((c) => c.project.name === project.name);
      if (!candidate) return;
      if (current.get(project.name)?.id === candidate.deployment.id) {
        observedLive.set(project.name, { id: candidate.deployment.id, sha });
      }
    };
    for (const project of targets) {
      // 25 分待った後の失敗。ここで manifest を付けずに抜けると、artifact が
      // 1 つも残らない（run 開始時点の状態すら読めなくなる）。
      const state = await getLiveProduction({
        projectName: project.name,
        productionDomain: project.productionDomain,
        projectId: projectIds.get(project.name),
        token,
        teamId,
        fetchImpl,
      }).catch((error) => {
        throw Object.assign(error, { manifest: manifestFor('failed') });
      });
      current.set(project.name, state);
      // 待機中に Auto-assign や人が candidate を live にした分をここで拾う。promote loop の
      // 記録だけに頼ると、この後の `pending` filter で除外されて loop に届かない。
      classifyCurrent(project);
    }

    const movedElsewhere = candidates.filter(({ project, deployment }) => {
      // **未割当（alias 無し）は `null` に正規化して比べる。** `now?.id` は undefined を
      // 返すため、run 開始時点から未割当のままの domain が「外部が動かした」と判定され、
      // READY な candidate を promote せずに抜けてしまう（domain は無配信のまま）。
      const nowId = current.get(project.name)?.id ?? null;
      const wasId = before.get(project.name)?.id ?? null;
      // 同じ candidate を人が先に promote した場合は競合ではない。
      return nowId !== wasId && nowId !== deployment.id;
    });
    if (movedElsewhere.length > 0) {
      const detail = movedElsewhere
        .map(({ project, deployment }) => {
          const now = current.get(project.name);
          return (
            `${project.name}: was ${before.get(project.name)?.id ?? 'none'}, ` +
            `now ${now?.id ?? 'none'}, candidate ${deployment.id}`
          );
        })
        .join('; ');

      // 観測した実 deployment を manifest へ載せる。run 開始時点の値のままだと
      // 「未着手（pending）」に見え、復旧手順が実際の live を取り違える。
      for (const { project } of movedElsewhere) {
        const now = current.get(project.name);
        // now が null（alias 未割当）も観測結果。落とすと manifest が run 開始時点の
        // deployment を「未着手」として残す。
        observedLive.set(project.name, { id: now?.id ?? null, sha: now?.sha ?? null });
      }

      // skip した project の alias が待機中に動いていても、ここまで誰も読み直して
      // いない（待機後の再取得は targets だけ）。manifest を作る前に揃える。
      await refreshObservedLive();

      // 外部の promote は auto-assign を true へ戻す（vercel/vercel#15095）。
      // ここで掃かずに抜けると、次の main merge が gate を通らず直接公開される。
      reportSweepDrift((await sweepSettings()).drifted);

      throw Object.assign(
        new ReleaseError(
          `Production moved while waiting for candidates; refusing to promote over it (${detail})`,
        ),
        { manifest: manifestFor('failed') },
      );
    }

    // 以降の判定はすべて待機後の実状態を使う。movedElsewhere を抜けている時点で
    // current は before か candidate のどちらかに一致している。
    // **supersession は deployment の作成時刻では決まらない。** 古い SHA を後から
    // 再 build すると candidate の方が新しく見えるが、内容は live より古い。
    // `workflow_dispatch` は main に含まれる古い SHA を明示的に受け付けるので、
    // 時刻で判定すると **新しい app 変更を古い commit で上書きできてしまう**。
    // commit の祖先関係で判定し、判定不能（divergent / 履歴が読めない / live の SHA が
    // 不明）は promote しない側へ倒す。
    const superseded = candidates.filter(({ project }) => {
      const live = current.get(project.name);
      if (live === null) return false; // 何も配信していない。downgrade にならない
      if (live.sha === sha) return false; // 同じ commit
      // target が live の祖先 = live の方が新しい内容を配信している。
      const targetIsAncestor = live.sha ? isAncestorImpl(sha, live.sha) : null;
      if (targetIsAncestor === true) return true;
      // live が target の祖先 = target の方が新しい。promote してよい。
      const liveIsAncestor = live.sha ? isAncestorImpl(live.sha, sha) : null;
      return liveIsAncestor !== true;
    });
    if (superseded.length > 0) {
      const names = superseded.map(({ project }) => project.name).join(', ');
      logger.log(
        `Skipping promote: production already serves ${names} from a commit that is not an ancestor of ${sha}.`,
      );
      // skip した project の alias が待機中に動いていても、ここまで誰も読み直して
      // いない（待機後の再取得は targets だけ）。manifest を作る前に揃える。
      await refreshObservedLive();
      // 外部の promote が auto-assign を戻している可能性があるため、抜ける前に掃く。
      // **drift があっても superseded のままにする。** ここは「より新しい deployment が
      // live」と証明した経路で、settings-drift（= 正しい SHA が live）へ塗り替えると
      // 復旧手順が矛盾する。設定の問題は報告として別に出す。
      reportSweepDrift((await sweepSettings()).drifted);
      return {
        status: 'superseded',
        sha,
        promoted: [],
        rolledBack: [],
        preexistingSplit,
        manifest: manifestFor('superseded'),
      };
    }

    // 既に production へ出ている build は公開済みなので、gate の対象から外す。
    // 待機中に人が同じ candidate を promote していた場合もここで除外される。
    const pending = candidates.filter(
      ({ project, deployment }) => current.get(project.name)?.id !== deployment.id,
    );

    if (force) {
      logger.log('Force Promote: skipping smoke and Production Config Audit.');
    } else {
      // smoke は promote 対象（pending）ではなく全 candidate に対して走らせる。
      // Auto-assign が有効な段階適用中は candidate が待機中に自動割当されて
      // pending が空になるため、pending だけを対象にすると smoke のコードパスが
      // 一度も実行されないまま cutover を迎えてしまう。全 candidate に走らせる
      // ことで、毎 merge が smoke と bypass secret の実働テストを兼ねる。
      try {
        for (const { project, deployment } of candidates) {
          assertSimulationPoint(simulateFailure, `smoke:${project.name}`);
          await smokeDeployment({
            projectName: project.name,
            deploymentUrl: deployment.url,
            checks: project.smokeChecks,
            bypassSecret: bypassSecrets[project.name],
            fetchImpl,
            sleepImpl,
            logger,
          });
        }

        // checkProjectSettings: false — 上の already-serving 分岐と同じ理由。
        await runProductionConfigAudit({ token, teamId, fetchImpl, checkProjectSettings: false });
        logger.log('Production Config Audit passed against live Vercel metadata.');
      } catch (error) {
        // 外部の promote が待機中に auto-assign を飛ばしていた場合、ここで抜けると
        // 誰も設定を戻さない。掃いてから失敗させる。
        reportSweepDrift((await sweepSettings()).drifted);
        await refreshObservedLive();
        throw Object.assign(error, { manifest: manifestFor('failed') });
      }
    }

    const driftedProjects = [];
    /** stabilize が最後に観測した設定 drift。空でなければ run を失敗させる。 */
    let residualDrift = [];
    try {
      for (const { project, deployment } of pending) {
        assertSimulationPoint(simulateFailure, `promote:${project.name}`);

        // smoke と audit で数分経っている。その間に人が Instant Rollback や手動
        // promote を行いうるので、rollback 先は promote の直前に取り直す。
        const live = await getLiveProduction({
          projectName: project.name,
          productionDomain: project.productionDomain,
          projectId: projectIds.get(project.name),
          token,
          teamId,
          fetchImpl,
        });

        if (live?.id === deployment.id) {
          logger.log(`${project.name}: another actor already promoted ${deployment.id}; skipping`);
          // gate をこの後通せなければ manifest は `uncertified` になる（gatesPassed に
          // 入らないため）。復旧先は run 開始時点の deployment。
          // この run は動かしていないが live ではある。manifest で「未着手」に見えないよう
          // 記録する（rollback 対象には入れない。戻し先を観測していないため）。
          observedLive.set(project.name, { id: deployment.id, sha });
          continue;
        }

        if (live?.id !== current.get(project.name)?.id) {
          // 観測した実 deployment を manifest へ載せてから抜ける。run 開始時点の値の
          // ままだと「未着手（pending）」に見え、復旧手順が live を取り違える。
          // live が null（alias 未割当）も観測結果なので落とさない。
          observedLive.set(project.name, { id: live?.id ?? null, sha: live?.sha ?? null });
          throw new ReleaseError(
            `${project.name}: production moved to ${live?.id ?? 'none'} while the gate was ` +
              `running; refusing to promote ${deployment.id} over it`,
          );
        }

        const entry = {
          project,
          projectId: projectIds.get(project.name),
          autoAssignCustomDomains: expectedFor(project.name),
          deployment,
          previous: live,
        };
        logger.log(
          `${project.name}: promoting ${deployment.id} over ${entry.previous?.id ?? 'none'}`,
        );

        try {
          await requestProductionPointer({
            projectName: project.name,
            projectId: entry.projectId,
            deploymentId: deployment.id,
            token,
            teamId,
            fetchImpl,
            action: 'promote',
          });
        } catch (error) {
          // **POST が届いたかどうか分からない状態は「何も起きていない」ではない。**
          // response を失っただけで Vercel 側は受理しているかもしれず、alias が
          // まだ前の deployment を返すのは反映待ちとも区別がつかない（読み取り自体が
          // 失敗することもある）。ここで rollback 対象から外すと、この run が終わった
          // 後に target が live になり、戻す先を誰も知らないまま片側公開が残る。
          //
          // 迷ったら rollback 対象に入れる。何も起きていなかった場合の代償は
          // 「previous を previous へ promote する空振り」だけで、auto-assign は
          // rollback 側の復元と関数末尾の掃きが戻す。rollbackPromoted は実行前に
          // live を読み直し、第三の deployment が居れば触らない。
          // ただし 4xx は「受理されなかった」が確定する。ここで rollback 対象に入れると
          // 何も起きていない production へ 2 度目の mutation を撃ち、同じ理由でそれも
          // 失敗して「手動 rollback が要る」と誤報することになる。
          if (DEFINITIVE_REJECTIONS.has(error?.status)) {
            logger.log(`${project.name}: promote was rejected (${error.status}); nothing to undo`);
            throw error;
          }
          logger.log(
            `${project.name}: promote request outcome is unknown; keeping it in the rollback scope`,
          );
          // rollback 側で「戻った」と即断させないための印。previous は一度も live を
          // 外れていない可能性があり、その場合 assignment の確認が即座に通ってしまう。
          promoted.push({ ...entry, ambiguous: true });
          throw error;
        }

        // POST が受理された時点で production は動きうる。反映確認が timeout しても
        // rollback 対象から漏らさないよう、確認を待つ前に記録する。
        promoted.push(entry);

        await waitForProductionAssignment({
          projectName: project.name,
          productionDomain: project.productionDomain,
          projectId: projectIds.get(project.name),
          deploymentId: deployment.id,
          token,
          teamId,
          fetchImpl,
          sleepImpl,
          nowImpl,
          action: 'promote',
        }).catch((error) => {
          // **POST は受理されたのに反映が確認できない = 遅れて着地しうる。**
          // transport 失敗の経路と同じ扱いにしないと、rollback 側が「previous のまま
          // だから戻った」と即断し、その後に着地した candidate が gate を通らないまま
          // live になる。`promoted` に入れた entry を書き換える（同一参照）。
          entry.ambiguous = true;
          throw error;
        });

        // promote は auto-assign を true に戻す。次の project の確認を待つ間ずっと
        // 片側だけ auto-assign が有効な窓を作らないよう、ここで即座に戻す。
        // 復元の失敗は rollback を誘発させず、drifted に積んで最後に報告する。
        driftedProjects.push(
          ...(await restoreAll({ entries: [entry], token, teamId, fetchImpl, logger })).drifted,
        );
        logger.log(`${project.name}: promoted ${deployment.id}`);
      }

      // promote 後の production domain smoke。candidate smoke は各 deployment を単体で
      // 見るが、affected な側だけを進めた production は **その組み合わせが初めて世に出る
      // 状態**なので、実際に配信している両 domain を最後に確認する。
      //
      // 検出できるのは smokeChecks に載っている経路だけ。cross-app のリンク切れ一般は
      // 見ない。web から product への唯一の入口である signup CTA は product の check に
      // 入れてあるので、その 1 本だけが「片側 promote で web の導線が落ちる」を捕まえる。
      // bypass secret は送らない。production domain に Deployment Protection が付く
      // 設定事故（利用者に SSO 画面が出る）を、この smoke で捕まえたいため。
      //
      // 条件は promote 件数ではなく targets。Auto-assign が有効な段階適用中は candidate が
      // 待機中に自動割当されて promote 件数が 0 になるため、promote 件数で分岐すると
      // cutover までこの smoke が一度も走らない（candidate smoke と同じ理由）。
      //
      // **promote していない側の失敗でも rollback する**（catch へ落ちる）。この smoke が
      // 守りたいのは「product を進めたら web が壊れた」型の cross-app 破損で、そこでは
      // rollback が唯一の復旧手段になる。代償として、無関係な既存障害が正常な promote を
      // 巻き戻しうるが、production は数分前の既知状態へ戻るだけで、run は失敗として残る。
      // 「壊れたまま success で終える」より安全な側へ倒す。
      if (!force && targets.length > 0) {
        for (const project of projects) {
          assertSimulationPoint(simulateFailure, `production-smoke:${project.name}`);
          await smokeDeployment({
            projectName: `${project.name} production`,
            deploymentUrl: project.productionDomain,
            checks: project.smokeChecks,
            fetchImpl,
            sleepImpl,
            logger,
          });
        }
      }

      // smoke は「domain が健全か」しか見ず、**どの deployment が応答したかは見ない**。
      // 全 project について「判定の前提が今も成り立つか」を確認する（§verifyLiveState）。
      // force でも実行する。Force Promote が免除するのは health / config の gate であって、
      // 「promote した SHA が今も live」という主張そのものではない。
      //
      // 掃きと検証は安定するまで交互に回す。**rollback 保護の内側**で行うので、ここで
      // 不受理の移動を見つけた場合はこの run が promote した分が巻き戻る。
      residualDrift = await stabilize(candidates);
      // gate を通した事実を記録する（status ではなく実績で manifest を分類するため）。
      for (const [name, id] of verifiedIds) gatesPassed.set(name, id);
    } catch (error) {
      // promote 済みの側を戻す。対象は **この run が promote した project だけ**で、
      // 前から target を配信していた側（preexistingSplit）には戻し先が無い。
      let failure = error;
      try {
        rolledBack = await rollbackPromoted({
          promoted,
          token,
          teamId,
          fetchImpl,
          sleepImpl,
          nowImpl,
          logger,
          cause: error,
          preexistingSplit,
          preexistingDrift: driftedProjects,
        });
      } catch (rollbackError) {
        // 手動 rollback の指示を持つ方を投げる。元の失敗理由は cause として本文に入る。
        failure = rollbackError;
        // 一部だけ戻して throw した場合、戻せた分はエラー側にしか残らない。
        rolledBack = rollbackError.rolledBack ?? [];
        for (const { entry, live } of rollbackError.observedLive ??
          rollbackError.movedExternally ??
          []) {
          observedLive.set(entry.project.name, { id: live.id ?? null, sha: live.sha ?? null });
        }
      } finally {
        // rollback の成否に関わらず、promote しなかった project の設定も掃く。
        reportSweepDrift((await sweepSettings()).drifted);
      }
      // rollback は promote した project しか読み直さない。それ以外の live が
      // 動いていた場合も manifest へ反映してから失敗させる。
      // rollback 済みは previous、戻せず残った分は candidate が期待値。
      await refreshObservedLive({ expected: expectedLiveIds({ promoted, rolledBack }) });
      throw Object.assign(failure, {
        manifest: manifestFor('failed', { promoted, rolledBack }),
      });
    }

    // promote しなかった project も掃く。pending から除外された側や、外部の promote で
    // skip した側も、その promote の副作用で設定が飛んでいることがある。
    // ループ内の復元は「窓を作らない」ため、この掃きは「取りこぼさない」ためにある。
    //
    // **判定はこの最新の掃きだけで行う。** ループ内の復元が一時的に失敗しても、ここで
    // 復元できていれば設定は正しい。過去の失敗を積み上げると、既に直っている状態で
    // release を止めて tag を打てなくする。
    if (driftedProjects.length > 0) {
      logger.log(
        `Earlier restore attempts failed for ${driftedProjects.join(', ')}; the final sweep decides.`,
      );
    }

    // production は正しい SHA を配信している。設定復元の失敗で巻き戻す理由はないが、
    // 放置すると次の merge が gate を迂回するため run は失敗させる。
    if (residualDrift.length > 0) {
      // production は正しい SHA を配信している。失敗の理由は設定の復元だけなので、
      // manifest の status を分ける。'failed' のままだと runbook の「失敗した run の
      // promoted は戻す」に従って、健全な deployment が不要に巻き戻される。
      // wrapper の catch がここでの掃きを解決できた場合に再現できるよう、
      // 取り下げ判定に要る文脈を残す（§driftRecovery）。rollback は起きていない経路
      // なのでここに来る時点で rolledBack は常に空。
      driftRecovery = {
        status: 'promoted',
        candidateEntries: candidates,
        preexistingSplit,
        gateChecksRan: !force,
      };
      throw Object.assign(driftError(sha, residualDrift), {
        manifest: manifestFor('settings-drift', { promoted }),
      });
    }

    return {
      status: 'promoted',
      sha,
      promoted,
      rolledBack: [],
      preexistingSplit,
      gateChecksRan: !force,
      manifest: manifestFor('promoted', { promoted }),
    };
  })().catch(async (error) => {
    // **settings-drift は取り下げ得る唯一の失敗種別。** driftRecovery は settings-drift の
    // throw 元（§driftRecovery）だけが設定するので、これが null なら smoke / audit /
    // live 検証由来の失敗であり対象外（fail closed）。manifest.status も同時に確認する
    // ── 途中の local catch が観測した外部 drift で既に 'failed' へ塗り替えていれば、
    // 「production は正しい」の前提自体が崩れているのでここでも取り下げない。
    if (driftRecovery && error.manifest?.status === 'settings-drift') {
      const recovery = driftRecovery;
      try {
        // stabilize は掃き→検証→掃きを安定するまで繰り返す（§stabilize）。ここで
        // もう一度回すのは、alias の再検証を伴わない「掃くだけ」では、その間に production
        // が動いていないことを保証できないため。
        const residual = await stabilize(recovery.candidateEntries);
        // gate（live 検証）を通した事実を記録する。
        for (const [name, id] of verifiedIds) gatesPassed.set(name, id);

        if (residual.length === 0) {
          // 掃きが直り、live 検証も通った。production は正しい SHA を配信しており
          // 設定復元も完了しているので、settings-drift の失敗を取り下げる。
          logger.log(
            `Settings drift resolved on retry; withdrawing the settings-drift failure for ${sha}.`,
          );
          return {
            status: recovery.status,
            sha,
            promoted,
            rolledBack,
            preexistingSplit: recovery.preexistingSplit,
            gateChecksRan: recovery.gateChecksRan,
            manifest: manifestFor(recovery.status, { promoted, rolledBack }),
          };
        }

        // まだ drift が残る。production は正しいままなので 'settings-drift' で失敗させる
        // （'failed' にすると runbook の「失敗した run の promoted は戻す」で健全な
        // deployment が不要に巻き戻される）。
        throw Object.assign(driftError(sha, residual), {
          manifest: manifestFor('settings-drift', { promoted, rolledBack }),
        });
      } catch (retryError) {
        // stabilize 自体が失敗した（live 状態の再検証に失敗した）場合と、drift が
        // 残ったまま上で throw した場合の両方をここで受ける。
        reportSweepDrift((await sweepSettings()).drifted);
        const deviated = await refreshObservedLive({
          expected: expectedLiveIds({ promoted, rolledBack }),
        });
        if (!retryError.manifest || deviated.length > 0) {
          // live 検証自体が失敗した、またはその間にも production が動いていた場合は
          // 「production は正しい」が成り立たないので 'failed' へ倒す。
          Object.assign(retryError, { manifest: manifestFor('failed', { promoted, rolledBack }) });
        }
        throw retryError;
      }
    }

    // 失敗経路。元の失敗理由を優先し、掃きの結果は報告だけにする。
    reportSweepDrift((await sweepSettings()).drifted);

    // **この掃きの間にも alias は動きうる。** manifest は内側の経路で既に作られている
    // ので、ここで読み直して作り直さないと、掃き中に promote された hotfix を
    // 「この run の candidate」として案内してしまう（= 復旧手順が上書きを促す）。
    const deviated = await refreshObservedLive({
      expected: expectedLiveIds({ promoted, rolledBack }),
    });
    if (!error.manifest || deviated.length > 0) {
      // 動いていたなら settings-drift の「production は正しい」も成り立たない。
      Object.assign(error, { manifest: manifestFor('failed', { promoted, rolledBack }) });
    }
    throw error;
  });

  // 成功経路。ここまでの掃きの後に外部 promote が設定を戻していることがあるため、
  // もう一度掃いて、それでも残る drift は run の失敗にする（放置すると次の merge が
  // gate を迂回する）。production は正しい SHA を配信しているので deployment は戻さない。
  // 成功経路でここに追加の掃きを置かない。**掃きの後に検証が無い構造を作らないため**
  // （掃きは設定を直せてしまうので、その間に起きた promote が失敗として現れない）。
  // 各 return 経路は stabilize（掃き + 検証を交互）か、superseded 側の明示的な掃きで
  // 既に完了している。
  return result;
}

async function rollbackPromoted({
  promoted,
  token,
  teamId,
  fetchImpl,
  sleepImpl,
  nowImpl,
  logger,
  cause,
  preexistingSplit = [],
  preexistingDrift = [],
}) {
  const rolledBack = [];
  const stranded = [];
  const movedExternally = [];
  /** 分類に関わらず「この run が置いたものでない live」を観測した記録。manifest 用。 */
  const observedLive = [];
  const drifted = [...preexistingDrift];

  /**
   * 猶予いっぱい alias を観測し、最後に読めた状態を返す。
   *
   * promote も rollback も同じ非同期 endpoint を使うので、「受理されたが反映が
   * 確認できない」状態では**どちらの操作も後から着地しうる**。途中の観測で分類すると
   * 誤った手動操作を促すため、窓の最後の状態だけで判断する。
   */
  const observeUntilSettled = async (entry) => {
    const deadline = nowImpl() + AMBIGUOUS_SETTLE_MS;
    let last;
    let observed = false;
    while (nowImpl() < deadline) {
      await sleepImpl(ASSIGN_POLL_MS);
      let settled;
      try {
        settled = await getLiveProduction({
          projectName: entry.project.name,
          productionDomain: entry.project.productionDomain,
          projectId: entry.projectId,
          token,
          teamId,
          fetchImpl,
        });
      } catch {
        continue; // 読めない回で判断しない。窓の残りで見直す
      }
      observed = true;
      last = settled ?? { id: null, sha: null };
    }
    return { observed, last };
  };

  /**
   * **受理が不確かな promote は 1 本の経路で扱う。**
   *
   * 分岐ごとに着地待ちを足すと必ず適用漏れが出る（実際 6 巡続けて別の経路が
   * 見つかった）。ここでは「戻せるなら POST を撃つ → いずれの場合も窓を見届ける →
   * 最終状態だけで分類する」に統一する。
   *
   * POST を撃たないのは、他者の deployment が domain を握っている時だけ（撃つと
   * それを上書きする）。窓は必ず見る — 受理済みの promote は後から着地しうるので、
   * 見届けないと gate 未通過の deployment が live になったことを誰も知らない。
   */
  const settleAmbiguous = async (entry) => {
    const initial = await getLiveProduction({
      projectName: entry.project.name,
      productionDomain: entry.project.productionDomain,
      projectId: entry.projectId,
      token,
      teamId,
      fetchImpl,
    }).catch(() => undefined);

    // 戻し先があり、domain を握っているのが我々の candidate か previous なら戻しに行く。
    const initialId = initial === undefined ? undefined : (initial?.id ?? null);
    const holdsOurs =
      initialId !== undefined &&
      (initialId === entry.deployment.id || initialId === entry.previous?.id);
    if (entry.previous?.id && holdsOurs) {
      try {
        const { autoAssignDrifted } = await rollbackDeployment({
          projectName: entry.project.name,
          productionDomain: entry.project.productionDomain,
          projectId: entry.projectId,
          autoAssignCustomDomains: entry.autoAssignCustomDomains,
          logger,
          deploymentId: entry.previous.id,
          token,
          teamId,
          fetchImpl,
          sleepImpl,
          nowImpl,
        });
        if (autoAssignDrifted) drifted.push(entry.project.name);
      } catch {
        // 反映確認の成否はここでは問わない。判断は窓の最終状態に委ねる。
      }
    }

    const { observed, last } = await observeUntilSettled(entry);
    const target = entry.previous?.id ?? null;

    if (!observed) {
      stranded.push(
        `${entry.project.name}${target ? ` -> ${target}` : ''} (live state unreadable throughout the settle window)`,
      );
      return;
    }

    const finalState = last ?? { id: null, sha: null };

    if (target && finalState.id === target) {
      logger.log(`${entry.project.name}: rolled back to ${target} (settled)`);
      rolledBack.push(entry);
      return;
    }

    if (finalState.id === entry.deployment.id) {
      // 我々の candidate が live。**observedLive へは入れない** — manifest で
      // `moved-externally`（= 戻すな）になると、同じ run のエラーと矛盾する。
      stranded.push(
        target
          ? `${entry.project.name} -> ${target} (a delayed promote landed on ${finalState.id})`
          : `${entry.project.name} (no previous deployment; ${finalState.id} is live and ungated)`,
      );
      return;
    }

    // 第三の deployment / 未割当。戻すと他者の選択を上書きするので触らない。
    movedExternally.push({ entry, live: finalState });
    observedLive.push({ entry, live: finalState });
    logger.log(
      `${entry.project.name}: production settled on ${finalState.id ?? 'no deployment'}; leaving it alone`,
    );
  };

  for (const entry of [...promoted].reverse()) {
    if (entry.ambiguous) {
      await settleAmbiguous(entry);
      continue;
    }

    if (!entry.previous?.id) {
      stranded.push(`${entry.project.name} (no previous production deployment recorded)`);
      continue;
    }

    // **読めなかった時は触らない。** 失敗を「競合なし」と同一視すると、まさに守ろうと
    // している hotfix を上書きしうる。production を変更するより、人の確認へ回す。
    let live;
    try {
      live = await getLiveProduction({
        projectName: entry.project.name,
        productionDomain: entry.project.productionDomain,
        projectId: entry.projectId,
        token,
        teamId,
        fetchImpl,
      });
    } catch {
      stranded.push(`${entry.project.name} -> ${entry.previous.id} (live deployment unreadable)`);
      continue;
    }

    // **alias 未割当（live=null）も「他者が意図的に外した」状態として扱う。** ここで
    // previous を promote すると、人が意図して切り離した domain に traffic を戻して
    // しまう。release run にその判断の権限は無い。
    const isKnown = live && (live.id === entry.deployment.id || live.id === entry.previous.id);
    if (!isKnown) {
      const observedState = live ?? { id: null, sha: null };
      movedExternally.push({ entry, live: observedState });
      observedLive.push({ entry, live: observedState });
      logger.log(
        `${entry.project.name}: production is on ${observedState.id ?? 'no deployment'}; leaving it alone`,
      );
      continue;
    }

    try {
      const { autoAssignDrifted } = await rollbackDeployment({
        projectName: entry.project.name,
        productionDomain: entry.project.productionDomain,
        projectId: entry.projectId,
        autoAssignCustomDomains: entry.autoAssignCustomDomains,
        logger,
        deploymentId: entry.previous.id,
        token,
        teamId,
        fetchImpl,
        sleepImpl,
        nowImpl,
      });
      if (autoAssignDrifted) drifted.push(entry.project.name);
      logger.log(`${entry.project.name}: rolled back to ${entry.previous.id}`);
      rolledBack.push(entry);
    } catch {
      // rollback の POST は受理されたが反映が確認できない。**rollback も promote と同じ
      // 非同期 endpoint なので、後から着地しうる。** 窓いっぱい観測し、最後に読めた
      // 状態で分類する。
      const { observed: afterObserved, last: after } = await observeUntilSettled(entry);
      const afterId = after?.id ?? null;
      if (afterObserved && afterId === entry.previous.id) {
        logger.log(`${entry.project.name}: rolled back to ${entry.previous.id} (settled late)`);
        rolledBack.push(entry);
        continue;
      }
      const isThirdParty = afterObserved && afterId !== entry.deployment.id;
      if (isThirdParty) {
        const observedState = after ?? { id: null, sha: null };
        movedExternally.push({ entry, live: observedState });
        observedLive.push({ entry, live: observedState });
        logger.log(
          `${entry.project.name}: production is on ${observedState.id ?? 'no deployment'} after the failed rollback; leaving it alone`,
        );
        continue;
      }
      stranded.push(`${entry.project.name} -> ${entry.previous.id}`);
    }
  }

  if (
    stranded.length > 0 ||
    drifted.length > 0 ||
    preexistingSplit.length > 0 ||
    movedExternally.length > 0
  ) {
    const lines = [`Rollback after "${cause.message}" did not fully clean up.`];
    if (stranded.length > 0) {
      lines.push(`MANUAL ROLLBACK REQUIRED. Point production back to: ${stranded.join('; ')}`);
    }
    if (movedExternally.length > 0) {
      const detail = movedExternally
        .map(({ entry, live }) => `${entry.project.name} (now ${live.id})`)
        .join('; ');
      lines.push(
        `Left alone because another actor moved production first: ${detail}. ` +
          `Confirm that deployment is the intended one.`,
      );
    }
    if (preexistingSplit.length > 0) {
      lines.push(
        `Outside this run's rollback scope: ${preexistingSplit.join(', ')} already served the ` +
          `target SHA before it started. Check them by hand.`,
      );
    }
    if (drifted.length > 0) {
      lines.push(
        `Production is restored, but autoAssignCustomDomains could not be restored for ` +
          `${drifted.join(', ')}. Set it back before the next merge or the gate is bypassed.`,
      );
    }
    // manualRollback は「production pointer が動かせていない」ものだけを指す。
    // rolledBack / movedExternally も載せる。ここで throw すると呼び出し側の代入が
    // 完了せず、戻し済みや他者が動かした分まで「我々の候補を配信中」として
    // manifest に載ってしまう（runbook はその manifest を復旧の一次情報にする）。
    throw Object.assign(new ReleaseError(lines.join(' '), { manualRollback: stranded }), {
      rolledBack,
      movedExternally,
      observedLive,
    });
  }

  return rolledBack;
}

function writeStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${lines.join('\n')}\n`);
}

/** workflow が status publish と run の合否を別々に決められるようにする。 */
export const RELEASE_STATUSES = new Set([
  'already-released',
  'promoted',
  'superseded',
  'unaffected',
  'failed',
]);

export function writeReleaseStatus(status, { env = process.env } = {}) {
  const path = env.GITHUB_OUTPUT;
  // 固定集合以外は書かない。任意文字列を GITHUB_OUTPUT へ流さない。
  if (!path || !RELEASE_STATUSES.has(status)) return;
  appendFileSync(path, `release_status=${status}\n`);
}

function summarize(result) {
  const lines = [
    '## Production Release',
    '',
    `- Commit: \`${result.sha}\``,
    `- Status: ${result.status}`,
  ];
  for (const entry of result.promoted) {
    lines.push(
      `- ${entry.project.name}: promoted \`${entry.deployment.id}\`` +
        ` (previous \`${entry.previous?.id ?? 'none'}\`)`,
    );
  }
  if (result.promoted.length > 0) {
    lines.push('', 'Manual rollback targets are the `previous` deployment ids above.');
  }
  if (result.preexistingSplit?.length > 0) {
    lines.push(
      '',
      `Pre-existing split from an earlier run: ${result.preexistingSplit.join(', ')}.`,
    );
  }
  if (result.status === 'promoted' && result.promoted.length === 0) {
    lines.push(
      '',
      'Nothing was left to promote: Vercel auto-assigned the candidates (Auto-assign is on).',
    );
    lines.push(
      result.gateChecksRan
        ? 'The gate still verified smoke and the config audit against them.'
        : 'Force Promote: smoke and the config audit were skipped, so nothing was verified.',
    );
  }
  if (result.status === 'superseded') {
    lines.push(
      '',
      'A newer Production deployment already serves Production. Nothing was promoted,',
      'and this commit is **not** live. Do not tag it.',
    );
  }
  if (result.status === 'unaffected') {
    lines.push(
      '',
      'This commit changes nothing that either app serves, so Production was left as it is.',
      'The build behind each domain is unchanged and equivalent to this commit.',
    );
  }
  if (result.manifest) {
    lines.push(
      '',
      '### Release manifest',
      '',
      '```json',
      JSON.stringify(result.manifest, null, 2),
      '```',
    );
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bypassSecrets = Object.fromEntries(
    RELEASE_PROJECTS.map((project) => [project.name, process.env[project.bypassEnv]]),
  );

  // 入力の解釈（parseRedeployRequest）が throw しても下の catch で失敗 status を残す。
  Promise.resolve()
    .then(() =>
      runProductionRelease({
        sha: process.env.RELEASE_SHA,
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        force: process.env.RELEASE_FORCE === 'true',
        impactAffected: readImpactAffected(),
        redeploy: parseRedeployRequest(process.env.RELEASE_REDEPLOY),
        expectedAutoAssign:
          process.env.RELEASE_EXPECT_AUTO_ASSIGN === 'false'
            ? false
            : process.env.RELEASE_EXPECT_AUTO_ASSIGN === 'true'
              ? true
              : null,
        simulateFailure: process.env.RELEASE_SIMULATE_FAILURE ?? '',
        bypassSecrets,
      }),
    )
    .then((result) => {
      writeStepSummary(summarize(result));
      writeReleaseManifest(result.manifest);
      writeReleaseStatus(result.status);
      console.log(`Production Release finished: ${result.status}`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Production Release failed';
      const lines = ['## Production Release', '', `- Failed: ${message}`];
      // 部分失敗の復旧では「今どの project が何を配信しているか」が一次情報になる。
      // 失敗時こそ manifest を残す。
      if (error?.manifest) {
        lines.push(
          '',
          '### Release manifest',
          '',
          '```json',
          JSON.stringify(error.manifest, null, 2),
          '```',
        );
        writeReleaseManifest(error.manifest);
      }
      writeStepSummary(lines);
      writeReleaseStatus('failed');
      console.error(message);
      process.exitCode = 1;
    });
}
