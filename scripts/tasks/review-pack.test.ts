import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SCHEMAS, packArtifacts } from '../lib/review-contract.mjs';
import { createReviewPack, createSweepPack, schemaErrors, validateReview } from './review-pack.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'dayopt-review-pack-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Review Fixture');
  git('config', 'user.email', 'review@example.invalid');
  writeFileSync(join(cwd, 'logic.ts'), 'export const value = 1;\n');
  git('add', 'logic.ts');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'logic.ts', 'renamed.ts');
  writeFileSync(join(cwd, 'renamed.ts'), 'export const value = 2;\n');
  git('add', 'renamed.ts');
  git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'renamed.ts'), 'UNCOMMITTED - must not enter review\n');
  const context = join(cwd, 'context.md');
  const verification = join(cwd, 'verification.md');
  writeFileSync(context, '目的: 値の変更。受け入れ条件: 2を返す。\n');
  writeFileSync(verification, '検証: 未実行。理由: fixture。\n');
  const out = join(cwd, 'pack');
  return { cwd, base, head, context, verification, out, git };
}
function envelope(manifest: { packId: string; baseSha: string; headSha: string }) {
  return {
    packId: manifest.packId,
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    provider: 'OpenAI',
    model: 'fixture',
    modelFamily: 'GPT',
    sessionId: 'independent-fixture',
    independence: 'separate-session',
    role: 'behavior-verifier',
    result: {
      role: 'behavior-verifier',
      scopeChecked: ['logic.ts → renamed.ts'],
      facts: ['value changes from 1 to 2'],
      expectedTransitions: [],
      findings: [],
      counterevidence: [],
      unknowns: [],
      coverage: 'complete',
      recommendation: 'proceed',
      recommendationReason: 'Fixture contract matches',
    },
  };
}

