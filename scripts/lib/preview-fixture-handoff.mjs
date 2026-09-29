import { execFileSync } from 'node:child_process';

import { decodeVerifiedPreviewArtifactZip } from './preview-artifact-zip.mjs';
import { decryptPreviewFixtureEnvelope } from './preview-fixture-envelope.mjs';
import {
  previewFixtureHandoffArtifactName,
  verifyPreviewFixtureHandoffTrust,
} from './preview-fixture-handoff-trust.mjs';
import { writeFixtureRegistry } from './preview-fixture-registry.mjs';

const ERROR = 'Preview fixture handoff failed';

function assertProof(proof, input) {
  if (
    !proof ||
    !Number.isSafeInteger(proof.artifactId) ||
    proof.artifactId < 1 ||
    typeof proof.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(proof.digest) ||
    proof.name !== previewFixtureHandoffArtifactName(input, 'envelope')
  )
    throw new Error();
}

function downloadArtifact({ artifactId, token }) {
  // gh handles the provider's authenticated artifact redirect. Neither the token
  // nor response bytes go through argv, inherited provider env, or terminal output.
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'LANG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  return execFileSync(
    'gh',
    [
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      `repos/Dayopt/dayopt/actions/artifacts/${artifactId}/zip`,
    ],
    {
      env: { ...env, GH_TOKEN: token, GH_HOST: 'github.com' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 131_072,
    },
  );
}

/**
 * Trusted consumer step only, BEFORE candidate checkout/install. Verify metadata,
 * download bounded encrypted bytes, verify digest, recheck the live job/attempt,
 * then decrypt and materialize the private login registry. Returns paths only.
 * The caller owns private-key/file deletion and the always/independent cleanup
 * jobs. This function neither provisions users nor authenticates the broker.
 * verify/download injection is for trusted code/tests, never HTTP/workflow input.
 */
export async function receivePreviewFixtureRegistry(options) {
  try {
    const {
      input,
      token,
      privateKey,
      runnerTemp,
      privateOutput,
      evidenceDirectory,
      fetchImpl = fetch,
      verify = verifyPreviewFixtureHandoffTrust,
      download = downloadArtifact,
    } = options;
    if (typeof token !== 'string' || !token.trim() || token.length > 16_384) throw new Error();
    const args = { input, role: 'envelope', token: token.trim(), fetchImpl };
    const proof = await verify(args);
    assertProof(proof, input);
    const archive = await download({ artifactId: proof.artifactId, token: token.trim() });
    const serialized = decodeVerifiedPreviewArtifactZip({
      archive,
      digest: proof.digest,
      kind: 'envelope',
    });
    const current = await verify(args);
    assertProof(current, input);
    if (
      current.artifactId !== proof.artifactId ||
      current.digest !== proof.digest ||
      current.name !== proof.name
    )
      throw new Error();
    const response = decryptPreviewFixtureEnvelope({
      input,
      privateKey,
      envelope: JSON.parse(serialized),
    });
    return writeFixtureRegistry({ input, response, runnerTemp, privateOutput, evidenceDirectory });
  } catch {
    throw new Error(ERROR);
  }
}
