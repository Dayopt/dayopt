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
import { realpathSync } from 'node:fs';

import {
  JEV_MODEL_ID,
  JEV_SCHEMA_VERSION,
  evaluateWithJev,
  isExpectedJevModelId,
  type JevAnnotation,
} from '../../lib/jev-adapter.ts';
import { JEV_SMOKE_CASES } from '../../lib/jev-smoke-cases.ts';

/**
 * argv を既知の flag と値へ**完全に**解釈する。未知の option も余分な positional も
 * usage error にする。
 *
 * 個別の flag だけを `indexOf` で拾っていた頃は、`--cas minimal` のような打ち間違いが
 * 「--case は無い」と読まれて全 3 件の課金リクエストへ化けた。知らない引数を無視する
 * 設計そのものをやめる。
 */
export type SmokeArgs = { caseId: string | null; delayMs: number; asJson: boolean };

export function parseSmokeArgs(
  argv: readonly string[],
): { ok: true; args: SmokeArgs } | { ok: false; message: string } {
  let caseId: string | null = null;
  let delayMs = DEFAULT_DELAY_MS;
  let asJson = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--json') {
      asJson = true;
      continue;
    }
    if (token !== '--case' && token !== '--delay')
      return { ok: false, message: `未知の引数: ${token}` };

    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('-'))
      return { ok: false, message: `${token} に値がない` };
    // `--delay "$JEV_DELAY"` の env が未設定だと空文字が渡る。`Number('')` は 0 なので、
    // そのまま通すと安全間隔が黙って無効になる（実測で 3 件目が 429 になる条件）。
    const value = raw.trim();
    if (value === '') return { ok: false, message: `${token} の値が空` };
    index += 1;

    if (token === '--case') {
      caseId = value;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      return { ok: false, message: '--delay は 0 以上のミリ秒で指定する' };
    delayMs = parsed;
  }

  return { ok: true, args: { caseId, delayMs, asJson } };
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
  // 引数の検証を credential より先に行う。使い方の誤りは認証の有無と無関係で、
  // ここで落とせば外部呼び出しも課金も起きない。
  const parsed = parseSmokeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(`  使い方: pnpm jev:smoke [--case <id>] [--delay <ms>] [--json]`);
    console.error(`  ケース: ${JEV_SMOKE_CASES.map((item) => item.id).join(', ')}`);
    return 1;
  }
  const { caseId, delayMs, asJson } = parsed.args;

  const cases = caseId ? JEV_SMOKE_CASES.filter((item) => item.id === caseId) : JEV_SMOKE_CASES;
  if (cases.length === 0) {
    console.error(`--case ${caseId} に一致する合成ケースが無い`);
    console.error(`  ケース: ${JEV_SMOKE_CASES.map((item) => item.id).join(', ')}`);
    return 1;
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('AI_GATEWAY_API_KEY が無い。op run で注入して実行する:');
    console.error(
      '  AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:smoke',
    );
    return 1;
  }

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

  // Phase 0 の目的は「評価が返ること」だけではなく、**実モデル ID と実費を確認できること**。
  // evaluated だけを成功条件にすると、SDK や Gateway の変更で modelId が欠落しても、
  // cost が取れなくなっても、目的を達成したことにしてしまう。
  const shortfalls = results.flatMap((item) => {
    if (item.annotation.status !== 'evaluated') return [];
    const reasons: string[] = [];
    if (!isExpectedJevModelId(item.annotation.resolvedModelId))
      reasons.push(`応答のモデルが Jev でない: ${item.annotation.resolvedModelId ?? '(無し)'}`);
    if (item.annotation.costUsd === null) reasons.push('実費を取得できていない');
    return reasons.map((reason) => ({ id: item.id, reason }));
  });
  const succeeded = results.filter(
    (item) =>
      item.annotation.status === 'evaluated' &&
      isExpectedJevModelId(item.annotation.resolvedModelId) &&
      item.annotation.costUsd !== null,
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        { schemaVersion: JEV_SCHEMA_VERSION, modelId: JEV_MODEL_ID, results },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `${succeeded.length} / ${results.length} 件が evaluated（実モデル ID と実費の取得を含む）`,
    );
    for (const item of shortfalls) console.error(`[${item.id}] ${item.reason}`);
  }

  return succeeded.length === cases.length ? 0 : 1;
}

/**
 * 直接実行された時だけ走らせる。test が `parseSmokeArgs` を import するだけで
 * CLI 本体が動き、credential が環境にあれば実リクエストまで飛ぶのを防ぐ。
 *
 * `scripts/lib/is-direct-execution.mjs` は `import.meta.url` を受け取る形だが、
 * tsx は scripts の .ts を CJS へ落とすため `import.meta` を使えない。
 * 同じ判定を `__filename` で行う。
 */
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
