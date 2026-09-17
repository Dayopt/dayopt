/**
 * `pnpm jev:smoke` — 合成データで Jev を数回だけ呼ぶ live 検査。
 *
 * #2827 Phase 0 の Go 条件（クレジット購入なしで合成データ評価が成功し、費用と
 * 失敗時の動作を確認できる）に対する証拠を取る。日常の CI からは呼ばない。
 *
 *   AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:smoke
 *
 * 秘密の扱い: key は env から adapter へ渡すだけで、出力にも例外にも載せない。
 *
 * 直列に 1 request ずつ送る。予算・rate limit の実測値が無い段階で並列化すると、
 * 429 と課金がどちらも同時に増えて切り分けられなくなる。budget 系の失敗が出たら
 * そこで打ち切り、credits 購入や他モデルへの迂回はしない。
 */
import {
  JEV_MODEL_ID,
  JEV_SCHEMA_VERSION,
  evaluateWithJev,
  type JevAnnotation,
} from '../../lib/jev-adapter.ts';
import { JEV_SMOKE_CASES } from '../../lib/jev-smoke-cases.ts';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function costOf(annotation: JevAnnotation): number | null {
  const { before, after } = annotation.credits;
  if (!before || !after) return null;
  return Number((before.balance - after.balance).toFixed(6));
}

function describe(annotation: JevAnnotation): string[] {
  const lines = [
    `  status        ${annotation.status} / ${annotation.reasonCode}`,
    `  model         ${annotation.resolvedModelId ?? '(応答に modelId 無し)'}`,
    `  usage         in=${annotation.usage.inputTokens ?? '?'} out=${annotation.usage.outputTokens ?? '?'}`,
    `  latency       ${annotation.latencyMs ?? '?'} ms`,
    `  balance       ${annotation.credits.before?.balance ?? '?'} -> ${annotation.credits.after?.balance ?? '?'}`,
    `  cost          ${costOf(annotation) ?? '(未取得)'}`,
  ];
  if (annotation.answers)
    for (const [id, answer] of Object.entries(annotation.answers))
      lines.push(`  answer.${id}  ${JSON.stringify(answer)}`);
  if (annotation.providerMetadata)
    lines.push(`  metadata      ${JSON.stringify(annotation.providerMetadata)}`);
  return lines;
}

async function run(): Promise<number> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('AI_GATEWAY_API_KEY が無い。op run で注入して実行する:');
    console.error(
      '  AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:smoke',
    );
    return 1;
  }

  const only = argValue('--case');
  const cases = only ? JEV_SMOKE_CASES.filter((item) => item.id === only) : JEV_SMOKE_CASES;
  if (cases.length === 0) {
    console.error(`--case ${only} に一致する合成ケースが無い`);
    return 1;
  }

  const asJson = process.argv.includes('--json');
  const results: Array<{ id: string; purpose: string; annotation: JevAnnotation }> = [];

  for (const smokeCase of cases) {
    const annotation = await evaluateWithJev(smokeCase.request);
    results.push({ id: smokeCase.id, purpose: smokeCase.purpose, annotation });

    if (!asJson) {
      console.log(`[${smokeCase.id}] ${smokeCase.purpose}`);
      for (const line of describe(annotation)) console.log(line);
      console.log('');
    }

    if (annotation.status === 'budget_exhausted') {
      if (!asJson) console.error('予算・残高の壁に当たったので以降を中止する（購入はしない）');
      break;
    }
  }

  const evaluated = results.filter((item) => item.annotation.status === 'evaluated');

  if (asJson) {
    console.log(
      JSON.stringify(
        { schemaVersion: JEV_SCHEMA_VERSION, modelId: JEV_MODEL_ID, results },
        null,
        2,
      ),
    );
  } else {
    console.log(`${evaluated.length} / ${results.length} 件が evaluated`);
  }

  return evaluated.length === results.length && results.length === cases.length ? 0 : 1;
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
