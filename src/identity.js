import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from './fsAtomic.js';

// The install's Ed25519 identity: one keypair per data dir, created on first use. The private key never leaves
// `$DATA/identity/`; only the 32-byte raw public key travels (inside each record's envelope).
export const IDENTITY_DIR = 'identity';
export const KEY_FILE = 'ed25519.pem';

// Hex sha256 of the raw public key: the identity's id everywhere (records, routes, share subdirs).
export const fingerprint = (rawPub) => crypto.createHash('sha256').update(rawPub).digest('hex');

// Display form: the first 32 hex in groups of 4.
export const formatFingerprint = (fp) => fp.slice(0, 32).match(/.{4}/g).join(' ');

const rawOf = (publicKey) => Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');

// True when `sig` is a valid Ed25519 signature by the raw public key `rawPub` over `bytes`. Never throws.
export function verifySignature(rawPub, bytes, sig) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(rawPub).toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function fromPrivateKey(privateKey) {
  const publicRaw = rawOf(crypto.createPublicKey(privateKey));
  return {
    publicRaw,
    fp: fingerprint(publicRaw),
    sign: (bytes) => crypto.sign(null, bytes, privateKey),
  };
}

// Loads the keypair under `dataDir`, creating it (dir 0700, file 0600) when absent. Resolves {publicRaw, fp, sign}.
export async function loadIdentity(dataDir) {
  const dir = path.join(dataDir, IDENTITY_DIR);
  const file = path.join(dir, KEY_FILE);
  await ensurePrivateDir(dir);
  let pem;
  try {
    pem = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    await writeFileAtomic(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), 0o600);
    return fromPrivateKey(privateKey);
  }
  await fs.chmod(file, 0o600);
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${file} does not hold an Ed25519 private key`);
  return fromPrivateKey(privateKey);
}
