import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity } from '../src/identity.js';
import { encodeRecord } from '../src/records.js';
import { FILE_RE, SHARE_ROOT, checkShareDirPath, checkStoredShareDir, createFileShare, validateShareDir } from '../src/transport/fileShare.js';
import { makeInstall, makeNetwork, syncAll, tmpDir, tree } from './helpers.mjs';

const TS = 1_700_000_000_000;
const announceOf = (id, name) => encodeRecord(id, { type: 'announce', signer: id.fp, ts: TS, name, addr: [] }).bytes;

// A transport over a fresh share whose sink records every offer and answers `answer(incoming)` (default: done).
async function recordingShare({ answer = () => ({ retry: false }) } = {}) {
  const shareDir = tmpDir('code-inbox-share-');
  const me = await loadIdentity(tmpDir());
  const offers = [];
  fs.mkdirSync(path.join(shareDir, SHARE_ROOT), { recursive: true }); // a saved share holds its root
  const t = createFileShare({ shareDir, dataDir: tmpDir('code-inbox-data-'), selfFp: me.fp, pollMs: 3_600_000 });
  t.setInterest([{ kind: 'directory' }]);
  await t.start({ record: async (i) => { offers.push(i); return answer(i); }, peerOnline() {} });
  await t.sync(); // drains the scan start() launched, so it cannot race files the test writes next
  return { shareDir, me, t, offers, root: path.join(shareDir, SHARE_ROOT) };
}

// Invariant: a writer writes only below its own fingerprint subdir, under the record filename pattern, by
// tmp+rename (no tmp left behind) and never over an existing file.
test('writes land only under the writer subdir, by tmp+rename, never overwriting', async () => {
  const { shareDir, me, t } = await recordingShare();
  const bytes = announceOf(me, 'alice');
  const inbox = 'a'.repeat(32);
  await t.send(bytes, { route: { kind: 'directory' }, to: [] });
  await t.send(bytes, { route: { kind: 'directory' }, to: [] });
  await t.send(bytes, { route: { kind: 'inbox', id: inbox }, to: [] });
  const files = tree(shareDir);
  const names = Object.keys(files);
  assert.equal(names.length, 3, 'the same bytes sent twice make two files');
  for (const name of names) {
    const parts = name.split(path.sep);
    assert.deepEqual(parts.slice(0, 2), SHARE_ROOT.split(path.sep));
    assert.equal(parts.at(-2), me.fp, `${name} is under the writer subdir`);
    assert.match(parts.at(-1), FILE_RE);
    assert.ok(files[name].equals(bytes));
  }
  assert.equal(names.filter((n) => n.includes(`inboxes${path.sep}${inbox}${path.sep}`)).length, 1);
  await t.stop();
});

// Invariant: tmp files and sync-client conflict copies are never offered.
test('.tmp-* files and conflict copies are ignored', async () => {
  const { me, t, offers, root } = await recordingShare();
  const dir = path.join(root, 'directory', me.fp);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = announceOf(me, 'alice');
  fs.writeFileSync(path.join(dir, '.tmp-0123456789abcdef0123456789abcdef'), bytes);
  fs.writeFileSync(path.join(dir, `${'1'.repeat(13)}-${'a'.repeat(32)} (conflicted copy).rec`), bytes);
  fs.writeFileSync(path.join(dir, `${'1'.repeat(13)}-${'a'.repeat(32)}.rec.sync-conflict`), bytes);
  fs.mkdirSync(path.join(root, 'directory', 'not-a-fingerprint'));
  fs.writeFileSync(path.join(root, 'directory', 'not-a-fingerprint', `${'1'.repeat(13)}-${'b'.repeat(32)}.rec`), bytes);
  await t.sync();
  assert.deepEqual(offers, []);
  fs.writeFileSync(path.join(dir, `${'1'.repeat(13)}-${'c'.repeat(32)}.rec`), bytes);
  await t.sync();
  assert.equal(offers.length, 1);
  assert.equal(offers[0].writer, me.fp);
  await t.stop();
});

