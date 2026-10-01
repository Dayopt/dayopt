import { rmdirSync, unlinkSync } from 'node:fs';

import { prepareFixtureAuthority } from '../lib/preview-fixture-authority.mjs';
import { receivePreviewFixtureRegistry } from '../lib/preview-fixture-handoff.mjs';
import { withPreviewFixturePrivateKey } from '../lib/preview-fixture-key-custody.mjs';
import { runPreviewE2E } from '../runbook/preview-e2e.mjs';

/** Trusted consumer composition. Handoff and private-key destruction MUST finish
 * before candidate checkout/install. No admin key or OIDC issuance is needed on
 * this worker. Callbacks are trusted code/test dependencies, never CLI input.
 * The workflow admission remains closed while server/recovery guarantees are
 * unverified; this function cannot mark cleanup or the overall AC successful. */
export async function consumePreparedPreviewFixtures({
  input,
  token,
  privatePath,
  runnerTemp,
  privateOutput,
  evidenceDirectory,
  prepareCandidate,
  env = process.env,
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
  receive = receivePreviewFixtureRegistry,
  withKey = withPreviewFixturePrivateKey,
  run = runPreviewE2E,
}) {
  let registry;
  try {
    const authority = prepareFixtureAuthority(input);
    await withKey({
      input,
      privatePath,
      runnerTemp,
      privateOutput,
      evidenceDirectory,
      use: async (privateKey) => {
        if (authority.operation !== 'provision' || typeof prepareCandidate !== 'function')
          throw new Error();
        if (
          [
            'SUPABASE_SECRET_KEY',
            'SUPABASE_SERVICE_ROLE_KEY',
            'SUPABASE_ACCESS_TOKEN',
            'VERCEL_TOKEN',
            'VERCEL_AUTOMATION_BYPASS_SECRET',
            'ACTIONS_ID_TOKEN_REQUEST_URL',
            'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
          ].some((key) => env[key] !== undefined)
        )
          throw new Error();

        registry = await receive({
          input,
          token,
          privateKey,
          runnerTemp,
          privateOutput,
          evidenceDirectory,
          preparedAccess: true,
          fetchImpl,
          now,
        });
      },
    });
    if (!registry?.trustedOidcToken) throw new Error();
    // The callback returns only the reviewed checkout and its migration versions.
    const candidate = await prepareCandidate(authority.intent.request);
    return await run({
      request: { ...authority.intent.request, expectedMigrations: candidate.expectedMigrations },
      candidateRoot: candidate.root,
      env,
      runId: authority.intent.runId,
      cloudUserIds: authority.intent.userIds,
      registryPath: registry.path,
      trustedOidcToken: registry.trustedOidcToken,
    });
  } catch {
    throw new Error('Prepared Preview consumer failed');
  } finally {
    if (registry) {
      // Delete only our file/empty directory, never a recursive candidate path.
      try {
        unlinkSync(registry.path);
        rmdirSync(registry.directory);
      } catch {
        throw new Error('Prepared Preview private cleanup failed');
      }
    }
  }
}
