import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_REVIEW_MARKER,
  REVIEWER_LOGIN,
  evaluateReviewPolicy,
} from '../lib/review-policy.mjs';
import { createValidationPlan } from '../lib/validation-plan.mjs';
import {
  buildResultComment,
  buildReviewPayload,
  normalizeFindings,
  parseCommentableLines,
  run,
  sanitizeText,
} from './claude-review-post.mjs';

const HEAD = 'f57bf894e78e4bec945b48de4386949f95fcc95c';
const BASE = 'b'.repeat(40);
const REPO = 'Dayopt/dayopt';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ export function a() {',
  '   const x = 1;',
  '-  const y = 2;',
  '+  const y = 3;',
  '+  const z = 4;',
  '   return x;',
  'diff --git a/src/removed.ts b/src/removed.ts',
  'deleted file mode 100644',
  '--- a/src/removed.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-gone',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const n = 1;',
  '+// --- not a header',
  '',
].join('\n');

const finding = (patch: Record<string, unknown> = {}) => ({
  path: 'src/a.ts',
  line: 11,
  severity: 'P1',
  title: '値が変わる',
  body: '条件 / 原因 / 修正',
  ...patch,
});

describe('parseCommentableLines', () => {
  it('collects added and context lines on the right side only', () => {
    const lines = parseCommentableLines(DIFF);
    expect([...(lines.get('src/a.ts') ?? [])]).toEqual([10, 11, 12, 13]);
    expect([...(lines.get('src/new.ts') ?? [])]).toEqual([1, 2]);
    expect(lines.has('src/removed.ts')).toBe(false);
  });
});

describe('normalizeFindings / sanitizeText', () => {
  it('rejects output that does not match the schema', () => {
    expect(normalizeFindings(null)).toBe(null);
    expect(normalizeFindings({ summary: 'x' })).toBe(null);
    expect(normalizeFindings({ findings: [finding({ severity: 'P3' })] })).toBe(null);
  });

  it('cannot forge the marker or mention people', () => {
    const text = sanitizeText(`${CLAUDE_REVIEW_MARKER}\nResult: completed <!-- x --> @t3-nico`);
    expect(text).not.toContain('<!--');
    expect(text).not.toMatch(/@t3-nico/);
  });
});

describe('buildReviewPayload', () => {
  it('puts findings on diff lines inline and the rest into the body', () => {
    const findings = normalizeFindings({
      summary: 'まとめ',
      findings: [finding(), finding({ line: 99, severity: 'P2' }), finding({ line: 0 })],
    });
    const payload = buildReviewPayload({
      findings: findings!,
      sha: HEAD,
      commentable: parseCommentableLines(DIFF),
    });
    expect(payload.commit_id).toBe(HEAD);
    expect(payload.event).toBe('COMMENT');
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({ path: 'src/a.ts', line: 11, side: 'RIGHT' });
    expect(payload.comments[0].body).toContain(CLAUDE_REVIEW_MARKER);
    expect(payload.comments[0].body).toContain('![P1 Badge]');
    expect(payload.body).toContain(`**Reviewed commit:** \`${HEAD}\``);
    expect(payload.body).toContain('`src/a.ts:99`');
    expect(payload.body).toContain('指摘 3 件。');
  });
});

/** gh の呼び出しを記録し、POST の payload（--input の file）を読み戻す fake。 */
function fakeGh({ failReviewOnce = false } = {}) {
  const posts: { path: string; payload: Record<string, unknown> }[] = [];
  let reviewFailures = failReviewOnce ? 1 : 0;
  const gh = (args: string[]) => {
    if (args.includes('Accept: application/vnd.github.diff')) {
      expect(args[1]).toBe(`repos/${REPO}/compare/${BASE}...${HEAD}`);
      return DIFF;
    }
    const path = args[3];
    const payload = JSON.parse(readFileSync(args[5], 'utf8'));
    if (path.endsWith('/reviews') && reviewFailures > 0) {
      reviewFailures -= 1;
      throw new Error('HTTP 422');
    }
    posts.push({ path, payload });
    return JSON.stringify({ html_url: `https://github.com/${REPO}/pull/7#x` });
  };
  return { gh, posts };
}

const argv = (outcome = 'success') => [
  '--pr',
  '7',
  '--sha',
  HEAD,
  '--base',
  BASE,
  '--outcome',
  outcome,
  '--run-url',
  'https://github.com/run/1',
];

