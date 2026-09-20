import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import {
  claimsInputSchema,
  type ClaimsInput,
  type ContextCandidate,
  type ContextInput,
  type Evidence,
} from './jev-assist-packs.ts';
import { defaultGhApi, type GhApi } from './jev-gh-prs.ts';

export const ASSIST_REPO = 'Dayopt/dayopt';
const base = `https://github.com/${ASSIST_REPO}`;

export function assertPublicRepository(api: GhApi = defaultGhApi): void {
  const repo = z
    .object({ full_name: z.literal(ASSIST_REPO), private: z.literal(false) })
    .safeParse(api(`repos/${ASSIST_REPO}`));
  if (!repo.success) throw new Error('Dayopt/dayopt が公開repositoryであることを確認できない');
}

const itemSchema = z
  .object({
    number: z.number().optional(),
    id: z.number().optional(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    html_url: z.string().optional(),
    issue_url: z.string().optional(),
    updated_at: z.string().optional(),
    updatedAt: z.string().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
const sourceSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  updatedAt: z.string().nullable(),
  comments: z.array(itemSchema).nullable(),
  related: z.array(itemSchema),
  decisions: z.array(z.string()),
  missing: z.array(z.string()).default([]),
});

export function contextFromSource(number: number, sha: string, raw: unknown): ContextInput {
  const source = sourceSchema.parse(raw);
  const candidates: ContextCandidate[] = [];
  candidates.push({
    id: `issue-${number}`,
    kind: 'issue',
    text: `${source.title}\n${source.body}`,
    url: source.url,
    updatedAt: source.updatedAt ?? '',
  });
  for (const comment of source.comments ?? []) {
    if (comment.id === undefined) continue;
    candidates.push({
      id: `comment-${comment.id}`,
      kind: 'comment',
      text: comment.body ?? '',
      url: `${base}/issues/${number}#issuecomment-${comment.id}`,
      updatedAt: comment.updated_at ?? comment.created_at ?? '',
    });
  }
  for (const related of source.related) {
    if (related.number === undefined) continue;
    candidates.push({
      id: `related-${related.number}`,
      kind: 'related',
      text: `${related.title ?? ''}\n${related.body ?? ''}`,
      url: `${base}/issues/${related.number}`,
      updatedAt: related.updated_at ?? related.updatedAt ?? related.created_at ?? '',
    });
  }
  source.decisions.forEach((text, index) =>
    candidates.push({
      id: `decision-${index}`,
      kind: 'decision',
      text,
      url: `${base}/blob/${sha}/docs/decisions.md`,
      updatedAt: /\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? '',
    }),
  );
  return {
    number,
    sha,
    title: source.title,
    body: source.body,
    url: source.url,
    candidates,
    missing: [...source.missing, ...(source.comments === null ? ['comments_unavailable'] : [])],
  };
}

export async function collectAssistContext(
  number: number,
  cwd = process.cwd(),
  api: GhApi = defaultGhApi,
): Promise<ContextInput> {
  assertPublicRepository(api);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  // Do not send local unpublished code / decision records.
  z.object({ sha: z.literal(sha) }).parse(api(`repos/${ASSIST_REPO}/commits/${sha}`));
  const ctx = await import('../tasks/ctx.mjs');
  let decisionsUnavailable = false;
  const pack = ctx.buildContextPack(
    { ...ctx.parseArgs([String(number)]), assist: true },
    {
      cwd,
      readFileImpl: (path: string) => {
        if (!path.endsWith('/docs/decisions.md')) throw new Error('対象外の資料');
        try {
          return execFileSync('git', ['show', `${sha}:docs/decisions.md`], {
            cwd,
            encoding: 'utf8',
          });
        } catch {
          decisionsUnavailable = true;
          throw new Error('公開decision資料を取得できない');
        }
      },
    },
  );
  const input = contextFromSource(number, sha, pack.assistSource);
  if (decisionsUnavailable) input.missing.push('decisions_unavailable');
  return input;
}

type EvidenceEndpoint = {
  endpoint: string;
  kind: 'text' | 'run';
  resource?: 'issues' | 'pull';
  number?: number;
  commentId?: number;
};

/** Accept only supported URLs from this public repository, never arbitrary fetch targets. */
export function evidenceEndpoint(url: string): EvidenceEndpoint {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search)
    throw new Error('証拠URLは公開Dayopt repository内に限定');
  const prefix = `/${ASSIST_REPO}/`;
  if (!parsed.pathname.startsWith(prefix)) throw new Error('証拠URLのrepositoryが異なる');
  const tail = parsed.pathname.slice(prefix.length);
  const item = /^(issues|pull)\/([1-9]\d*)$/.exec(tail);
  if (item) {
    const resource = item[1] as 'issues' | 'pull';
    const number = Number(item[2]);
    if (!parsed.hash)
      return { endpoint: `repos/${ASSIST_REPO}/issues/${item[2]}`, kind: 'text', resource, number };
    const comment = /^#issuecomment-([1-9]\d*)$/.exec(parsed.hash);
    if (comment)
      return {
        endpoint: `repos/${ASSIST_REPO}/issues/comments/${comment[1]}`,
        kind: 'text',
        resource,
        number,
        commentId: Number(comment[1]),
      };
  }
  const run = /^actions\/runs\/([1-9]\d*)$/.exec(tail);
  if (run && !parsed.hash)
    return { endpoint: `repos/${ASSIST_REPO}/actions/runs/${run[1]}`, kind: 'run' };
  throw new Error('未対応の証拠URL');
}