// Invariant: a file is offered once when handled for good, again only after a retry answer and a change on disk.
test('a file answered retry is re-offered only once it changes; one answered done never again', async () => {
  let retry = true;
  const { me, t, offers, root } = await recordingShare({ answer: () => ({ retry }) });
  const dir = path.join(root, 'directory', me.fp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${'1'.repeat(13)}-${'d'.repeat(32)}.rec`);
  fs.writeFileSync(file, 'partial');
  await t.sync();
  await t.sync();
  assert.equal(offers.length, 1, 'unchanged: not re-read');
  fs.writeFileSync(file, 'partial, now longer');
  retry = false;
  await t.sync();
  await t.sync();
  assert.equal(offers.length, 2);
  await t.stop();
});

// Invariant: a torn (half-synced) record is retried and accepted once complete, end to end through the engine.
test('a torn record is retried and accepted once the file is complete', async () => {
  const shareDir = tmpDir('code-inbox-share-');
  const a = await makeInstall(shareDir, { name: 'alice' });
  const bob = await loadIdentity(tmpDir());
  const bytes = announceOf(bob, 'bob');
  const dir = path.join(shareDir, SHARE_ROOT, 'directory', bob.fp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${'1'.repeat(13)}-${'e'.repeat(32)}.rec`);
  fs.writeFileSync(file, bytes.subarray(0, 40));
  await a.engine.sync();
  assert.deepEqual(a.engine.state().directory, []);
  assert.equal(a.engine.state().diagnostics.rejected, 0, 'an incomplete file is not a rejection');
  fs.writeFileSync(file, bytes);
  await a.engine.sync();
  assert.deepEqual(a.engine.state().directory.map((d) => d.name), ['bob']);
  await a.close();
});

// Invariant: a record is accepted only from its signer's own subdir and on the route its type belongs to.
test('a record in another writer subdir or on the wrong route is rejected: ROUTE_MISMATCH', async () => {
  const { shareDir, installs } = await makeNetwork(['alice']);
  const [a] = installs;
  const bob = await loadIdentity(tmpDir());
  const carol = await loadIdentity(tmpDir());
  const bytes = announceOf(bob, 'bob');
  const put = (...parts) => {
    const dir = path.join(shareDir, SHARE_ROOT, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${'1'.repeat(13)}-${'f'.repeat(32)}.rec`), bytes);
  };
  put('directory', carol.fp); // bob's record in carol's subdir
  put('mailbox', a.fp, bob.fp); // an announce on a mailbox route
  await syncAll(installs);
  const diag = a.engine.state().diagnostics;
  assert.equal(diag.rejected, 2);
  assert.deepEqual(diag.recent.map((r) => r.reason), ['ROUTE_MISMATCH', 'ROUTE_MISMATCH']);
  assert.deepEqual(a.engine.state().directory, []);
  await a.close();
});

// Signs any payload as `id`, bypassing encodeRecord's schema check (what a hostile peer can do).
function forgeAny(id, payload) {
  const pb = Buffer.from(JSON.stringify(payload));
  const sig = id.sign(Buffer.concat([Buffer.from('code-inbox/v1\0'), pb]));
  return Buffer.from(JSON.stringify({ v: 1, key: id.publicRaw.toString('base64url'), payload: pb.toString('base64url'), sig: sig.toString('base64url') }));
}

// Invariant: a malformed record is counted and skipped; it never stalls the valid records after it on its route.
test('a poison record is counted and the valid records after it still arrive', async () => {
  const { shareDir, installs } = await makeNetwork(['alice']);
  const [a] = installs;
  const bob = await loadIdentity(tmpDir());
  const dir = path.join(shareDir, SHARE_ROOT, 'directory', bob.fp);
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, type] of ['constructor', '__proto__'].entries()) {
    fs.writeFileSync(path.join(dir, `${'0'.repeat(13)}-${String(i).padStart(32, '0')}.rec`), forgeAny(bob, { type, signer: bob.fp, ts: TS }));
  }
  fs.writeFileSync(path.join(dir, `${'9'.repeat(13)}-${'a'.repeat(32)}.rec`), announceOf(bob, 'bob'));
  await a.engine.sync();
  const diag = a.engine.state().diagnostics;
  assert.equal(diag.rejected, 2);
  assert.deepEqual(diag.recent.map((r) => r.reason), ['BAD_PAYLOAD', 'BAD_PAYLOAD']);
  assert.deepEqual(a.engine.state().directory.map((d) => d.name), ['bob']);
  await a.engine.sync();
  assert.equal(a.engine.state().diagnostics.rejected, 2, 'counted once, not every poll');
  await a.close();
});

// Invariant: a sink failure on one file is that file's alone: the rest of the route is still offered, and the
// failed file is offered again on the next scan.
test('a file whose offer throws does not stop the scan, and is retried', async () => {
  let failFirst = true;
  const { me, t, offers, root } = await recordingShare({
    answer: (i) => { if (failFirst && i.bytes.toString() === 'first') { failFirst = false; throw new Error('boom'); } return { retry: false }; },
  });
  const dir = path.join(root, 'directory', me.fp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${'1'.repeat(13)}-${'1'.repeat(32)}.rec`), 'first');
  fs.writeFileSync(path.join(dir, `${'2'.repeat(13)}-${'2'.repeat(32)}.rec`), 'second');
  await t.sync();
  assert.deepEqual(offers.map((o) => o.bytes.toString()), ['first', 'second']);
  await t.sync();
  assert.deepEqual(offers.map((o) => o.bytes.toString()), ['first', 'second', 'first']);
  await t.stop();
});

