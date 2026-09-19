/**
 * Evaluation Pack の CLI（#2827）。`pnpm jev:pack <packId> <collect|evaluate|report>`。
 *
 *   pnpm jev:pack skill-suggestion collect --limit 150
 *   AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- \
 *     pnpm jev:pack skill-suggestion evaluate --split tune --max 1
 *   pnpm jev:pack skill-suggestion report --split tune --threshold 0.6
 *
 * **運用の担当も review gate も変えない。** Decision は候補と集計にしか使わず、ここから
 * skill の自動読込・振り分け・merge 可否へ繋がる経路は作らない。
 *
 * 外部呼び出し（gh / Jev）はこの file と `jev-gh-prs.ts` に閉じる。判定は
 * `scripts/lib/jev-pack*.ts` の純粋関数が持ち、test は network 無しでそちらを直接叩く。
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defaultGhApi, defaultGhGraphql, readPolicyCheckout } from '../../lib/jev-gh-prs.ts';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_LIMIT,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  parseRunnerFlags,
  runPackCollect,
  runPackEvaluate,
  runPackReport,
  type RunnerFlags,
} from '../../lib/jev-pack-runner.ts';
import { createShadowPack } from '../../lib/jev-pack-shadow.ts';
import { createSkillSuggestionPack } from '../../lib/jev-pack-skill-suggestion.ts';
import type { AnyPack } from '../../lib/jev-pack.ts';
import type { ResolveProtectedGate } from '../../lib/jev-shadow-truth.ts';
import { loadSkillRoster } from '../../lib/jev-skill-roster.ts';

// tsx は scripts/ の .ts を CJS へ落とすため `import.meta.url` は使えない。
const ROOT = resolve(__dirname, '../../..');

export const PACK_IDS = ['shadow-e1', 'skill-suggestion'] as const;
/** `pnpm jev:shadow` の既定保存先。pack runner とは case の形式が違うので注釈だけ引き継ぐ。 */
export const SHADOW_LEGACY_OUT = join('tmp', 'jev-shadow');
export type PackId = (typeof PACK_IDS)[number];

export type PackArgs = RunnerFlags & {
  packId: PackId;
  command: 'collect' | 'evaluate' | 'report';
};

export function parsePackArgs(
  argv: readonly string[],
): { ok: true; args: PackArgs } | { ok: false; message: string } {
  const [packId, command, ...rest] = argv;
  if (!packId || !(PACK_IDS as readonly string[]).includes(packId))
    return {
      ok: false,
      message: `packId は ${PACK_IDS.join(' / ')} のいずれか（受け取った値: ${packId ?? 'なし'}）`,
    };
  if (command !== 'collect' && command !== 'evaluate' && command !== 'report')
    return {
      ok: false,
      message: `subcommand は collect / evaluate / report のいずれか（受け取った値: ${command ?? 'なし'}）`,
    };
  const parsed = parseRunnerFlags(rest, {
    out: join('tmp', 'jev', packId),
    limit: DEFAULT_LIMIT,
    max: null,
    split: command === 'evaluate' ? 'tune' : 'all',
    delayMs: DEFAULT_DELAY_MS,
    rateLimitWaitMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    threshold: null,
    asJson: false,
  });
  if (!parsed.ok) return parsed;
  return { ok: true, args: { packId: packId as PackId, command, ...parsed.flags } };
}

/**
 * `protected-path-gate.mjs` と `ctx.mjs`（gate を静的 import している）は top-level await を
 * 持つ。tsx が CJS へ落とす .ts からは静的 import できない（ERR_REQUIRE_ASYNC_MODULE）ので、
 * ここで動的に読む。
 */
export async function loadPack(packId: PackId, threshold: number | null): Promise<AnyPack> {
  const gate = (await import('../../ci/protected-path-gate.mjs')) as {
    resolveProtectedPathGate: ResolveProtectedGate;
  };
  if (packId === 'shadow-e1')
    return createShadowPack({ resolveGate: gate.resolveProtectedPathGate }) as AnyPack;

  const ctx = (await import('../ctx.mjs')) as {
    mapSkills: (files: string[], protectedRequired: boolean) => string[];
  };
  return createSkillSuggestionPack({
    roster: loadSkillRoster(ROOT),
    // 第 2 引数 false: 保護対象由来の pr-cross-review は roster 外なので足さない。
    mapSkills: (files) => ctx.mapSkills(files, false),
    threshold,
    pathExists: (path) => existsSync(join(ROOT, path)),
  }) as AnyPack;
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parsePackArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(
      `${parsed.message}\n使い方: pnpm jev:pack <${PACK_IDS.join('|')}> <collect|evaluate|report> [--out dir] [--limit N] [--max N] [--split tune|holdout|all] [--delay ms] [--rate-limit-wait ms] [--threshold 0..1] [--json]\n`,
    );
    return 1;
  }
  const args = parsed.args;

  if (args.command === 'evaluate' && !process.env.AI_GATEWAY_API_KEY?.trim()) {
    process.stderr.write(
      `AI_GATEWAY_API_KEY が無い。次の形で実行する:\n  AI_GATEWAY_API_KEY="op://agent/vercel-ai-gateway/credential" op run -- pnpm jev:pack ${args.packId} evaluate\n`,
    );
    return 1;
  }

  const pack = await loadPack(args.packId, args.threshold);

  if (args.command === 'report') {
    process.stdout.write(
      `${runPackReport({ pack, out: args.out, split: args.split, asJson: args.asJson })}\n`,
    );
    return 0;
  }

  if (args.command === 'collect') {
    process.stdout.write(
      `${await runPackCollect({
        pack,
        out: args.out,
        limit: args.limit,
        api: defaultGhApi,
        graphql: defaultGhGraphql,
        now: () => new Date(),
        policyCheckout: readPolicyCheckout,
        asJson: args.asJson,
        // Phase 1 の課金済み注釈（旧形式の保存先）を shadow-e1 だけ引き継ぐ。
        legacyOut: args.packId === 'shadow-e1' ? SHADOW_LEGACY_OUT : undefined,
      })}\n`,
    );
    return 0;
  }

  return runPackEvaluate({
    pack,
    out: args.out,
    split: args.split,
    max: args.max,
    delayMs: args.delayMs,
    rateLimitWaitMs: args.rateLimitWaitMs,
  });
}

/** 直接実行された時だけ走らせる（test が import しただけで実リクエストが飛ぶのを防ぐ）。 */
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
