import crypto from 'node:crypto';
import { fingerprint, verifySignature } from '../identity.js';
import { TCP_MAX_IDENTITIES } from './frames.js';

// The TCP handshake proofs (docs/protocol.md → Handshake). Pure. The domain differs from the record domain, so a
// proof is never a valid record signature and a record signature never a valid proof.
export const PROOF_DOMAIN = Buffer.from('code-inbox/tcp-proof/v1\0', 'utf8');

export const newHandshakeNonce = () => crypto.randomBytes(32).toString('hex');

// role: 'dial' | 'accept'. bound: the dialer's target fp (dial) or the dialer's proven fps (accept, `boundFps`).
export const proofBytes = (role, proverNonce, verifierNonce, bound) => Buffer.concat([PROOF_DOMAIN, Buffer.from(JSON.stringify([role, proverNonce, verifierNonce, bound]), 'utf8')]);

export const boundFps = (fps) => [...fps].sort().join(',');

// What the transport holds of an identity: it can sign handshake proofs and nothing else.
export function proofSigner(identity) {
  return {
    fp: identity.fp,
    publicRaw: identity.publicRaw,
    signProof: (role, proverNonce, verifierNonce, bound) => identity.sign(proofBytes(role, proverNonce, verifierNonce, bound)),
  };
}

// The `ids` of a `prove` frame: one proof per signer.
export const makeProofs = (signers, role, proverNonce, verifierNonce, bound) => signers.map((s) => ({
  key: Buffer.from(s.publicRaw).toString('base64url'),
  sig: s.signProof(role, proverNonce, verifierNonce, bound).toString('base64url'),
}));

// The proven fingerprints of parsed ids [{key, sig}] (bytes), or null when any proof fails, a key repeats, or the
// count is outside 1..TCP_MAX_IDENTITIES.
export function verifyProofs(ids, role, proverNonce, verifierNonce, bound) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > TCP_MAX_IDENTITIES) return null;
  const msg = proofBytes(role, proverNonce, verifierNonce, bound);
  const fps = [];
  for (const { key, sig } of ids) {
    if (!verifySignature(key, msg, sig)) return null;
    const fp = fingerprint(key);
    if (fps.includes(fp)) return null;
    fps.push(fp);
  }
  return fps;
}
