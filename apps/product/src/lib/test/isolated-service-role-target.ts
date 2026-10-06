import { resolveServiceRoleTarget } from './service-role-target-guard';

/** This lane can never opt into a shared Cloud database or a protected Preview. */
export function resolveIsolatedServiceRoleTarget(
  url: string | undefined,
  key: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof resolveServiceRoleTarget> {
  const disabled = (value: string | undefined) =>
    value === undefined || value === '' || value === '0';
  if (
    env.E2E_PREVIEW_ORIGIN ||
    !disabled(env.E2E_PREVIEW_CLOUD_INTENT) ||
    !disabled(env.E2E_ALLOW_NONLOCAL_SUPABASE)
  ) {
    return { safe: false, reason: 'Isolated E2E cannot use Preview or nonlocal opt-in' };
  }
  const target = resolveServiceRoleTarget(url, key, { NODE_ENV: 'test' });
  if (!target.safe) return target;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname)) {
    return { safe: false, reason: 'Isolated E2E requires a loopback Supabase origin' };
  }
  return target;
}