describe('run', () => {
  it('posts the review and a completed result comment that the review policy accepts', () => {
    const { gh, posts } = fakeGh();
    const output = JSON.stringify({ summary: '', findings: [finding()] });
    const result = run({
      argv: argv(),
      env: { GITHUB_REPOSITORY: REPO, CLAUDE_REVIEW_OUTPUT: output },
      gh,
    });
    expect(result).toEqual({ result: 'completed', findings: 1, inline: 1 });
    expect(posts.map((post) => post.path)).toEqual([
      `repos/${REPO}/pulls/7/reviews`,
      `repos/${REPO}/issues/7/comments`,
    ]);

    // 投稿した形を review policy へ通し、現 head の完了証拠として読まれることを確かめる
    const plan = createValidationPlan(
      {
        repository: REPO,
        prNumber: 7,
        headSha: HEAD,
        baseSha: BASE,
        testSha: 'c'.repeat(40),
        policySha: BASE,
        event: 'pull_request',
        diff: {
          complete: true,
          files: ['apps/product/src/lib/billing/a.ts'],
          hash: 'd'.repeat(64),
        },
      },
      { graph: new Map() },
    );
    const review = posts[0].payload as { body: string; commit_id: string };
    const comment = posts[1].payload as { body: string };
    const policy = evaluateReviewPolicy({
      plan,
      evidence: {
        headSha: HEAD,
        headCommittedAt: '2026-09-16T10:00:00Z',
        pr: { number: 7, state: 'open', draft: false },
        reviews: [
          {
            id: 1,
            authorLogin: REVIEWER_LOGIN,
            authorType: 'Bot',
            state: 'COMMENTED',
            commitId: review.commit_id,
            submittedAt: '2026-09-16T11:00:00Z',
            htmlUrl: 'r',
            body: review.body,
          },
        ],
        comments: [
          {
            id: 2,
            authorLogin: REVIEWER_LOGIN,
            authorType: 'Bot',
            body: comment.body,
            createdAt: '2026-09-16T11:00:01Z',
            htmlUrl: 'c',
          },
        ],
        threads: [],
      },
      now: new Date('2026-09-16T11:05:00Z'),
      validationVerdict: 'satisfied',
    });
    expect(policy.state).toBe('complete');
  });

  it('falls back to a body-only review when GitHub rejects the inline lines', () => {
    const { gh, posts } = fakeGh({ failReviewOnce: true });
    run({
      argv: argv(),
      env: {
        GITHUB_REPOSITORY: REPO,
        CLAUDE_REVIEW_OUTPUT: JSON.stringify({ summary: '', findings: [finding()] }),
      },
      gh,
    });
    const review = posts[0].payload as { comments: unknown[]; body: string };
    expect(review.comments).toEqual([]);
    expect(review.body).toContain('`src/a.ts:11`');
  });

  it.each([
    ['failure', JSON.stringify({ summary: '', findings: [] }), /outcome: failure/],
    ['success', '', /missing or not JSON/],
    ['success', JSON.stringify({ findings: 'x' }), /schema/],
  ])('posts a failed result when outcome=%s', (outcome, output, reason) => {
    const { gh, posts } = fakeGh();
    const result = run({
      argv: argv(outcome),
      env: { GITHUB_REPOSITORY: REPO, CLAUDE_REVIEW_OUTPUT: output },
      gh,
    });
    expect(result.result).toBe('failed');
    expect(posts).toHaveLength(1);
    const body = (posts[0].payload as { body: string }).body;
    expect(body).toContain('Result: failed');
    expect(body).toMatch(reason);
  });

  it('refuses to run without a full head and base SHA', () => {
    const { gh } = fakeGh();
    expect(() =>
      run({
        argv: ['--pr', '7', '--sha', 'abc', '--base', BASE],
        env: { GITHUB_REPOSITORY: REPO },
        gh,
      }),
    ).toThrow(/required/);
  });
});

describe('buildResultComment', () => {
  it('records the reviewed commit and result on separate lines', () => {
    expect(buildResultComment({ sha: HEAD, result: 'completed', findings: 2 })).toBe(
      `${CLAUDE_REVIEW_MARKER}\n**Reviewed commit:** \`${HEAD}\`\nResult: completed\nFindings: 2`,
    );
  });
});