describe('portable review pack', () => {
  it('pins committed base/head, includes both sides of rename and excludes uncommitted edits', () => {
    const f = fixture();
    const manifest = createReviewPack(f);
    expect(manifest.baseSha).toBe(f.base);
    expect(manifest.headSha).toBe(f.head);
    const sources = readFileSync(join(f.out, 'sources.json'), 'utf8');
    expect(sources).toContain('value = 1');
    expect(sources).toContain('value = 2');
    expect(sources).not.toContain('UNCOMMITTED');
    expect(manifest.changedPaths).toEqual(['logic.ts', 'renamed.ts']);
    expect(manifest.omissions.some((line: string) => line.includes('AGENTS.md'))).toBe(true);
    expect(readFileSync(join(f.out, 'behavior-verifier.prompt.md'), 'utf8')).toContain(f.head);
    expect(validateReview(f.out, envelope(manifest)).status).toBe('reviewed');
  });
  it('distinguishes unperformed, stale, partial and invalid from reviewed with zero findings', () => {
    const f = fixture();
    const manifest = createReviewPack(f);
    const result = envelope(manifest);
    expect(validateReview(f.out).status).toBe('not-run');
    expect(validateReview(f.out).findings).toBeNull();
    expect(validateReview(f.out, { ...result, headSha: f.base }).status).toBe('stale');
    expect(
      validateReview(f.out, {
        ...result,
        result: { ...result.result, coverage: 'partial', unknowns: ['caller not supplied'] },
      }).status,
    ).toBe('partial');
    expect(
      validateReview(f.out, { ...result, result: { ...result.result, scopeChecked: [] } }).status,
    ).toBe('invalid');
    expect(validateReview(f.out, { ...result, provider: '' }).status).toBe('invalid');
    expect(validateReview(f.out, {}).status).toBe('invalid');
    expect(
      validateReview(f.out, { ...result, result: { ...result.result, scopeChecked: ['  '] } })
        .status,
    ).toBe('invalid');
    expect(validateReview(f.out, { ...result, role: '__proto__' }).status).toBe('invalid');
    expect(validateReview(f.out, result).findings).toEqual([]);
  });
  it('binds the review to context and verification as well as commit SHAs', () => {
    const f = fixture();
    const old = createReviewPack(f);
    writeFileSync(f.context, '別の受け入れ条件');
    const nextOut = join(f.cwd, 'next');
    const next = createReviewPack({ ...f, out: nextOut });
    expect(next.packId).not.toBe(old.packId);
    expect(validateReview(nextOut, envelope(old)).status).toBe('stale');
    writeFileSync(join(nextOut, 'diff.patch'), 'tampered');
    expect(validateReview(nextOut, envelope(next)).status).toBe('invalid');
  });
  it('refuses to overwrite a previous pack', () => {
    const f = fixture();
    const old = createReviewPack(f);
    expect(() => createReviewPack(f)).toThrow();
    expect(validateReview(f.out, envelope(old)).status).toBe('reviewed');
  });
  it('refuses raw env source and context, including a context symlink', () => {
    const f = fixture();
    expect(() => createReviewPack({ ...f, sources: ['apps/product/.env.local'] })).toThrow(/env/);
    expect(() => createReviewPack({ ...f, sources: ['.envrc'] })).toThrow(/env/);
    expect(() => createReviewPack({ ...f, context: join(f.cwd, '.envrc') })).toThrow(/env/);
    writeFileSync(join(f.cwd, '.env.local'), 'DUMMY_ONLY=fixture');
    const alias = join(f.cwd, 'alias.md');
    symlinkSync('.env.local', alias);
    expect(() => createReviewPack({ ...f, context: alias })).toThrow(/env/);
  });
  it('rejects schema extensions rather than silently ignoring a constraint', () => {
    expect(schemaErrors({ type: 'string', pattern: '^safe$' }, 'unsafe')).not.toEqual([]);
    expect(
      schemaErrors(
        SCHEMAS['behavior-verifier'],
        envelope({ packId: '', baseSha: '', headSha: '' }).result,
      ),
    ).toEqual([]);
  });
  it('CLI exits nonzero for unperformed review; reviewed is transport validity, not a merge decision', () => {
    const f = fixture();
    const manifest = createReviewPack(f);
    const cli = resolve('scripts/tasks/review-pack.mjs');
    const unperformed = spawnSync(process.execPath, [cli, 'validate', '--pack', f.out], {
      encoding: 'utf8',
    });
    expect(unperformed.status).toBe(1);
    expect(JSON.parse(unperformed.stdout).status).toBe('not-run');
    const resultPath = join(f.cwd, 'result.json');
    writeFileSync(
      resultPath,
      JSON.stringify({
        ...envelope(manifest),
        result: { ...envelope(manifest).result, recommendation: 'halt' },
      }),
    );
    const reviewed = spawnSync(
      process.execPath,
      [cli, 'validate', '--pack', f.out, '--result', resultPath],
      { encoding: 'utf8' },
    );
    expect(reviewed.status).toBe(0);
    expect(JSON.parse(reviewed.stdout).recommendation).toBe('halt');
  });
});

// ---------------------------------------------------------------------------
// #2588: 契約の version 化と sweep 種別
// ---------------------------------------------------------------------------

/**
 * 契約変更より前に生成して凍結した PR pack。role を足しても既存 pack が
 * invalid にならないことを、再生成ではなく**当時のバイト列**で確かめる。
 * 中身を作り直すと「変更前と同じ結果か」を確かめたことにならないので、
 * このディレクトリは再生成しない。
 */
const FROZEN_PR_PACK = resolve(__dirname, '../__tests__/fixtures/review-pack-pr-v1');
const FROZEN = JSON.parse(readFileSync(join(FROZEN_PR_PACK, 'manifest.json'), 'utf8')) as {
  packId: string;
  baseSha: string;
  headSha: string;
  files: Record<string, string>;
};

function frozenEnvelope(over: Record<string, unknown> = {}) {
  return {
    packId: FROZEN.packId,
    baseSha: FROZEN.baseSha,
    headSha: FROZEN.headSha,
    provider: 'OpenAI',
    model: 'frozen-fixture',
    modelFamily: 'GPT',
    sessionId: 'frozen-fixture-session',
    independence: 'separate-session',
    role: 'behavior-verifier',
    result: {
      role: 'behavior-verifier',
      scopeChecked: ['logic.ts'],
      facts: ['value changes from 1 to 2'],
      expectedTransitions: [],
      findings: [],
      counterevidence: [],
      unknowns: [],
      coverage: 'complete',
      recommendation: 'proceed',
      recommendationReason: 'Frozen fixture contract matches',
    },
    ...over,
  };
}

