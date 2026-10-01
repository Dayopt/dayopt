import { validateCloudRequest } from './preview-cloud-binding.mjs';

/** Authenticate the selected key against the selected nonproduction Auth API before creating fixtures. */
export async function assertCloudFixtureKey({ request, serviceKey, fetchImpl = fetch }) {
  const bound = validateCloudRequest(request);
  if (!serviceKey?.trim()) throw new Error('Cloud Preview fixture key is missing');
  if (!serviceKey.startsWith('sb_secret_')) {
    try {
      const parts = serviceKey.split('.');
      if (parts.length !== 3) throw new Error();
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (claims.role !== 'service_role' || claims.ref !== bound.supabaseProjectRef)
        throw new Error();
    } catch {
      throw new Error('Cloud Preview fixture key binding differs');
    }
  }
  try {
    const response = await fetchImpl(
      `https://${bound.supabaseProjectRef}.supabase.co/auth/v1/admin/users/00000000-0000-0000-0000-000000000001`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      },
    );
    if (!response.ok || (await response.json())?.id !== '00000000-0000-0000-0000-000000000001')
      throw new Error();
  } catch {
    throw new Error('Cloud Preview fixture key or baseline is not ready');
  }
}
