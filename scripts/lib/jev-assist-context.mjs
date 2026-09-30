const REPO_URL = 'https://github.com/Dayopt/dayopt';

/**
 * @param {number} number
 * @param {string} sha
 * @param {{title: string, body: string, url: string, updatedAt: string | null,
 * comments: Array<{id?: number, body?: string | null, updated_at?: string, created_at?: string}> | null,
 * related: Array<{number?: number, title?: string, body?: string | null, updated_at?: string,
 * updatedAt?: string, created_at?: string}>, decisions: string[], missing?: string[]}} source
 * @returns {import('./jev-assist-packs.ts').ContextInput}
 */
export function buildContextInput(number, sha, source) {
  const candidates = [
    {
      id: `issue-${number}`,
      kind: 'issue',
      text: `${source.title}\n${source.body}`,
      url: source.url,
      updatedAt: source.updatedAt ?? '',
    },
  ];
  for (const comment of source.comments ?? []) {
    if (comment.id === undefined) continue;
    candidates.push({
      id: `comment-${comment.id}`,
      kind: 'comment',
      text: comment.body ?? '',
      url: `${REPO_URL}/issues/${number}#issuecomment-${comment.id}`,
      updatedAt: comment.updated_at ?? comment.created_at ?? '',
    });
  }
  for (const related of source.related) {
    if (related.number === undefined) continue;
    candidates.push({
      id: `related-${related.number}`,
      kind: 'related',
      text: `${related.title ?? ''}\n${related.body ?? ''}`,
      url: `${REPO_URL}/issues/${related.number}`,
      updatedAt: related.updated_at ?? related.updatedAt ?? related.created_at ?? '',
    });
  }
  source.decisions.forEach((text, index) =>
    candidates.push({
      id: `decision-${index}`,
      kind: 'decision',
      text,
      url: `${REPO_URL}/blob/${sha}/docs/decisions.md`,
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
    missing: [
      ...(source.missing ?? []),
      ...(source.comments === null ? ['comments_unavailable'] : []),
    ],
  };
}