describe('#2588: 契約変更に対する後方互換（凍結した PR pack）', () => {
  it('kind を持たない manifest を pr / contractVersion 1 として読む', () => {
    expect(FROZEN).not.toHaveProperty('kind');
    expect(validateReview(FROZEN_PR_PACK, undefined).status).toBe('not-run');
  });

  it('pr v1 の artifact 集合は凍結時のまま。role 追加で件数が動かない', () => {
    expect([...packArtifacts('pr', 1)!].sort()).toEqual(Object.keys(FROZEN.files).sort());
    // sweep の role が pr の artifact 集合へ混ざらない。
    expect([...packArtifacts('pr', 1)!].join(' ')).not.toContain('security-');
  });

  it('凍結 pack が not-run / reviewed / stale / invalid を変更前と同じに返す', () => {
    expect(validateReview(FROZEN_PR_PACK, undefined).status).toBe('not-run');
    expect(validateReview(FROZEN_PR_PACK, frozenEnvelope()).status).toBe('reviewed');
    expect(validateReview(FROZEN_PR_PACK, frozenEnvelope({ headSha: 'f'.repeat(40) })).status).toBe(
      'stale',
    );
    expect(
      validateReview(FROZEN_PR_PACK, frozenEnvelope({ result: { role: 'behavior-verifier' } }))
        .status,
    ).toBe('invalid');
  });

  it('未知の kind / contractVersion は fail closed で invalid（前方互換は開けない）', () => {
    expect(packArtifacts('sweep', 99)).toBeNull();
    expect(packArtifacts('unknown-kind', 1)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'dayopt-unknown-pack-'));
    dirs.push(dir);
    const body = { ...FROZEN, kind: 'unknown-kind' };
    delete (body as { packId?: string }).packId;
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...body, packId: FROZEN.packId }, null, 2),
    );
    expect(validateReview(dir, undefined).status).toBe('invalid');
  });
});

function sweepFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'dayopt-sweep-pack-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Sweep Fixture');
  git('config', 'user.email', 'sweep@example.invalid');
  execFileSync('mkdir', ['-p', join(cwd, 'auth')]);
  writeFileSync(join(cwd, 'auth/token.ts'), 'export const verify = () => true;\n');
  writeFileSync(join(cwd, 'auth/session.ts'), 'export const cache = new Map();\n');
  writeFileSync(join(cwd, 'unrelated.ts'), 'export const noise = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'scope');
  const at = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'auth/token.ts'), 'UNCOMMITTED - must not enter the sweep\n');
  const context = join(cwd, 'context.md');
  const threatModel = join(cwd, 'threat-model.md');
  writeFileSync(context, 'scope: 認証境界。除外: 課金。\n');
  writeFileSync(threatModel, '# 信頼境界\n- 未認証の外部\n');
  const out = join(cwd, 'sweep');
  return { cwd, at, context, threatModel, out };
}

const uuid = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;
/** envelope を一時ファイルへ書いて path を返す（CLI 経由の test 用）。 */
function writeEnvelope(cwd: string, name: string, envelopeValue: unknown) {
  const path = join(cwd, name);
  writeFileSync(path, JSON.stringify(envelopeValue, null, 2));
  return path;
}

/** candidateSet の存在自体を検証しつつ narrowing する（省略されていれば test を落とす）。 */
function candidateSetOf(result: ReturnType<typeof validateReview>) {
  expect(result.candidateSet).toBeDefined();
  return result.candidateSet!;
}

function sweepEnvelope(
  manifest: { packId: string; targetSha: string },
  role: string,
  result: Record<string, unknown>,
) {
  return {
    packId: manifest.packId,
    targetSha: manifest.targetSha,
    provider: 'OpenAI',
    model: 'sweep-fixture',
    modelFamily: 'GPT',
    sessionId: 'sweep-fixture-session',
    independence: 'separate-session',
    role,
    result: { role, ...result },
  };
}

