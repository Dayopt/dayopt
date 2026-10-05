const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reject browser mutations submitted from a different origin.
 * Requests without Origin or Referer remain available to non-browser tRPC clients.
 */
export function rejectCrossOriginMutation(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin !== null) {
    return origin === requestOrigin ? null : forbiddenResponse();
  }

  const referer = request.headers.get('referer');
  if (referer !== null) {
    try {
      return new URL(referer).origin === requestOrigin ? null : forbiddenResponse();
    } catch {
      return forbiddenResponse();
    }
  }

  return null;
}

function forbiddenResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: { 'cache-control': 'no-store' },
  });
}
