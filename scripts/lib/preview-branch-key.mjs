import { SUPABASE_PRODUCTION_PROJECT_REF } from '../ci/production-auth-config-audit.mjs';

const PROJECT_REF = /^[a-z]{20}$/;

async function readApiKeys({ projectRef, token, fetchImpl }) {
  let status;
  try {
    const response = await fetchImpl(
      `https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    status = response.status;
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    const statusSuffix = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    throw new Error(`Preview target API key request failed${statusSuffix}`);
  }
}

/** Fetch a secret key only for the project ref returned by completed readiness checks. */
export async function resolvePreviewSecretKey({ projectRef, provisionToken, fetchImpl = fetch }) {
  if (
    !PROJECT_REF.test(projectRef ?? '') ||
    projectRef === SUPABASE_PRODUCTION_PROJECT_REF ||
    !provisionToken?.trim()
  )
    throw new Error('Preview target API key binding is invalid');

  const keys = await readApiKeys({ projectRef, token: provisionToken, fetchImpl });
  if (!Array.isArray(keys)) throw new Error('Preview target API keys are invalid');
  const active = keys.filter(
    (key) =>
      key &&
      typeof key === 'object' &&
      (key.disabled === undefined || key.disabled === false) &&
      typeof key.api_key === 'string' &&
      key.api_key.length > 0,
  );
  const modern = active.filter(
    (key) => key.type === 'secret' || (key.type === undefined && key.name === 'secret'),
  );
  const matches = modern.length > 0 ? modern : active.filter((key) => key.name === 'service_role');
  if (matches.length !== 1)
    throw new Error('Preview target secret key is unavailable or ambiguous');
  return matches[0].api_key;
}

/** Modern Supabase secret keys are accepted through apikey only; legacy JWT keys also need Bearer. */
export function previewServiceKeyHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    ...(!serviceKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${serviceKey}` } : {}),
  };
}
