import { assertPreparedPreviewAdmission } from '../ci/preview-prepared-admission.mjs';
import {
  assertFixtureBrokerTarget,
  verifyFixtureJobToken,
  verifyPreviewAccessToken,
} from './preview-fixture-authority.mjs';
import { executeEncryptedFixtureBroker } from './preview-fixture-broker.mjs';
import { preparedReadinessSnapshot } from './preview-prepared-readiness.mjs';

const LIMIT = 48 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reject = (status) =>
  Response.json({ error: 'Preview fixture request rejected' }, { status, headers });

/** Bounded protocol adapter. No request-supplied executor, SDK, env or callback.
 * Admission is source-controlled and remains closed for every ephemeral request.
 * Authentication precedes admission; all failures are value-free. */
export async function handlePreviewFixtureRequest(
  request,
  {
    env = process.env,
    fetchImpl = fetch,
    now = () => Math.floor(Date.now() / 1000),
    createClient = undefined,
  } = {},
) {
  if (env.VERCEL_ENV !== 'preview') return reject(404);
  if (request.method !== 'POST') return reject(405);
  if (
    request.headers.get('content-type') !== 'application/json' ||
    request.headers.has('content-encoding') ||
    request.headers.has('origin')
  )
    return reject(400);
  const token = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(
    request.headers.get('authorization') ?? '',
  )?.[1];
  if (!token) return reject(401);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMIT))
    return reject(413);
  let reader;
  try {
    if (!request.body) return reject(400);
    reader = request.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) return reject(413);
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'input,previewAccessToken,publicKey,readiness'
    )
      return reject(400);
    const target = assertFixtureBrokerTarget(body.input, env);
    if (new URL(request.url).origin !== target.origin) return reject(403);
    if (target.operation !== 'provision') return reject(400);
    await verifyFixtureJobToken({ input: body.input, token, fetchImpl, now });
    // The Preview access audience is separate from broker mutation authority.
    // Carry it inside the encrypted response; never return it as a public field.
    await verifyPreviewAccessToken({
      input: body.input,
      token: body.previewAccessToken,
      fetchImpl,
      now,
    });
    const previewReadiness = preparedReadinessSnapshot(body.input, body.readiness, now() * 1000);
    // Do not expose executeDurableFixtureBroker while Auth quiescence and trusted
    // recovery remain unverified. No admin key is read on this HTTP surface.
    try {
      assertPreparedPreviewAdmission(target.intent.request);
    } catch {
      return reject(503);
    }
    if (typeof createClient !== 'function') return reject(503);
    const encrypted = await executeEncryptedFixtureBroker({
      input: body.input,
      publicKey: body.publicKey,
      previewAccessToken: body.previewAccessToken,
      previewReadiness,
      token,
      createClient,
      env,
      fetchImpl,
      now,
    });
    return Response.json(encrypted, { headers });
  } catch {
    return reject(403);
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* Never echo provider/request errors. */
      }
      reader.releaseLock();
    }
  }
}
