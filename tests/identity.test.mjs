import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint, loadIdentity } from '../src/identity.js';
import { validateShareDir } from '../src/transport/fileShare.js';
import { connectPersonal, makeNetwork, syncAll, tmpDir, tree } from './helpers.mjs';

const mode = (p) => fs.statSync(p).mode & 0o777;

// Invariant: an install has one identity, created on first use and the same on every later load.
test('the keypair is created on first use and reused after', async () => {
  const dataDir = tmpDir();
  const first = await loadIdentity(dataDir);
  const second = await loadIdentity(dataDir);
  assert.equal(second.fp, first.fp);
  assert.deepEqual(second.publicRaw, first.publicRaw);
  assert.equal(fs.readdirSync(path.join(dataDir, 'identity')).length, 1);
});

// Invariant: the private key is readable by its owner only, even under a loose umask or a loosened file.
test('the identity dir is 0700 and the key file 0600, tightened when found looser', async () => {
  const dataDir = tmpDir();
  await loadIdentity(dataDir);
  const dir = path.join(dataDir, 'identity');
  const file = path.join(dir, 'ed25519.pem');
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(file, 0o644);
  await loadIdentity(dataDir);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(file), 0o600);
});

// Invariant: the fingerprint is the hex sha256 of the 32-byte raw public key, so any reader can recompute it.
test('the fingerprint is the sha256 of the raw public key', async () => {
  const id = await loadIdentity(tmpDir());
  assert.equal(id.publicRaw.length, 32);
  assert.equal(id.fp, crypto.createHash('sha256').update(id.publicRaw).digest('hex'));
  assert.equal(fingerprint(id.publicRaw), id.fp);
});

// Invariant: the private key never reaches the share, in any encoding.
test('after a full flow no share file holds PEM text or the private key bytes', async () => {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const inbox = await connectPersonal(a, b);
  await a.engine.sendMessage(inbox, 'hello');
  const { id: shared } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  await b.engine.requestJoin(shared);
  await syncAll(installs);
  const files = tree(shareDir);
  assert.ok(Object.keys(files).length > 5, 'the flow wrote records');
  for (const x of installs) {
    const pem = fs.readFileSync(path.join(x.dataDir, 'identity', 'ed25519.pem'), 'utf8');
    const seed = Buffer.from(crypto.createPrivateKey(pem).export({ format: 'jwk' }).d, 'base64url');
    const needles = [Buffer.from('PRIVATE KEY'), seed, Buffer.from(seed.toString('hex')), Buffer.from(seed.toString('base64url')), Buffer.from(seed.toString('base64'))];
    for (const [name, bytes] of Object.entries(files)) {
      for (const n of needles) assert.equal(bytes.includes(n), false, `${name} leaks key material`);
    }
  }
  for (const x of installs) await x.close();
});

// Invariant: the share can never contain the data dir (and so the private key), nor sit inside it.
test('a share dir inside the data dir, or containing it, is refused', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'inner'), { recursive: true });
  await assert.rejects(validateShareDir(path.join(dataDir, 'inner'), dataDir), { code: 'SHARE_INVALID', message: /inside the data dir/ });
  await assert.rejects(validateShareDir(dataDir, dataDir), { code: 'SHARE_INVALID' });
  await assert.rejects(validateShareDir(root, dataDir), { code: 'SHARE_INVALID', message: /contains the data dir/ });
  const link = path.join(tmpDir(), 'via-link');
  fs.symlinkSync(path.join(dataDir, 'inner'), link);
  await assert.rejects(validateShareDir(link, dataDir), { code: 'SHARE_INVALID', message: /inside the data dir/ }, 'compared by realpath');
});

// Invariant: only an absolute, existing, writable directory is accepted as the share.
test('a relative, missing or non-directory share dir is refused', async () => {
  const dataDir = tmpDir();
  const share = tmpDir();
  await assert.rejects(validateShareDir('relative/share', dataDir), { code: 'SHARE_INVALID' });
  await assert.rejects(validateShareDir(path.join(share, 'missing'), dataDir), { code: 'SHARE_INVALID' });
  fs.writeFileSync(path.join(share, 'file'), '');
  await assert.rejects(validateShareDir(path.join(share, 'file'), dataDir), { code: 'SHARE_INVALID' });
  assert.equal(await validateShareDir(share, dataDir), share);
  assert.deepEqual(fs.readdirSync(share), ['file'], 'the writability probe leaves nothing behind');
});