// Invariant: a peer cannot redirect this install's writes by swapping its writer subdir for a symlink.
test('a writer subdir replaced by a symlink is refused, and nothing is written through it', async () => {
  const { me, t, root } = await recordingShare();
  const outside = tmpDir('code-inbox-outside-');
  fs.mkdirSync(path.join(root, 'directory'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'directory', me.fp));
  await assert.rejects(t.send(announceOf(me, 'alice'), { route: { kind: 'directory' }, to: [] }), { code: 'SHARE_UNSAFE' });
  assert.deepEqual(fs.readdirSync(outside), []);
  await t.stop();
});

// Invariant: records are read only from real files inside the share: a .rec symlink, or a writer subdir that is a
// symlink, pointing out of the share is never read.
test('symlinked record files and writer subdirs are not read', async () => {
  const { me, t, offers, root } = await recordingShare();
  const other = await loadIdentity(tmpDir());
  const outside = tmpDir('code-inbox-outside-');
  const target = path.join(outside, `${'1'.repeat(13)}-${'f'.repeat(32)}.rec`);
  fs.writeFileSync(target, announceOf(me, 'alice'));
  const dir = path.join(root, 'directory', me.fp);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, `${'1'.repeat(13)}-${'e'.repeat(32)}.rec`));
  fs.symlinkSync(outside, path.join(root, 'directory', other.fp));
  await t.sync();
  assert.deepEqual(offers, []);
  await t.stop();
});

// Invariant: only a `..` path component leaves a directory: a share named `..share` inside the data dir, or a data
// dir named `..data` inside the share, is an overlap like any other.
test('a dotted name does not defeat the share/data dir overlap check', async () => {
  const dataDir = tmpDir('code-inbox-data-');
  const inside = path.join(dataDir, '..share');
  fs.mkdirSync(inside);
  const base = tmpDir('code-inbox-base-');
  const dottedData = path.join(base, '..data');
  fs.mkdirSync(dottedData);
  for (const [dir, data] of [[inside, dataDir], [base, dottedData]]) {
    assert.throws(() => checkShareDirPath(dir, data), { code: 'SHARE_INVALID' }, dir);
    await assert.rejects(checkStoredShareDir(dir, data), { code: 'SHARE_INVALID' }, dir);
    await assert.rejects(validateShareDir(dir, data), { code: 'SHARE_INVALID' }, dir);
  }
  // A sibling whose name merely starts with dots is not an overlap.
  const sibling = path.join(base, '..share');
  fs.mkdirSync(sibling);
  assert.equal(await validateShareDir(sibling, dottedData), sibling);
});

// Invariant (T7): a route that would leave the share is refused before anything is created.
test('a send on a route that leaves the share creates nothing and is refused SHARE_UNSAFE', async () => {
  const { shareDir, me, t, root } = await recordingShare();
  for (const route of [{ kind: 'inbox', id: '../../../../escape' }, { kind: 'mailbox', fp: '../../../escape2' }]) {
    await assert.rejects(t.send(announceOf(me, 'alice'), { route, to: [] }), { code: 'SHARE_UNSAFE' });
  }
  for (const name of ['escape', 'escape2']) {
    assert.equal(fs.existsSync(path.join(path.dirname(shareDir), name)), false);
    assert.equal(fs.existsSync(path.join(shareDir, name)), false);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  await t.stop();
});
