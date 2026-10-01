/** Credentials are added only to the pinned deployment, never to redirects or other origins. */
export function previewRequestTarget(
  requestUrl: string,
  previewOrigin: string,
  supabaseRef: string,
): 'preview' | 'supabase' | 'captcha' | 'blocked' {
  const origin = new URL(requestUrl).origin;
  if (origin === previewOrigin) return 'preview';
  if (origin === `https://${supabaseRef}.supabase.co`) return 'supabase';
  if (origin === 'https://challenges.cloudflare.com') return 'captcha';
  return 'blocked';
}

export function validatePreviewOrigin(origin: string | undefined): string {
  if (!origin || !/^https:\/\/product-[a-z0-9]+-dayopt\.vercel\.app$/.test(origin)) {
    throw new Error('A pinned Product Preview origin is required');
  }
  return origin;
}

/** Strip both protection credentials on every hop; never forward to Supabase,
 * captcha, redirects, or a foreign deployment. Prepared access has no fallback. */
export function previewAccessHeaders(
  headers: Record<string, string>,
  target: ReturnType<typeof previewRequestTarget>,
  credential: { prepared: boolean; token: string | undefined; bypass?: string | undefined },
): Record<string, string> {
  if (!credential.token?.trim() || (credential.prepared && credential.bypass !== undefined))
    throw new Error('Preview access credential is invalid');
  const result = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        ![
          'x-vercel-protection-bypass',
          'x-vercel-set-bypass-cookie',
          'x-vercel-trusted-oidc-idp-token',
        ].includes(name.toLowerCase()),
    ),
  );
  if (target === 'preview')
    result[credential.prepared ? 'x-vercel-trusted-oidc-idp-token' : 'x-vercel-protection-bypass'] =
      credential.token;
  return result;
}
