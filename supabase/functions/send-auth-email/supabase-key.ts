/**
 * Hosted Edge Functions expose modern keys as a dictionary keyed by key name.
 * Do not select an arbitrary named key when `default` is absent: that can change
 * credentials silently during rotation. A dedicated key can be set explicitly.
 *
 * @see https://supabase.com/docs/guides/functions/secrets
 */
export function resolveAuthEmailSecretKey(input: {
  supabaseUrl: string;
  secretKey?: string;
  secretKeys?: string;
  localServiceRoleKey?: string;
}): string | undefined {
  if (input.secretKey !== undefined) return modernSecret(input.secretKey);

  if (input.secretKeys !== undefined) {
    try {
      const keys: unknown = JSON.parse(input.secretKeys);
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return undefined;
      return modernSecret('default' in keys ? keys.default : undefined);
    } catch {
      // JSON parser errors can contain secret material. Locale lookup is optional;
      // return no credential and let the caller preserve its English fallback.
      return undefined;
    }
  }

  // Explicit compatibility boundary for local CLI versions injecting JWT keys.
  // Hosted URLs must never fall back to the automatically supplied legacy key.
  try {
    const url = new URL(input.supabaseUrl);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // The CLI's Edge container reaches the local gateway by this exact origin.
    const isLocalContainer = url.origin === 'http://kong:8000';
    if (
      (isLoopback || isLocalContainer) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      return input.localServiceRoleKey || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function modernSecret(value: unknown): string | undefined {
  return typeof value === 'string' && /^sb_secret_[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}