function researcherResult(count: number) {
  return {
    scopeChecked: ['auth/token.ts'],
    facts: ['verify は常に true を返す'],
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateId: uuid(index + 1),
      title: `候補 ${index + 1}`,
      class: 'authz',
      target: `auth/token.ts:${index + 1}`,
      scenario: '未認証の呼び出しが通る',
      evidence: 'verify() が引数を見ていない',
    })),
    counterevidence: [],
    unknowns: [],
    coverage: 'complete',
    summary: 'scope を一周した',
  };
}

function criticVerdict(index: number, over: Record<string, unknown> = {}) {
  return {
    candidateId: uuid(index),
    verdict: 'rejected',
    reasoning: '呼び出し元が別途検証している',
    counterevidence: 'auth/session.ts が事前に検証する',
    reachability: 'unreachable',
    ...over,
  };
}

describe('#2588: 合流と emit の安全性（cross-review 由来）', () => {
  // behavior-verifier(claude-opus-5) P2: 合流時に results[0] だけを採ると、
  // 反証側の halt が黙って落ちて合流が結論を薄める方向に働く。
  it('PR envelope を合流させた時、recommendation は重い方を採る', () => {
    const f = fixture();
    const manifest = createReviewPack(f);
    const proceed = envelope(manifest);
    const halt = {
      ...envelope(manifest),
      sessionId: 'counter-review',
      result: { ...envelope(manifest).result, recommendation: 'halt' },
    };

    expect(validateReview(f.out, [proceed, halt]).recommendation).toBe('halt');
    expect(validateReview(f.out, [halt, proceed]).recommendation).toBe('halt');
    expect(validateReview(f.out, [proceed]).recommendation).toBe('proceed');
  });

  // behavior-verifier(claude-opus-5) P2: 分割実行を 1 本ずつ検証すると、後の round の
  // 候補集合が前の round を黙って置き換える。合流は --result を並べて 1 回で行う。
  it('--emit-candidates は既存の候補ファイルを上書きしない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const researcher = sweepEnvelope(manifest, 'security-researcher', researcherResult(2));
    const emit = join(cwd, 'candidates.json');
    const run = () =>
      spawnSync(
        process.execPath,
        [
          resolve(__dirname, 'review-pack.mjs'),
          'validate',
          '--pack',
          out,
          '--result',
          writeEnvelope(cwd, 'researcher.json', researcher),
          '--emit-candidates',
          emit,
        ],
        { encoding: 'utf8' },
      );

    const first = run();
    expect(first.status).toBe(0);
    expect(JSON.parse(readFileSync(emit, 'utf8')).candidates).toHaveLength(2);

    const second = run();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('review pack');
    // 1 本目の候補が残っている（後の round に置き換わっていない）。
    expect(JSON.parse(readFileSync(emit, 'utf8')).candidates).toHaveLength(2);
  });
});

