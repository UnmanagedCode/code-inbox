import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity } from '../src/identity.js';
import { encodeRecord } from '../src/records.js';
import { FILE_RE, SHARE_ROOT, createFileShare } from '../src/transport/fileShare.js';
import { makeInstall, makeNetwork, syncAll, tmpDir, tree } from './helpers.mjs';

const TS = 1_700_000_000_000;
const announceOf = (id, name) => encodeRecord(id, { type: 'announce', signer: id.fp, ts: TS, name, addr: [] }).bytes;

// A transport over a fresh share whose sink records every offer and answers `answer(incoming)` (default: done).
async function recordingShare({ answer = () => ({ retry: false }) } = {}) {
  const shareDir = tmpDir('code-inbox-share-');
  const me = await loadIdentity(tmpDir());
  const offers = [];
  const t = createFileShare({ shareDir, selfFp: me.fp, pollMs: 3_600_000 });
  t.setInterest([{ kind: 'directory' }]);
  await t.start({ record: async (i) => { offers.push(i); return answer(i); }, peerOnline() {} });
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
