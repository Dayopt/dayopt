/**
 * `pnpm jev:check` — Jev 連携の設定検査。**ネットワークを一切使わない。**
 *
 * #2827 Phase 0。CI と pre-push から回せるように、API key も残高も要求しない。
 * ここで見るのは「送る前に固定しておきたい約束」だけ:
 *
 * - SDK の version が package.json の exact pin と一致する（experimental API なので
 *   patch release で契約が動く。`ai` の docs も「7.0.105 onwards」と version を名指す）
 * - retry が 0 に固定されている（AI SDK 既定の 2 は無料枠を 3 倍で溶かす）
 * - model が 1 つしか無い（予算切れを別モデルで救済する経路を作らない、という #2827 の制約）
 * - 合成 smoke ケースが静的検査を通る
 * - Jev を無効化した経路が、外部呼び出しなしで `unavailable` を返す
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  JEV_MAX_DISTRIBUTION_KEYS,
  JEV_MAX_INPUT_BYTES,
  JEV_MAX_QUESTIONS,
  JEV_MAX_RETRIES,
  JEV_MIN_BALANCE_USD,
  JEV_MODEL_ID,
  JEV_SCHEMA_VERSION,
  evaluateWithJev,
  jevCacheKey,
  validateJevRequest,
} from '../../lib/jev-adapter.ts';
import { createShadowPack } from '../../lib/jev-pack-shadow.ts';
import { createSkillSuggestionPack } from '../../lib/jev-pack-skill-suggestion.ts';
import { buildPackRequest, packQuestionSetId } from '../../lib/jev-pack.ts';
import { SHADOW_QUESTION_IDS, SHADOW_QUESTION_SET_ID } from '../../lib/jev-shadow-questions.ts';
import { SHADOW_SYNTHETIC_CASES } from '../../lib/jev-shadow-synthetic.ts';
import { buildShadowRequest } from '../../lib/jev-shadow-truth.ts';
import { SKILL_ROSTER_IDS, loadSkillRoster } from '../../lib/jev-skill-roster.ts';
import { JEV_SMOKE_CASES } from '../../lib/jev-smoke-cases.ts';
import { PACK_IDS, PACK_STATUS } from './pack.ts';

// tsx は scripts/ の .ts を CJS へ落とすため `import.meta.url` は使えない。
// 他の scripts/tasks/*.ts と同じ `__dirname` 起点に揃える。
const ROOT = resolve(__dirname, '../../..');

type Check = { name: string; ok: boolean; detail: string };

function readJson(relative: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function pinnedVersion(pkg: Record<string, unknown>, name: string): string | null {
  const dev = pkg.devDependencies;
  if (typeof dev !== 'object' || dev === null) return null;
  const value = (dev as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

function installedVersion(name: string): string | null {
  try {
    const value = readJson(`node_modules/${name}/package.json`).version;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function versionCheck(name: string, pkg: Record<string, unknown>): Check {
  const pinned = pinnedVersion(pkg, name);
  const installed = installedVersion(name);
  const exact = pinned !== null && /^\d+\.\d+\.\d+$/.test(pinned);
  return {
    name: `${name} は exact pin で、install 済み version と一致する`,
    ok: exact && pinned === installed,
    detail: `pin=${pinned ?? '(無し)'} installed=${installed ?? '(無し)'}`,
  };
}

/**
 * adapter 本体のソースを読む検査。定数を export しているだけでは「実際にその値を
 * 渡しているか」は保証できないので、呼び出し箇所の形も見る。
 */
function adapterSourceChecks(): Check[] {
  const source = readFileSync(join(ROOT, 'scripts/lib/jev-adapter.ts'), 'utf8');
  const modelLiterals = [...source.matchAll(/'[a-z0-9-]+\/[a-z0-9.-]+'/g)].map((match) => match[0]);
  const uniqueModels = [...new Set(modelLiterals)];
  return [
    {
      name: 'evaluate 呼び出しが maxRetries を定数で固定している',
      ok: source.includes('maxRetries: JEV_MAX_RETRIES'),
      detail: 'AI SDK の既定 2 を明示的に打ち消す',
    },
    {
      name: 'model 文字列は 1 つだけ（他モデルへの fallback 経路が無い）',
      ok: uniqueModels.length === 1 && uniqueModels[0] === `'${JEV_MODEL_ID}'`,
      detail: uniqueModels.join(', ') || '(無し)',
    },
  ];
}

