/** Explicit advisory entrypoint. Does not post, change gates, or run shell commands from inputs. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  CLAIM_RELATIONS,
  claimRequests,
  claimRow,
  claimsInputSchema,
  contextRequests,
  contextRows,
  rankContext,
  selectContextCandidates,
  type ContextInput,
} from '../../lib/jev-assist-packs.ts';
import { collectAssistContext, loadClaimEvidence } from '../../lib/jev-assist-sources.ts';
import {
  atomicJson,
  evaluateAssist,
  jevStoreRoot,
  type AssistEvaluationOptions,
} from '../../lib/jev-assist-store.ts';

export type AssistArgs =
  | { mode: 'context'; issue: number; json: boolean; cacheOnly: boolean }
  | { mode: 'claims'; input: string; json: boolean; cacheOnly: boolean };

export function parseAssistArgs(argv: readonly string[]): AssistArgs {
  const [mode, ...rest] = argv;
  if (mode !== 'context' && mode !== 'claims')
    throw new Error(
      '使い方: jev:assist context --issue <N> | claims --input <file> [--json] [--cache-only]',
    );
  let value: string | null = null;
  let json = false;
  let cacheOnly = false;
  const valueFlag = mode === 'context' ? '--issue' : '--input';
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--cache-only' && !cacheOnly) cacheOnly = true;
    else if (
      arg === valueFlag &&
      value === null &&
      rest[index + 1]?.trim() &&
      !rest[index + 1].startsWith('-')
    )
      value = rest[++index];
    else throw new Error('未知・重複・値のない引数');
  }
  if (value === null) throw new Error(`${valueFlag} が必要`);
  if (mode === 'claims') return { mode, input: value, json, cacheOnly };
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('issue番号が不正');
  return { mode, issue: Number(value), json, cacheOnly };
}

export function readAssistJson(path: string): unknown {
  // Check the name before resolving or opening it, and again after following symlinks.
  const allowed = (name: string) =>
    name.endsWith('.json') && !name.startsWith('.env') && !name.startsWith('.op-env');
  if (!allowed(basename(path))) throw new Error('入力には専用JSONを指定する');
  const resolved = realpathSync(path);
  if (
    !allowed(basename(resolved)) ||
    !statSync(resolved).isFile() ||
    statSync(resolved).size > 256_000
  )
    throw new Error('入力JSONの種別・サイズが不正');
  const raw: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
  return raw;
}

export function readClaimsInput(path: string) {
  const raw = readAssistJson(path);
  const result = claimsInputSchema.safeParse(raw);
  if (!result.success) throw new Error('入力JSONの対象SHA・証拠参照・形式が不正');
  return result.data;
}

export async function assistContext(input: ContextInput, options: AssistEvaluationOptions) {
  const rows = [];
  for (const batch of contextRequests(input))
    rows.push(...contextRows(batch.candidates, await evaluateAssist(batch.request, options)));
  const { omitted } = selectContextCandidates(input);
  return {
    schemaVersion: 1,
    packId: 'context-relevance',
    questionVersion: 'v1',
    mode: 'shadow',
    input,
    target: { number: input.number, sha: input.sha, url: input.url },
    missing: input.missing,
    rows,
    top: rankContext(rows),
    omitted,
    complete:
      rows.length > 0 && rows.every((row) => row.relevance !== null) && input.missing.length === 0,
  };
}

export async function assistClaims(
  material: ReturnType<typeof loadClaimEvidence>,
  options: AssistEvaluationOptions,
) {
  const rows = [];
  for (const item of claimRequests(material.input, material.evidence)) {
    const result = item.missing.length
      ? { source: 'unavailable' as const, reason: 'missing_evidence', annotation: null }
      : await evaluateAssist(item.request, options);
    rows.push(claimRow(item.claim, material.evidence, item.missing, result));
  }
  return {
    schemaVersion: 1,
    packId: 'claim-support',
    questionVersion: 'v1',
    mode: 'shadow',
    input: material.input,
    target: material.input.target,
    rows,
    complete: rows.every((row) => row.source !== 'unavailable'),
  };
}

export type AssistReport =
  Awaited<ReturnType<typeof assistContext>> | Awaited<ReturnType<typeof assistClaims>>;
const line = (text: string) =>
  text
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .slice(0, 350);

export function formatAssist(report: AssistReport, artifact: string): string {
  const lines = [
    `Jev ${report.packId} — 推定・shadow（自動接続は未承認）`,
    `対象 #${report.target.number} / ${report.target.sha}`,
    '指摘なしは問題なしの証明ではない。原文で確認する。',
  ];
  if ('top' in report) {
    lines.push(report.complete ? '評価対象の評価完了' : '部分評価または未評価（候補の順位は暫定）');
    for (const row of report.top)
      lines.push(
        `- 読む候補 ${row.id}: ${row.relevance?.toFixed(2)} / ${row.category} / ${row.evaluatedAt}\n  ${line(row.text)}\n  ${row.url}`,
      );
    for (const row of report.rows.filter((item) => item.relevance === null))
      lines.push(`- 未評価 ${row.id}: ${row.reason} — ${row.url}`);
    lines.push(`対象外 ${report.omitted.length} 件（全参照は成果物に保存）`);
    for (const missing of report.missing) lines.push(`- 入力不足: ${missing}`);
  } else {
    for (const row of report.rows) {
      lines.push(
        `- ${row.id}: ${CLAIM_RELATIONS[row.relation]}（${row.source} / ${row.reason} / ${row.evaluatedAt ?? '未評価'}）`,
        `  ${line(row.text)}`,
        `  証拠: ${row.evidenceIds.join(', ') || 'なし'} / 分布: ${JSON.stringify(row.probabilities)} / 不足: ${row.missing.join(', ') || 'なし'}`,
      );
      for (const evidence of row.evidence) lines.push(`  ${evidence.id}: ${evidence.url}`);
    }
  }
  lines.push(
    `全資料・注釈: ${artifact}`,
    'cooldown の未評価分は60秒以上後の明示再実行で続行。資格情報不在では外部評価しない。',
  );
  return lines.join('\n');
}

export async function runAssist(argv: readonly string[]): Promise<number> {
  const args = parseAssistArgs(argv);
  // Fully validate local input before GitHub / model access.
  const claims = args.mode === 'claims' ? readClaimsInput(args.input) : null;
  const root = jevStoreRoot();
  const options = { root, allowNetwork: !args.cacheOnly };
  const report =
    args.mode === 'context'
      ? await assistContext(await collectAssistContext(args.issue), options)
      : await assistClaims(loadClaimEvidence(claims), options);
  const artifacts = join(root, 'assist');
  mkdirSync(artifacts, { recursive: true });
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const artifact = join(artifacts, `${report.packId}-${digest}.json`);
  atomicJson(artifact, report);
  process.stdout.write(
    `${args.json ? JSON.stringify({ ...report, artifact }, null, 2) : formatAssist(report, artifact)}\n`,
  );
  // Availability is data, not a failing development gate. Usage errors exit nonzero.
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__filename)) {
  runAssist(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // Exception text may contain input or provider response. Never echo it.
      process.stderr.write(
        'Jev assist を実行できません。引数・公開資料・GitHub接続を確認してください。\n',
      );
      process.exitCode = 1;
    },
  );
}