describe('#2588: security sweep pack', () => {
  it('scope の committed snapshot だけを固定し、diff も未コミット編集も持たない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });

    expect(manifest.kind).toBe('sweep');
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.targetSha).toBe(at);
    expect(manifest).not.toHaveProperty('baseSha');
    expect(manifest).not.toHaveProperty('headSha');
    // ディレクトリ指定は対象 SHA の tree から展開し、scope 外は入らない。
    expect(manifest.scopePaths).toEqual(['auth/session.ts', 'auth/token.ts']);
    const sources = readFileSync(join(out, 'sources.json'), 'utf8');
    expect(sources).toContain('export const verify');
    expect(sources).not.toContain('UNCOMMITTED');
    expect(sources).not.toContain('noise');
    expect([...packArtifacts('sweep', 1)!].sort()).toEqual(Object.keys(manifest.files).sort());
  });

  it('scope が対象 SHA のどのファイルにも一致しなければ pack を作らない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    expect(() =>
      createSweepPack({ cwd, at, scope: ['does-not-exist'], context, threatModel, out }),
    ).toThrow();
  });

  it('researcher の候補集合から candidateSetHash を生成側で導出する', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const result = validateReview(
      out,
      sweepEnvelope(manifest, 'security-researcher', researcherResult(2)),
    );

    expect(result.status).toBe('reviewed');
    const candidateSet = candidateSetOf(result);
    expect(candidateSet.candidates).toHaveLength(2);
    expect(candidateSet.candidateSetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PR envelope を sweep pack へ流用できない（種別の取り違えを落とす）', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const reused = {
      ...sweepEnvelope(manifest, 'security-researcher', researcherResult(1)),
      baseSha: manifest.targetSha,
      headSha: manifest.targetSha,
    };
    expect(validateReview(out, reused).status).toBe('invalid');
    // 逆向き: sweep role は PR pack の契約に無い。
    expect(
      validateReview(FROZEN_PR_PACK, frozenEnvelope({ role: 'security-researcher' })).status,
    ).toBe('invalid');
  });

  it('critic が全候補に判定を返せば reviewed、欠けていれば未判定 id つきで partial', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(3))),
    );
    const critic = (verdicts: unknown[]) =>
      sweepEnvelope(manifest, 'security-critic', {
        candidateSetHash: candidateSet.candidateSetHash,
        scopeChecked: ['auth/token.ts'],
        verdicts,
        unknowns: [],
        coverage: 'complete',
        summary: '候補を裁定した',
      });

    const partial = validateReview(out, critic([criticVerdict(1)]), { candidates: candidateSet });
    expect(partial.status).toBe('partial');
    expect(candidateSetOf(partial).missing).toEqual([uuid(2), uuid(3)]);

    const full = validateReview(
      out,
      critic([criticVerdict(1), criticVerdict(2), criticVerdict(3)]),
      { candidates: candidateSet },
    );
    expect(full.status).toBe('reviewed');
    expect(candidateSetOf(full).missing).toEqual([]);
    expect(candidateSetOf(full).settled).toBe(3);
  });

  it('中断・再開: 分割した critic envelope を合流させても未判定候補が消えない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(3))),
    );
    const critic = (verdicts: unknown[], coverage = 'partial') =>
      sweepEnvelope(manifest, 'security-critic', {
        candidateSetHash: candidateSet.candidateSetHash,
        scopeChecked: ['auth/token.ts'],
        verdicts,
        unknowns: [],
        coverage,
        summary: '分割実行',
      });

    const firstRound = critic([criticVerdict(1)]);
    expect(
      candidateSetOf(validateReview(out, firstRound, { candidates: candidateSet })).missing,
    ).toEqual([uuid(2), uuid(3)]);

    const merged = validateReview(
      out,
      [firstRound, critic([criticVerdict(2), criticVerdict(3)], 'complete')],
      { candidates: candidateSet },
    );
    // 1 本目が coverage=partial を申告しているので partial のままだが、
    // 判定そのものは 3 件そろい、未判定 id は残らない。
    expect(merged.status).toBe('partial');
    expect(candidateSetOf(merged).missing).toEqual([]);
    expect(candidateSetOf(merged).settled).toBe(3);
    expect(merged.reasons).toContain('reviewer が coverage=partial を申告');
  });

  it('別 run の候補集合・集合外 id・食い違う判定をそれぞれ別の理由で落とす', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(2))),
    );
    const critic = (over: Record<string, unknown>) =>
      sweepEnvelope(manifest, 'security-critic', {
        candidateSetHash: candidateSet.candidateSetHash,
        scopeChecked: ['auth/token.ts'],
        verdicts: [criticVerdict(1), criticVerdict(2)],
        unknowns: [],
        coverage: 'complete',
        summary: '裁定',
        ...over,
      });

    expect(
      validateReview(out, critic({ candidateSetHash: 'a'.repeat(64) }), {
        candidates: candidateSet,
      }).errors?.[0],
    ).toContain('別 run の候補集合');

    expect(
      validateReview(
        out,
        critic({
          verdicts: [
            criticVerdict(1),
            criticVerdict(2),
            { ...criticVerdict(2), candidateId: uuid(9) },
          ],
        }),
        { candidates: candidateSet },
      ).errors?.[0],
    ).toContain('候補集合に無い candidateId');

    expect(
      validateReview(
        out,
        critic({
          verdicts: [
            criticVerdict(1),
            criticVerdict(2),
            criticVerdict(1, { verdict: 'confirmed' }),
          ],
        }),
        { candidates: candidateSet },
      ).errors?.[0],
    ).toContain('食い違う判定');

    // candidates ファイル無しでの検証は「判定できた」ことにしない。
    expect(validateReview(out, critic({})).status).toBe('invalid');
  });

  // クロスレビュー（risk-reviewer, GPT-5.6）の P1: reproducer を全候補と突き合わせると、
  // confirmed / rejected 済みの候補が未判定として残り、正常な sweep が reviewed へ到達しない。
  it('reproducer は critic の needs-execution 部分集合だけを母集合にする', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(3))),
    );
    const critic = validateReview(
      out,
      sweepEnvelope(manifest, 'security-critic', {
        candidateSetHash: candidateSet.candidateSetHash,
        scopeChecked: ['auth/token.ts'],
        verdicts: [
          criticVerdict(1, { verdict: 'confirmed', reachability: 'reachable' }),
          criticVerdict(2),
          criticVerdict(3, {
            verdict: 'needs-execution',
            reachability: 'unknown',
            executionRequest: 'pnpm test:integration auth-token',
            expectedEvidence: '未認証の呼び出しが 200 を返すこと',
          }),
        ],
        unknowns: [],
        coverage: 'complete',
        summary: '裁定した',
      }),
      { candidates: candidateSet },
    );
    expect(critic.status).toBe('reviewed');

    // critic の検証が実行待ち集合を返す。母集合は 3 件ではなく 1 件。
    const pending = candidateSetOf(critic);
    expect(pending.candidateSetHash).toBe(candidateSet.candidateSetHash);
    expect(pending.candidates?.map((candidate) => candidate.candidateId)).toEqual([uuid(3)]);

    const reproducerEnvelope = sweepEnvelope(manifest, 'security-reproducer', {
      candidateSetHash: candidateSet.candidateSetHash,
      isolation: 'worktree + local Supabase 127.0.0.1',
      attempts: [
        {
          candidateId: uuid(3),
          status: 'reproduced',
          reachedTargetPath: 'yes',
          command: 'pnpm test:integration auth-token',
          testPath: 'apps/product/src/lib/test/integration/auth-token.integration.test.ts',
          evidence: '未認証の呼び出しが 200 を返した',
        },
      ],
      unknowns: [],
      coverage: 'complete',
      summary: '実行待ちの 1 件を再現した',
    });

    // 実行待ち集合を母集合にすれば reviewed。
    expect(validateReview(out, reproducerEnvelope, { candidates: pending }).status).toBe(
      'reviewed',
    );

    // 全候補を母集合にすると、実行の必要が無い 2 件が未判定として残り partial になる。
    const againstAll = validateReview(out, reproducerEnvelope, { candidates: candidateSet });
    expect(againstAll.status).toBe('partial');
    expect(candidateSetOf(againstAll).missing).toEqual([uuid(1), uuid(2)]);
  });

  // クロスレビュー（risk-reviewer, GPT-5.6）の P2: reachedTargetPath は自己申告なので、
  // それだけを根拠にすると実行していない negative を「再現せず」と記録できてしまう。
  it.each([
    ['reproduced', 'yes'],
    ['failed-to-reproduce', 'yes'],
  ])('%s は command と testPath の提示を要求する（自己申告だけで通さない）', (status, reached) => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(1))),
    );
    const reproducer = (attempt: Record<string, unknown>) =>
      validateReview(
        out,
        sweepEnvelope(manifest, 'security-reproducer', {
          candidateSetHash: candidateSet.candidateSetHash,
          isolation: 'worktree + local Supabase 127.0.0.1',
          attempts: [
            {
              candidateId: uuid(1),
              status,
              reachedTargetPath: reached,
              evidence: '出力の要点',
              ...attempt,
            },
          ],
          unknowns: [],
          coverage: 'complete',
          summary: '再現を試みた',
        }),
        { candidates: candidateSet },
      );

    expect(reproducer({}).errors).toEqual([
      `attempts[0]: ${status} には実行した command が要る`,
      `attempts[0]: ${status} には再現を書いた test の path が要る`,
    ]);
    expect(reproducer({ command: 'pnpm test:integration x' }).errors).toEqual([
      `attempts[0]: ${status} には再現を書いた test の path が要る`,
    ]);
    expect(
      reproducer({ command: 'pnpm test:integration x', testPath: 'a/b.integration.test.ts' })
        .status,
    ).toBe('reviewed');
  });

  it('not-run / environment-missing / statically-confirmed には command を求めない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(3))),
    );
    const result = validateReview(
      out,
      sweepEnvelope(manifest, 'security-reproducer', {
        candidateSetHash: candidateSet.candidateSetHash,
        isolation: 'worktree + local Supabase 127.0.0.1',
        attempts: [
          {
            candidateId: uuid(1),
            status: 'not-run',
            reachedTargetPath: 'no',
            evidence: 'setup が exit 127 で落ちた',
          },
          {
            candidateId: uuid(2),
            status: 'environment-missing',
            reachedTargetPath: 'unknown',
            evidence: 'ローカル Supabase が未起動',
          },
          {
            candidateId: uuid(3),
            status: 'statically-confirmed',
            reachedTargetPath: 'unknown',
            evidence: 'source だけで自明',
          },
        ],
        unknowns: [],
        coverage: 'complete',
        summary: '実行できなかった理由を分けた',
      }),
      { candidates: candidateSet },
    );
    // statically-confirmed だけが裁定済み。not-run と environment-missing は未決。
    expect(result.status).toBe('partial');
    expect(candidateSetOf(result).settled).toBe(1);
    expect(candidateSetOf(result).unsettled).toEqual([uuid(1), uuid(2)]);
  });

  // クロスレビュー（behavior-verifier, claude-opus-5）の P2: id が入っていれば
  // 値に関わらず判定済みに数えていたため、全件 undetermined の critic が reviewed になった。
  it('全候補を undetermined にした critic を reviewed にしない', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(2))),
    );
    const result = validateReview(
      out,
      sweepEnvelope(manifest, 'security-critic', {
        candidateSetHash: candidateSet.candidateSetHash,
        scopeChecked: ['auth/token.ts'],
        verdicts: [
          criticVerdict(1, { verdict: 'undetermined', reachability: 'unknown' }),
          criticVerdict(2, { verdict: 'undetermined', reachability: 'unknown' }),
        ],
        unknowns: ['資料が足りない'],
        coverage: 'complete',
        summary: '決められなかった',
      }),
      { candidates: candidateSet },
    );
    expect(result.status).toBe('partial');
    expect(candidateSetOf(result).settled).toBe(0);
    expect(candidateSetOf(result).unsettled).toEqual([uuid(1), uuid(2)]);
    expect(result.reasons?.some((reason) => reason.includes('裁定が決まっていない'))).toBe(true);
  });

  it('到達証拠のない再現失敗を reproducer envelope の段階で落とす', () => {
    const { cwd, at, context, threatModel, out } = sweepFixture();
    const manifest = createSweepPack({ cwd, at, scope: ['auth'], context, threatModel, out });
    const candidateSet = candidateSetOf(
      validateReview(out, sweepEnvelope(manifest, 'security-researcher', researcherResult(1))),
    );
    const reproducer = (attempt: Record<string, unknown>) =>
      sweepEnvelope(manifest, 'security-reproducer', {
        candidateSetHash: candidateSet.candidateSetHash,
        isolation: 'worktree + local Supabase 127.0.0.1',
        attempts: [{ candidateId: uuid(1), evidence: 'setup が失敗した', ...attempt }],
        unknowns: [],
        coverage: 'complete',
        summary: '再現を試みた',
      });

    const bogus = validateReview(
      out,
      reproducer({ status: 'failed-to-reproduce', reachedTargetPath: 'unknown' }),
      { candidates: candidateSet },
    );
    expect(bogus.status).toBe('invalid');
    expect(bogus.errors?.[0]).toContain('到達証拠のない失敗');

    // 環境が揃わなかったのは正直な申告だが、裁定は決まっていないので reviewed にしない。
    const honest = validateReview(
      out,
      reproducer({ status: 'environment-missing', reachedTargetPath: 'unknown' }),
      { candidates: candidateSet },
    );
    expect(honest.status).toBe('partial');
    expect(candidateSetOf(honest).unsettled).toEqual([uuid(1)]);
  });
});
