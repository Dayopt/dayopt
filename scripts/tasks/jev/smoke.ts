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
 * 直列に 1 request ずつ、間隔を空けて送る。budget 系の失敗が出たらそこで打ち切り、
 * credits 購入や他モデルへの迂回はしない。
 *
 * **間隔が要る理由（2026-09-18 実測）**: 無料枠の Jev は連続 3 request 目で 429 を
 * 返した。Vercel は無料枠の上限値を公開していないが、smoke の規模でも当たる。
 * ここで retry を足さないのは意図的で、adapter は 429 を status へ落とすだけにし、
 * 待つかどうかは呼び出し側が明示的に決める（AI SDK 既定の retry を 0 に固定して
 * いるのと同じ理由。隠れた再送で無料枠と 429 が同時に増えるのを避ける）。
 */
import {
  JEV_MODEL_ID,
  JEV_SCHEMA_VERSION,
  evaluateWithJev,
  type JevAnnotation,
} from '../../lib/jev-adapter.ts';
import { JEV_SMOKE_CASES } from '../../lib/jev-smoke-cases.ts';

type ArgResult =
  | { status: 'absent' }
  | { status: 'ok'; value: string }
  /** flag はあるが値が無い。全件送信へ倒すと課金付きで 3 件出てしまうので分ける。 */
  | { status: 'missing-value' };

function argValue(flag: string): ArgResult {
  const index = process.argv.indexOf(flag);
  if (index < 0) return { status: 'absent' };
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('-')) return { status: 'missing-value' };
  return { status: 'ok', value };
}

const DEFAULT_DELAY_MS = 6_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 表示用の実費。provider が返した値をそのまま使う。
 *
 * 残高差分を使わないのは、Gateway の利用量取り込みが非同期で前後差が実費と一致しないため。
 * 丸めないのは、この model の 1 件が $0.0000135 で、小数 6 桁に丸めると $0.000014 になり
 * Phase 0 が測りたい費用を 4% 過大に報告するため。
 */
function formatCost(annotation: JevAnnotation): string {
  return annotation.costUsd === null ? '(未取得)' : annotation.costUsd.toString();
}

function describe(annotation: JevAnnotation): string[] {
  const lines = [
    `  status        ${annotation.status} / ${annotation.reasonCode}`,
    `  model         ${annotation.resolvedModelId ?? '(応答に modelId 無し)'}`,
    `  usage         in=${annotation.usage.inputTokens ?? '?'} out=${annotation.usage.outputTokens ?? '?'}`,
    `  latency       ${annotation.latencyMs ?? '?'} ms`,
    `  balance       ${annotation.credits.before?.balance ?? '?'} -> ${annotation.credits.after?.balance ?? '?'}`,
    `  cost          ${formatCost(annotation)}`,
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
  if (only.status === 'missing-value') {
    console.error('--case に値がない。ケース名を渡すか、flag ごと外して全件実行する');
    console.error(`  指定できるケース: ${JEV_SMOKE_CASES.map((item) => item.id).join(', ')}`);
    return 1;
  }
  const cases =
    only.status === 'ok'
      ? JEV_SMOKE_CASES.filter((item) => item.id === only.value)
      : JEV_SMOKE_CASES;
  if (cases.length === 0) {
    console.error(`--case ${only.status === 'ok' ? only.value : ''} に一致する合成ケースが無い`);
    return 1;
  }

  const delayArg = argValue('--delay');
  if (delayArg.status === 'missing-value') {
    console.error('--delay に値がない。ミリ秒を渡すか、flag ごと外して既定値を使う');
    return 1;
  }
  const delayMs = delayArg.status === 'ok' ? Number(delayArg.value) : DEFAULT_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    console.error('--delay は 0 以上のミリ秒で指定する');
    return 1;
  }

  const asJson = process.argv.includes('--json');
  const results: Array<{ id: string; purpose: string; annotation: JevAnnotation }> = [];

  for (const [index, smokeCase] of cases.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
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

    // 429 に当たった窓は数分単位で塞がる。残りを送っても同じ 429 を積むだけなので止める。
    if (annotation.reasonCode === 'rate_limited') {
      if (!asJson)
        console.error(
          `rate limit に当たったので以降を中止する（窓の回復は実測で 2〜4 分。--delay は現在 ${delayMs} ms）`,
        );
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
