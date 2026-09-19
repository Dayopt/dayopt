/**
 * merged PR を gh CLI から取る共通層（#2827）。shadow harness と Evaluation Pack の
 * 両方が同じ経路を使う。
 *
 * ここに置くのは **取得と正規化だけ**。正解ラベルの導出や state の組み立ては pack 側が
 * 持つ。`gh` は `execFileSync` で argv 配列として呼び、shell を経由しない。
 *
 * `PrFile.patch` を保持する理由: pack の正解ラベルに「diff に `onMutate` が足されたか」
 * のような diff 由来の判定が要る。`pulls/N/files` の応答に patch が含まれるので、追加の
 * gh 呼び出しは無い。patch は memory 上でしか使わず、case file へは保存しない。
 */
import { execFileSync } from 'node:child_process';

import type { ShadowPrEvidence, ShadowTimelineItem } from './jev-shadow-truth.ts';

export type GhApi = (path: string, paginate?: boolean) => unknown;
export type GhGraphql = (query: string, variables: Record<string, string | number>) => unknown;

const GH_MAX_BUFFER = 32 * 1024 * 1024;

export function defaultGhApi(path: string, paginate = false): unknown {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER });
  const parsed: unknown = JSON.parse(raw);
  return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
}

export function defaultGhGraphql(
  query: string,
  variables: Record<string, string | number>,
): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER });
  return JSON.parse(raw);
}

export function readPolicyCheckout(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export const PR_PAGE_SIZE = 50;
export const MAX_PAGES = 10;
/** `pulls/N/files` は 3,000 件までしか返さない。超えたら path 由来の label を unknown にする。 */
export const FILES_CAP = 300;

export const PR_QUERY = `query($owner:String!,$name:String!,$size:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,baseRefName:"main",first:$size,orderBy:{field:UPDATED_AT,direction:DESC},after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body createdAt mergedAt changedFiles
        labels(first:30){nodes{name}}
        closingIssuesReferences(first:10){pageInfo{hasNextPage} nodes{number title body labels(first:30){nodes{name}}}}
        reviewThreads(first:100){nodes{comments(first:1){nodes{author{login} body}}}}
        timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT,PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT],last:100){
          nodes{
            __typename
            ... on ReadyForReviewEvent{createdAt}
            ... on HeadRefForcePushedEvent{createdAt}
            ... on PullRequestCommit{commit{committedDate}}
          }
        }
      }
    }
  }
}`;

export type RawPrNode = {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  mergedAt: string | null;
  changedFiles: number;
  labels: { nodes: { name: string }[] };
  closingIssuesReferences: {
    pageInfo?: { hasNextPage: boolean };
    nodes: {
      number: number;
      title: string;
      body: string | null;
      labels: { nodes: { name: string }[] };
    }[];
  };
  reviewThreads: {
    nodes: { comments: { nodes: { author: { login: string } | null; body: string }[] } }[];
  };
  timelineItems: {
    nodes: ({
      __typename: string;
      createdAt?: string;
      commit?: { committedDate: string };
    } | null)[];
  };
};

export type PrFile = {
  filename: string;
  previousFilename: string | null;
  /** unified diff。REST が返さない（binary・大きすぎる diff）場合は null。 */
  patch: string | null;
  /** REST の `status`（added / removed / modified / renamed …）。取れなければ null。 */
  status?: string | null;
};

/** `ShadowPrEvidence` と構造互換（files だけ patch を持つ）。 */
export type PrEvidence = Omit<ShadowPrEvidence, 'files'> & {
  files: PrFile[];
  /** closing issue を全件取れたか。`first:10` を超える PR は false。 */
  closingIssuesComplete: boolean;
};

export function normalizePrNode(
  node: RawPrNode,
  files: PrFile[],
  filesComplete: boolean,
): PrEvidence {
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    labels: node.labels.nodes.map((label) => label.name),
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    changedFiles: node.changedFiles,
    filesComplete,
    files,
    reviewThreads: node.reviewThreads.nodes.map((thread) => {
      const first = thread.comments.nodes[0];
      return { authorLogin: first?.author?.login ?? null, body: first?.body ?? '' };
    }),
    timeline: node.timelineItems.nodes.flatMap((item): ShadowTimelineItem[] => {
      if (!item) return [];
      if (item.__typename === 'ReadyForReviewEvent')
        return [{ type: 'ready_for_review' as const, at: item.createdAt ?? null }];
      if (item.__typename === 'HeadRefForcePushedEvent')
        return [{ type: 'force_push' as const, at: item.createdAt ?? null }];
      if (item.__typename === 'PullRequestCommit')
        return [{ type: 'commit' as const, at: item.commit?.committedDate ?? null }];
      return [];
    }),
    closingIssuesComplete: node.closingIssuesReferences.pageInfo?.hasNextPage !== true,
    closingIssues: node.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels.nodes.map((label) => label.name),
    })),
  };
}

export function fetchMergedPrs({
  graphql,
  limit,
  owner = 'Dayopt',
  name = 'dayopt',
}: {
  graphql: GhGraphql;
  limit: number;
  owner?: string;
  name?: string;
}): RawPrNode[] {
  const nodes: RawPrNode[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES && nodes.length < limit; page += 1) {
    const variables: Record<string, string | number> = {
      owner,
      name,
      size: Math.min(PR_PAGE_SIZE, limit - nodes.length),
    };
    if (cursor) variables.cursor = cursor;
    const response = graphql(PR_QUERY, variables) as {
      data?: {
        repository?: {
          pullRequests?: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: RawPrNode[];
          };
        };
      };
    };
    const connection = response?.data?.repository?.pullRequests;
    if (!connection || connection.nodes.length === 0) break;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return nodes.slice(0, limit);
}

/**
 * 変更 file を取る。`changedFiles` が上限を超える PR は取りに行かず、
 * `filesComplete: false` で返す（unknown と「変更なし」を区別するため）。
 */
export function fetchPrFiles({
  api,
  prNumber,
  changedFiles,
  owner = 'Dayopt',
  name = 'dayopt',
}: {
  api: GhApi;
  prNumber: number;
  changedFiles: number;
  owner?: string;
  name?: string;
}): { files: PrFile[]; filesComplete: boolean } {
  const filesComplete = changedFiles <= FILES_CAP;
  if (!filesComplete) return { files: [], filesComplete };
  const raw = api(`repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100`, true);
  const list = Array.isArray(raw)
    ? (raw as { filename: string; previous_filename?: string; patch?: string; status?: string }[])
    : [];
  return {
    filesComplete,
    files: list.map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      patch: typeof file.patch === 'string' ? file.patch : null,
      status: typeof file.status === 'string' ? file.status : null,
    })),
  };
}

/** GraphQL と REST を組み合わせて正規化済みの PR 一覧を返す。 */
export function fetchPrEvidence({
  api,
  graphql,
  limit,
}: {
  api: GhApi;
  graphql: GhGraphql;
  limit: number;
}): PrEvidence[] {
  return fetchMergedPrs({ graphql, limit }).map((node) => {
    const { files, filesComplete } = fetchPrFiles({
      api,
      prNumber: node.number,
      changedFiles: node.changedFiles,
    });
    return normalizePrNode(node, files, filesComplete);
  });
}