async function run(): Promise<number> {
  const pkg = readJson('package.json');
  const checks: Check[] = [
    versionCheck('ai', pkg),
    versionCheck('@ai-sdk/gateway', pkg),
    {
      name: 'retry は 0 に固定',
      ok: JEV_MAX_RETRIES === 0,
      detail: `JEV_MAX_RETRIES=${JEV_MAX_RETRIES}`,
    },
    {
      name: 'model は Jev のみ',
      ok: JEV_MODEL_ID === 'typesafe-ai/jev',
      detail: JEV_MODEL_ID,
    },
    ...adapterSourceChecks(),
  ];

  for (const smokeCase of JEV_SMOKE_CASES) {
    const errors = validateJevRequest(smokeCase.request);
    checks.push({
      name: `合成ケース ${smokeCase.id} が静的検査を通る`,
      ok: errors.length === 0,
      detail: errors.join(' / ') || smokeCase.purpose,
    });
  }

  // Phase 1 の質問セットも同じ静的検査に通す。質問文を足した時に上限や空欄で落ちるのを
  // 課金前に捕まえる（合成 state は代表として shadow の合成ケースを 1 件使う）。
  const shadowErrors = validateJevRequest(buildShadowRequest(SHADOW_SYNTHETIC_CASES[0].state));
  checks.push({
    name: 'shadow 質問セットが静的検査を通る',
    ok: shadowErrors.length === 0,
    detail: shadowErrors.join(' / ') || `${SHADOW_QUESTION_IDS.length} 問`,
  });

  // pack 0（shadow-e1）が Phase 1 と同じ questionSetId / cacheKey を作ること。ここが
  // ずれると `tmp/jev-shadow` の課金済み注釈 76 件が pack runner から見えなくなる。
  const shadowPack = createShadowPack({
    resolveGate: () => ({ required: false, auditContract: false }),
  });
  const shadowState = SHADOW_SYNTHETIC_CASES[0].state;
  const packRequest = buildPackRequest(shadowPack, shadowState as never);
  checks.push({
    name: 'pack shadow-e1 が Phase 1 と同じ questionSetId と cacheKey を作る',
    ok:
      packQuestionSetId(shadowPack) === SHADOW_QUESTION_SET_ID &&
      jevCacheKey(packRequest) === jevCacheKey(buildShadowRequest(shadowState)),
    detail: packQuestionSetId(shadowPack),
  });

  // skill-suggestion の 12 問。roster は実 repo の SKILL.md から読む。description か
  // When to Use が空の skill があれば、質問文が欠けたまま課金する前にここで落とす。
  const roster = loadSkillRoster(ROOT);
  const rosterGaps = roster
    .filter((doc) => !doc.description || doc.whenToUse.length === 0)
    .map((doc) => doc.id);
  const skillPack = createSkillSuggestionPack({
    roster,
    mapSkills: () => [],
    pathExists: () => false,
  });
  const skillErrors = validateJevRequest(
    buildPackRequest(skillPack, { source: 'issue', title: 'x', body: 'y', labels: [] }),
  );
  checks.push({
    name: 'skill-suggestion の質問セットが静的検査を通り、roster が欠けていない',
    ok:
      skillErrors.length === 0 &&
      rosterGaps.length === 0 &&
      roster.length === SKILL_ROSTER_IDS.length,
    detail:
      [...skillErrors, ...rosterGaps.map((id) => `${id}: description / When to Use が空`)].join(
        ' / ',
      ) || `${Object.keys(skillPack.questions).length} 問 / 上限 ${JEV_MAX_QUESTIONS}`,
  });

  // 無効化した経路。runner も apiKey も渡さないので、外部へは出ない。
  const disabled = await evaluateWithJev(JEV_SMOKE_CASES[0].request, { disabled: true });
  // 無効化した pack を「理由なく止まっているもの」にしない。理由が消えると、
  // 再開してよいのか作り直しが要るのかが後から判断できなくなる。
  const statusGaps = PACK_IDS.filter((id) => {
    const entry = PACK_STATUS[id];
    return !entry || (entry.status === 'disabled' && !entry.reason?.trim());
  });
  checks.push({
    name: '全 pack に status があり、無効な pack には理由が書かれている',
    ok: statusGaps.length === 0,
    detail:
      statusGaps.length === 0
        ? PACK_IDS.map((id) => `${id}=${PACK_STATUS[id]?.status ?? '(無し)'}`).join(' ')
        : `理由や status が欠けている: ${statusGaps.join(', ')}`,
  });

  checks.push({
    name: '無効化した経路は外部呼び出しなしで unavailable を返す',
    ok: disabled.status === 'unavailable' && disabled.reasonCode === 'disabled',
    detail: `${disabled.status} / ${disabled.reasonCode}`,
  });

  const failed = checks.filter((check) => !check.ok);

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: JEV_SCHEMA_VERSION,
          modelId: JEV_MODEL_ID,
          limits: {
            maxRetries: JEV_MAX_RETRIES,
            maxInputBytes: JEV_MAX_INPUT_BYTES,
            maxQuestions: JEV_MAX_QUESTIONS,
            maxDistributionKeys: JEV_MAX_DISTRIBUTION_KEYS,
            minBalanceUsd: JEV_MIN_BALANCE_USD,
          },
          checks,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Jev 設定検査（schema v${JEV_SCHEMA_VERSION} / model ${JEV_MODEL_ID}）`);
    console.log(
      `上限: 入力 ${JEV_MAX_INPUT_BYTES} バイト（state + 最長 question）/ 質問 ${JEV_MAX_QUESTIONS} 件 / 選択肢・段 ${JEV_MAX_DISTRIBUTION_KEYS} / 残高の床 $${JEV_MIN_BALANCE_USD}`,
    );
    console.log('');
    for (const check of checks)
      console.log(`${check.ok ? 'OK  ' : 'NG  '}${check.name} — ${check.detail}`);
    console.log('');
    console.log(
      failed.length === 0
        ? `${checks.length} 件すべて OK`
        : `${failed.length} / ${checks.length} 件が NG`,
    );
  }

  return failed.length === 0 ? 0 : 1;
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