function normalizeGithubPath(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin === 'https://github.com') return parsed.pathname;
    if (parsed.origin === 'https://api.github.com') {
      const match = /^\/repos\/(Dayopt\/dayopt)\/(.+)$/.exec(parsed.pathname);
      return match ? `/${match[1]}/${match[2]}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function assertTextEvidenceOwnership(value: unknown, target: EvidenceEndpoint): void {
  if (target.resource === undefined || target.number === undefined)
    throw new Error('証拠の対象が不明');
  const item = itemSchema.parse(value);
  const expectedPath = `/${ASSIST_REPO}/${target.resource}/${target.number}`;
  const paths = [item.issue_url, item.html_url]
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map(normalizeGithubPath)
    .filter((candidate): candidate is string => candidate !== null);
  if (!paths.includes(expectedPath)) throw new Error('証拠コメントの対象が入力URLと一致しない');
  if (target.commentId !== undefined && item.id !== undefined && item.id !== target.commentId)
    throw new Error('証拠コメントIDが入力URLと一致しない');
}

export function loadClaimEvidence(
  raw: unknown,
  api: GhApi = defaultGhApi,
): { input: ClaimsInput; evidence: Evidence[] } {
  const parsed = claimsInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error('claims入力が不正: schemaVersion / 対象SHA / 証拠ID / 公開相対pathを確認');
  const input = parsed.data;
  // Validate all references before any source lookup or evaluation.
  for (const ref of input.evidence) if (ref.kind === 'github') evidenceEndpoint(ref.url);
  assertPublicRepository(api);
  z.object({ sha: z.literal(input.target.sha) }).parse(
    api(`repos/${ASSIST_REPO}/commits/${input.target.sha}`),
  );
  const evidence = input.evidence.map((ref): Evidence => {
    const url =
      ref.kind === 'blob'
        ? `${base}/blob/${ref.sha}/${ref.path.split('/').map(encodeURIComponent).join('/')}`
        : ref.url;
    try {
      if (ref.kind === 'blob') {
        const encoded = ref.path.split('/').map(encodeURIComponent).join('/');
        const blob = z
          .object({
            type: z.literal('file'),
            encoding: z.literal('base64'),
            content: z.string(),
            size: z.number().max(64_000),
          })
          .parse(api(`repos/${ASSIST_REPO}/contents/${encoded}?ref=${ref.sha}`));
        const text = Buffer.from(blob.content, 'base64').toString('utf8');
        if (text.includes('\0')) throw new Error('binary');
        return { id: ref.id, text, url, sha: ref.sha, missing: null, facts: { existsAtSha: true } };
      }
      const target = evidenceEndpoint(ref.url);
      const value = api(target.endpoint);
      if (target.kind === 'run') {
        const run = z
          .object({
            head_sha: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
            html_url: z.string(),
          })
          .parse(value);
        return {
          id: ref.id,
          text: JSON.stringify(run),
          url,
          sha: run.head_sha,
          missing: null,
          facts: { status: run.status, conclusion: run.conclusion, exitCode: null },
        };
      }
      assertTextEvidenceOwnership(value, target);
      const item = itemSchema.parse(value);
      return {
        id: ref.id,
        text: `${item.title ?? ''}\n${item.body ?? ''}`,
        url,
        sha: null,
        missing: null,
        facts: { selfReported: true },
      };
    } catch {
      return {
        id: ref.id,
        text: '',
        url,
        sha: ref.kind === 'blob' ? ref.sha : null,
        missing: 'source_unavailable',
        facts: {},
      };
    }
  });
  return { input, evidence };
}
