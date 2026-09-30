import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';

import { decodeVerifiedPreviewArtifactZip } from './preview-artifact-zip.mjs';
import { prepareFixtureAuthority, verifyPreviewAccessToken } from './preview-fixture-authority.mjs';
import { decryptPreviewFixtureEnvelope } from './preview-fixture-envelope.mjs';
import {
  previewFixtureHandoffArtifactName,
  verifyPreviewFixtureHandoffTrust,
} from './preview-fixture-handoff-trust.mjs';
import { writeFixtureRegistry } from './preview-fixture-registry.mjs';

const ERROR = 'Preview fixture handoff failed';

function assertProof(proof, input, role) {
  if (
    !proof ||
    !Number.isSafeInteger(proof.artifactId) ||
    proof.artifactId < 1 ||
    typeof proof.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(proof.digest) ||
    proof.name !== previewFixtureHandoffArtifactName(input, role)
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
      preparedAccess = false,
      now = () => Math.floor(Date.now() / 1000),
    } = options;
    if (typeof token !== 'string' || !token.trim() || token.length > 16_384) throw new Error();
    const args = { input, role: 'envelope', token: token.trim(), fetchImpl };
    const proof = await verify(args);
    assertProof(proof, input, 'envelope');
    const archive = await download({ artifactId: proof.artifactId, token: token.trim() });
    const serialized = decodeVerifiedPreviewArtifactZip({
      archive,
      digest: proof.digest,
      kind: 'envelope',
    });
    const current = await verify(args);
    assertProof(current, input, 'envelope');
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
    if (preparedAccess) {
      exact(response, ['fixture', 'previewAccessToken']);
      await verifyPreviewAccessToken({ input, token: response.previewAccessToken, fetchImpl, now });
      const registry = writeFixtureRegistry({
        input,
        response: response.fixture,
        runnerTemp,
        privateOutput,
        evidenceDirectory,
      });
      return { ...registry, trustedOidcToken: response.previewAccessToken };
    }
    return writeFixtureRegistry({ input, response, runnerTemp, privateOutput, evidenceDirectory });
  } catch {
    throw new Error(ERROR);
  }
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error();
}

/** Public artifact body only; publication and private-key custody belong to trusted workflow code. */
export function createPreviewFixturePublicKeyArtifact(options) {
  try {
    exact(options, ['input', 'publicKey']);
    const { input, publicKey } = options;
    const authority = prepareFixtureAuthority(input);
    if (
      authority.operation !== 'provision' ||
      typeof publicKey !== 'string' ||
      Buffer.byteLength(publicKey) > 2_048 ||
      !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(publicKey)
    )
      throw new Error();
    const recipient = createPublicKey(publicKey);
    const details = recipient.asymmetricKeyDetails;
    if (
      recipient.asymmetricKeyType !== 'rsa' ||
      !details ||
      ![3072, 4096].includes(details.modulusLength ?? 0) ||
      details.publicExponent !== 65537n
    )
      throw new Error();
    const publicKeyDigest = createHash('sha256')
      .update(recipient.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    return { schemaVersion: 1, binding: { authority, publicKeyDigest }, publicKey };
  } catch {
    throw new Error(ERROR);
  }
}

/**
 * Trusted provisioner only, before any fixture mutation. The artifact is public;
 * its sender authority comes from the trusted job ordering and metadata verifier.
 * Returns only an RSA public PEM after digest, binding and metadata revalidation.
 * Injection hooks are for trusted code/tests, never candidate-controlled input.
 */
export async function receivePreviewFixturePublicKey(options) {
  try {
    const {
      input,
      token,
      fetchImpl = fetch,
      verify = verifyPreviewFixtureHandoffTrust,
      download = downloadArtifact,
    } = options;
    if (typeof token !== 'string' || !token.trim() || token.length > 16_384) throw new Error();
    const args = { input, role: 'public-key', token: token.trim(), fetchImpl };
    const proof = await verify(args);
    assertProof(proof, input, 'public-key');
    const archive = await download({ artifactId: proof.artifactId, token: token.trim() });
    const serialized = decodeVerifiedPreviewArtifactZip({
      archive,
      digest: proof.digest,
      kind: 'public-key',
    });
    const current = await verify(args);
    assertProof(current, input, 'public-key');
    if (
      current.artifactId !== proof.artifactId ||
      current.digest !== proof.digest ||
      current.name !== proof.name
    )
      throw new Error();
    const artifact = JSON.parse(serialized);
    exact(artifact, ['schemaVersion', 'binding', 'publicKey']);
    exact(artifact.binding, ['authority', 'publicKeyDigest']);
    exact(artifact.binding.authority, ['operation', 'origin', 'intent', 'execution', 'audience']);
    const { operation, origin, intent, execution, audience } = artifact.binding.authority;
    const normalized = prepareFixtureAuthority({ operation, origin, intent, execution });
    const expected = createPreviewFixturePublicKeyArtifact({
      input,
      publicKey: artifact.publicKey,
    });
    if (
      artifact.schemaVersion !== 1 ||
      audience !== normalized.audience ||
      JSON.stringify(normalized) !== JSON.stringify(expected.binding.authority) ||
      artifact.binding.publicKeyDigest !== expected.binding.publicKeyDigest
    )
      throw new Error();
    return expected.publicKey;
  } catch {
    throw new Error(ERROR);
  }
}
