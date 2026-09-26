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
