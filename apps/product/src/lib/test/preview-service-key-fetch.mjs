/**
 * Supabase SDK admin requests must not use a modern secret key as a JWT.
 * Remove only the SDK's key fallback; preserve legacy keys and user tokens.
 * @param {string} serviceKey
 * @param {typeof globalThis.fetch} fetchImpl
 * @returns {typeof globalThis.fetch}
 */
export function previewServiceKeyFetch(serviceKey, fetchImpl = globalThis.fetch) {
  if (!serviceKey.startsWith('sb_secret_')) return fetchImpl;
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.get('authorization') === `Bearer ${serviceKey}`) {
      headers.delete('authorization');
    }
    return fetchImpl(input, { ...init, headers });
  };
}
