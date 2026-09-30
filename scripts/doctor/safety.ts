/** Provider errors are classified without exposing messages, bodies or request URLs. */
export class ReadFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
  }
}
export function failureCode(error: unknown): string {
  if (error instanceof ReadFailure) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'request_timeout';
  return 'read_failed';
}
const SENSITIVE_KEY =
  /(?:^(?:secret|password|token|credential|authorization|api_key|protectionBypass)$|_(?:SECRET|TOKEN|PASSWORD|API_KEY|SECRET_KEY)$)/i;
const SECRET_PATTERN =
  /(?:sk_(?:live|test)_|whsec_|gh[pousr]_|github_pat_|Bearer\s|eyJ[a-zA-Z0-9_-]+\.)\S*/g;
export function sanitize(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets)
      if (secret.length >= 4) result = result.split(secret).join('[redacted]');
    result = result.replace(SECRET_PATTERN, '[redacted]');
    // URLs are never diagnostic evidence of embedded credentials. Keep origin only.
    result = result.replace(/https?:\/\/[^\s"<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        if (raw === url.origin) return url.origin;
        const safePath =
          /^\/(?:api\/(?:health(?:\/version)?|webhooks\/(?:stripe|resend)|mcp|integrations\/google-calendar\/callback)|auth\/v1\/callback|functions\/v1\/send-auth-email|connector_platform_oauth_redirect)?\/?$/.test(
            url.pathname,
          );
        return url.origin + (safePath ? url.pathname : '/[path-redacted]');
      } catch {
        return '[url-redacted]';
      }
    });
    return result.length > 300 ? '[long-value-redacted]' : result;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key)
          ? '[redacted]'
          : key === 'path' &&
              typeof entry === 'string' &&
              !/^\/(?:api\/(?:health(?:\/version)?|webhooks\/(?:stripe|resend)|mcp|integrations\/google-calendar\/callback)|auth\/v1\/callback)?\/?$/.test(
                entry,
              )
            ? '[path-redacted]'
            : sanitize(entry, secrets),
      ]),
    );
  }
  return value;
}
