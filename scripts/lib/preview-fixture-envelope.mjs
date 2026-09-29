import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

import { prepareFixtureAuthority } from './preview-fixture-authority.mjs';

const MAX_PAYLOAD = 16_384;
const MAX_ENVELOPE = 49_152;
const ERROR = 'Preview fixture envelope is invalid';

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error();
}

function authority(input) {
  const bound = prepareFixtureAuthority(input);
  if (bound.operation !== 'provision') throw new Error();
  return bound;
}

function rsa(key) {
  const details = key.asymmetricKeyDetails;
  if (
    key.asymmetricKeyType !== 'rsa' ||
    !details ||
    ![3072, 4096].includes(details.modulusLength ?? 0) ||
    details.publicExponent !== 65537n
  )
    throw new Error();
  return key;
}

function pem(value, label, max) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > max ||
    !new RegExp(`^-----BEGIN ${label}-----\\n[A-Za-z0-9+/=\\n]+-----END ${label}-----\\n?$`).test(
      value,
    )
  )
    throw new Error();
  return value;
}

function recipientDigest(key) {
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function bytes(value, min, max) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error();
  const result = Buffer.from(value, 'base64url');
  if (result.length < min || result.length > max || result.toString('base64url') !== value)
    throw new Error();
  return result;
}

/** In-memory only. The private PEM must never become a log, output, cache, or artifact. */
export function generatePreviewFixtureKeyPair() {
  try {
    return generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicExponent: 65537,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  } catch {
    throw new Error(ERROR);
  }
}

/**
 * Confidentiality and binding only: anyone with the public key can encrypt.
 * A separate trusted artifact verifier MUST authenticate the sender and exact
 * run/attempt/artifact before use. This core does not perform any transfer.
 * The private registry writer must validate the decrypted payload's final schema.
 */
export function encryptPreviewFixtureEnvelope(options) {
  let secret;
  let plaintext;
  try {
    exact(options, ['input', 'publicKey', 'payload']);
    const { input, publicKey, payload } = options;
    const bound = authority(input);
    const recipient = rsa(createPublicKey(pem(publicKey, 'PUBLIC KEY', 2_048)));
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_PAYLOAD)
      throw new Error();
    plaintext = Buffer.from(serialized);
    const binding = { authority: bound, publicKeyDigest: recipientDigest(recipient) };
    const aad = Buffer.from(JSON.stringify({ schemaVersion: 1, binding }));
    secret = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = publicEncrypt(
      {
        key: recipient,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        oaepLabel: aad,
      },
      secret,
    );
    const envelope = {
      schemaVersion: 1,
      binding,
      wrappedKey: wrapped.toString('base64url'),
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE) throw new Error();
    return envelope;
  } catch {
    throw new Error(ERROR);
  } finally {
    secret?.fill(0);
    plaintext?.fill(0);
  }
}

/** Returns plaintext only after complete RSA/GCM and binding validation; never log the result. */
export function decryptPreviewFixtureEnvelope(options) {
  let secret;
  let plaintext;
  let pending;
  try {
    exact(options, ['input', 'privateKey', 'envelope']);
    const { input, privateKey, envelope } = options;
    const bound = authority(input);
    const recipient = rsa(createPrivateKey(pem(privateKey, 'PRIVATE KEY', 8_192)));
    const publicKey = createPublicKey(recipient);
    exact(envelope, ['schemaVersion', 'binding', 'wrappedKey', 'nonce', 'ciphertext', 'tag']);
    if (envelope.schemaVersion !== 1 || Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE)
      throw new Error();
    exact(envelope.binding, ['authority', 'publicKeyDigest']);
    exact(envelope.binding.authority, ['operation', 'origin', 'intent', 'execution', 'audience']);
    const { operation, origin, intent, execution, audience } = envelope.binding.authority;
    const normalized = authority({ operation, origin, intent, execution });
    if (
      audience !== normalized.audience ||
      JSON.stringify(normalized) !== JSON.stringify(bound) ||
      envelope.binding.publicKeyDigest !== recipientDigest(publicKey)
    )
      throw new Error();
    const binding = { authority: bound, publicKeyDigest: recipientDigest(publicKey) };
    const aad = Buffer.from(JSON.stringify({ schemaVersion: 1, binding }));
    const wrappedLength = recipient.asymmetricKeyDetails.modulusLength / 8;
    const wrapped = bytes(envelope.wrappedKey, wrappedLength, wrappedLength);
    const nonce = bytes(envelope.nonce, 12, 12);
    const ciphertext = bytes(envelope.ciphertext, 1, MAX_PAYLOAD);
    const tag = bytes(envelope.tag, 16, 16);
    secret = privateDecrypt(
      {
        key: recipient,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        oaepLabel: aad,
      },
      wrapped,
    );
    if (secret.length !== 32) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // update emits unauthenticated bytes; do not parse/return them until final succeeds.
    pending = decipher.update(ciphertext);
    plaintext = Buffer.concat([pending, decipher.final()]);
    if (plaintext.length > MAX_PAYLOAD) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new Error(ERROR);
  } finally {
    secret?.fill(0);
    pending?.fill(0);
    plaintext?.fill(0);
  }
}
