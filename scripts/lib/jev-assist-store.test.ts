import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateWithJev, jevCacheKey, type JevRequest } from './jev-adapter.ts';
import { evaluateAssist, jevStoreRoot } from './jev-assist-store.ts';

const request: JevRequest = {
  questionSetId: 'test-v1',
  state: { sha: 'a', text: 'evidence' },
  questions: {
    value: {
      type: 'boolean',
      instructions: 'Is there evidence?',
      criteria: { true: 'yes', false: 'no' },
    },
  },
};
const temporary = () => mkdtempSync(join(tmpdir(), 'dayopt-jev-assist-'));
async function evaluator() {
  const annotation = await evaluateWithJev(request, { disabled: true });
  return vi.fn(async (input: JevRequest) => ({
    ...annotation,
    cacheKey: jevCacheKey(input),
    status: 'evaluated' as const,
    reasonCode: 'ok' as const,
    answers: {
      value: { type: 'boolean' as const, probability: 0.9, confidence: null, topProbability: 0.9 },
    },
  }));
}

describe('共通保存と待たない送信制御', () => {
  it('キャッシュの回答型が壊れていたら評価済みとして使わない', async () => {
    const root = temporary();
    const annotation = await (await evaluator())(request);
    mkdirSync(join(root, 'annotations'));
    writeFileSync(
      join(root, 'annotations', `${jevCacheKey(request)}.json`),
      JSON.stringify({ ...annotation, answers: { value: { type: 'boolean', probability: 99 } } }),
    );
    expect((await evaluateAssist(request, { root, allowNetwork: false })).reason).toBe(
      'cache_invalid',
    );
  });
  it('同時実行は1件しか送信せず、SHAの違う入力はキャッシュを使わない', async () => {
    const evaluate = await evaluator();
    const root = temporary();
    const options = {
      root,
      allowNetwork: true,
      credentialAvailable: true,
      now: () => 90_000,
      evaluate,
    };
    const results = await Promise.all([
      evaluateAssist(request, options),
      evaluateAssist({ ...request, state: { sha: 'b' } }, options),
    ]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.reason)).toContain('cooldown');
    expect((await evaluateAssist(request, { ...options, allowNetwork: false })).source).toBe(
      'cache',
    );
    expect(
      (
        await evaluateAssist(
          { ...request, state: { sha: 'b' } },
          { ...options, allowNetwork: false },
        )
      ).reason,
    ).toBe('not_cached');
  });

  it('分の境界をまたいでも60秒を守る', async () => {
    const evaluate = await evaluator();
    const options = { root: temporary(), allowNetwork: true, credentialAvailable: true, evaluate };
    await evaluateAssist(request, { ...options, now: () => 119_999 });
    const other = { ...request, state: { sha: 'b' } };
    expect((await evaluateAssist(other, { ...options, now: () => 120_000 })).reason).toBe(
      'cooldown',
    );
    expect((await evaluateAssist(other, { ...options, now: () => 179_999 })).source).toBe('live');
  });

  it('429を自動再試行せず、次の明示呼び出しでは再評価できる', async () => {
    const evaluate = await evaluator();
    const failed = await evaluateWithJev(request, { disabled: true });
    evaluate.mockResolvedValueOnce({
      ...failed,
      reasonCode: 'rate_limited',
      status: 'unavailable',
      answers: null,
    } as never);
    const options = { root: temporary(), allowNetwork: true, credentialAvailable: true, evaluate };
    expect((await evaluateAssist(request, { ...options, now: () => 60_000 })).reason).toBe(
      'rate_limited',
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((await evaluateAssist(request, { ...options, now: () => 120_000 })).source).toBe('live');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('資格情報不在・停止・入力超過は送信しない', async () => {
    const evaluate = await evaluator();
    const options = { root: temporary(), allowNetwork: true, credentialAvailable: false, evaluate };
    expect((await evaluateAssist(request, options)).reason).toBe('missing_credentials');
    expect((await evaluateAssist(request, { ...options, disabled: true })).reason).toBe('disabled');
    expect(
      (await evaluateAssist({ ...request, state: { text: 'x'.repeat(33_000) } }, options)).reason,
    ).toBe('input_too_large');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('worktreeが消えても注釈は共通git directoryに残る', async () => {
    const repo = temporary();
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ]);
    const worktree = join(temporary(), 'linked');
    git(['worktree', 'add', '--detach', worktree]);
    const root = jevStoreRoot(worktree);
    expect(root).toBe(jevStoreRoot(repo));
    await evaluateAssist(request, {
      root,
      allowNetwork: true,
      credentialAvailable: true,
      evaluate: await evaluator(),
    });
    git(['worktree', 'remove', worktree]);
    expect((await evaluateAssist(request, { root, allowNetwork: false })).source).toBe('cache');
  });

  it('壊れた送信状態はfail closed', async () => {
    const root = temporary();
    mkdirSync(join(root, 'send-slots'));
    writeFileSync(join(root, 'send-slots', '1.json'), '{bad');
    expect(
      (
        await evaluateAssist(request, {
          root,
          allowNetwork: true,
          credentialAvailable: true,
          now: () => 120_000,
          evaluate: await evaluator(),
        })
      ).reason,
    ).toBe('rate_state_unreadable');
  });

  it('他processが予約中なら分境界を跨いでも待たず送信しない', async () => {
    const root = temporary();
    mkdirSync(join(root, 'send-slots'));
    writeFileSync(
      join(root, 'send-slots', 'reservation.lock'),
      JSON.stringify({ reservedAt: 119_999 }),
    );
    const evaluate = await evaluator();
    expect(
      (
        await evaluateAssist(request, {
          root,
          allowNetwork: true,
          credentialAvailable: true,
          now: () => 120_000,
          evaluate,
        })
      ).reason,
    ).toBe('rate_locked');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
